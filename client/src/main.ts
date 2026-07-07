import * as THREE from 'three';
import {
  VoxelWorld,
  generateMap,
  stepPlayer,
  raycastVoxel,
  Msg,
  TICK_MS,
  REACH,
  PLAYER_EYE,
  BlockType,
  TEAMS,
  type MoveInput,
  type PlayerPhysics,
  type BlockDiff,
  type WorldInit,
} from '@bedwars/shared';
import { createAtlas } from './atlas';
import { WorldRenderer } from './worldRenderer';
import { Input } from './input';
import { RemotePlayers } from './remotePlayers';
import { connect } from './net';

const app = document.getElementById('app')!;
const overlay = document.getElementById('overlay')!;
const hotbarEl = document.getElementById('hotbar')!;

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 80, 220);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 400);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// Deterministic base map: generated locally, identical to the server's copy.
const world = new VoxelWorld();
generateMap(world);
const atlas = createAtlas();
const worldRenderer = new WorldRenderer(scene, world, atlas);
worldRenderer.markAllDirty();
worldRenderer.update(Infinity); // full build once at load

// Block selection highlight (single reused object)
const sel = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000 }),
);
sel.visible = false;
scene.add(sel);

const input = new Input(renderer.domElement, overlay);
const remotes = new RemotePlayers(scene);

const HOTBAR: { block: BlockType; label: string }[] = [
  { block: BlockType.WoolRed, label: 'Wool' },
  { block: BlockType.Plank, label: 'Plank' },
  { block: BlockType.Stone, label: 'Stone' },
];
let activeSlot = 0;
function renderHotbar(): void {
  hotbarEl.innerHTML = HOTBAR
    .map((s, i) => `<div class=\"slot${i === activeSlot ? ' active' : ''}\"><span>${i + 1}</span><span>${s.label}</span></div>`)
    .join('');
}
renderHotbar();
input.onHotbar = (i) => {
  if (i < HOTBAR.length) {
    activeSlot = i;
    renderHotbar();
  }
};

const rayDir = new THREE.Vector3();

async function start(): Promise<void> {
  const room = await connect();
  const myId = room.sessionId;

  room.onMessage(Msg.WorldInit, (m: WorldInit) => {
    for (const d of m.diffs) worldRenderer.setBlock(d.x, d.y, d.z, d.b);
  });
  room.onMessage(Msg.BlockDiff, (d: BlockDiff) => worldRenderer.setBlock(d.x, d.y, d.z, d.b));

  // Local prediction state
  const phys: PlayerPhysics = { x: 0, y: 30, z: 0, vy: 0, onGround: false };
  let seq = 1;
  let lastReconciled = 0;
  let spawned = false;
  const pending: MoveInput[] = [];
  let batch: MoveInput[] = [];
  let sendTimer = 0;

  room.state.players.onAdd((p: any, id: string) => {
    if (id === myId) {
      phys.x = p.x;
      phys.y = p.y;
      phys.z = p.z;
      spawned = true;
      HOTBAR[0].block = TEAMS[p.team].wool; // your wool matches your team
      renderHotbar();
    } else {
      remotes.add(id, p.team);
    }
  });
  room.state.players.onRemove((_p: any, id: string) => {
    if (id !== myId) remotes.remove(id);
  });

  input.onMouseDown = (button) => {
    camera.getWorldDirection(rayDir);
    const hit = raycastVoxel(camera.position.x, camera.position.y, camera.position.z, rayDir.x, rayDir.y, rayDir.z, REACH, world.isSolid);
    if (!hit) return;
    // Server-authoritative: blocks change only when the BlockDiff comes back.
    if (button === 0) {
      room.send(Msg.Break, { x: hit.x, y: hit.y, z: hit.z });
    } else if (button === 2) {
      room.send(Msg.Place, { x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz, block: HOTBAR[activeSlot].block });
    }
  };

  let last = performance.now();
  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (spawned) {
      // Predict locally every frame; batch inputs to the server at 20Hz.
      const move: MoveInput = {
        seq: seq++,
        dt,
        moveX: input.locked ? input.moveX : 0,
        moveZ: input.locked ? input.moveZ : 0,
        jump: input.locked && input.jump,
        yaw: input.yaw,
      };
      stepPlayer(phys, move, world.isSolid);
      pending.push(move);
      batch.push(move);
      if (pending.length > 120) pending.splice(0, pending.length - 120);

      sendTimer += dt * 1000;
      if (sendTimer >= TICK_MS && batch.length > 0) {
        room.send(Msg.Input, batch);
        batch = [];
        sendTimer = 0;
      }

      // Reconciliation: rewind to server-acked state, replay unacked inputs.
      const me: any = room.state.players.get(myId);
      if (me && me.lastSeq > lastReconciled) {
        lastReconciled = me.lastSeq;
        phys.x = me.x;
        phys.y = me.y;
        phys.z = me.z;
        phys.vy = me.vy;
        while (pending.length > 0 && pending[0].seq <= me.lastSeq) pending.shift();
        for (const m of pending) stepPlayer(phys, m, world.isSolid);
      }
    }

    room.state.players.forEach((p: any, id: string) => {
      if (id !== myId) remotes.updateTarget(id, p.x, p.y, p.z);
    });
    remotes.update(dt);

    camera.position.set(phys.x, phys.y + PLAYER_EYE, phys.z);
    camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ');

    camera.getWorldDirection(rayDir);
    const hit = raycastVoxel(camera.position.x, camera.position.y, camera.position.z, rayDir.x, rayDir.y, rayDir.z, REACH, world.isSolid);
    if (hit) {
      sel.visible = true;
      sel.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      sel.visible = false;
    }

    worldRenderer.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

start().catch((err) => {
  overlay.textContent = `Failed to connect: ${err?.message ?? err}. Is the server running? (npm run dev:server)`;
  console.error(err);
});
