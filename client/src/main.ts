import * as THREE from 'three';
import {
  VoxelWorld,
  generateMap,
  stepPlayer,
  raycastVoxel,
  Msg,
  BLOCKS,
  TICK_MS,
  REACH,
  PLAYER_EYE,
  PLAYER_HALF_W,
  PLAYER_HEIGHT,
  RESPAWN_SECONDS,
  BlockType,
  TEAMS,
  type MoveInput,
  type PlayerPhysics,
  type BlockDiff,
  type WorldInit,
  type FeedMessage,
} from '@bedwars/shared';
import type { Room } from 'colyseus.js';
import { createAtlas } from './atlas';
import { WorldRenderer } from './worldRenderer';
import { Input } from './input';
import { RemotePlayers } from './remotePlayers';
import { connect } from './net';
import { HUD } from './ui';

const app = document.getElementById('app')!;
const overlay = document.getElementById('overlay')!;
const hotbarEl = document.getElementById('hotbar')!;

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7fb8e8);
scene.fog = new THREE.Fog(0x7fb8e8, 90, 240);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 400);
scene.add(camera); // required so the held-block child renders

// Lighting: bright arcade daylight.
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f6a, 0.9));
const sun = new THREE.DirectionalLight(0xfff3d6, 1.1);
sun.position.set(0.6, 1, 0.4);
scene.add(sun);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// Deterministic base map: generated locally, identical to the server's copy.
const world = new VoxelWorld();
const spawns = generateMap(world);
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

// Ghost preview of the block about to be placed (single reused object)
const ghostMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMat);
ghost.visible = false;
scene.add(ghost);

// Held block in the bottom-right of the view, swings on click.
const heldMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const held = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), heldMat);
held.position.set(0.38, -0.32, -0.6);
held.rotation.set(0.2, 0.6, 0);
camera.add(held);
let swingT = 0;

const input = new Input(renderer.domElement, overlay);
const remotes = new RemotePlayers(scene);
const hud = new HUD();

const DEBUG = new URLSearchParams(location.search).has('debug');
if (DEBUG) {
  document.addEventListener('pointerlockchange', () => {
    console.log('[debug] pointerLock engaged:', document.pointerLockElement === renderer.domElement);
  });
}

// --- Hotbar ---
let HOTBAR: { block: BlockType; label: string }[] = [];
let activeSlot = 0;
function setHotbarForTeam(team: number): void {
  HOTBAR = [
    { block: TEAMS[team].wool, label: 'Wool' },
    { block: BlockType.Plank, label: 'Plank' },
    { block: BlockType.EndStone, label: 'End Stone' },
    { block: BlockType.Stone, label: 'Stone' },
  ];
  renderHotbar();
}
function renderHotbar(): void {
  hotbarEl.innerHTML = HOTBAR
    .map((s, i) => {
      const hex = `#${BLOCKS[s.block].color.toString(16).padStart(6, '0')}`;
      return `<div class="slot${i === activeSlot ? ' active' : ''}"><div class="swatch" style="background:${hex}"></div>${i + 1} ${s.label}</div>`;
    })
    .join('');
  heldMat.color.setHex(BLOCKS[HOTBAR[activeSlot].block].color);
}
setHotbarForTeam(0);
input.onHotbar = (i) => {
  if (i < HOTBAR.length) {
    activeSlot = i;
    renderHotbar();
  }
};

// --- Stats ---
let frames = 0;
let fps = 0;
let fpsTimer = 0;
let ping: number | null = null;
const clicks: number[] = [];

const rayDir = new THREE.Vector3();

async function start(): Promise<void> {
  let room: Room | null = null;
  try {
    room = await connect();
  } catch (err) {
    console.warn('[bedwars] offline mode:', err);
  }
  const myId = room?.sessionId ?? 'local';

  // Local prediction / player state
  const phys: PlayerPhysics = { x: 0, y: 30, z: 0, vy: 0, onGround: false };
  let myTeam = 0;
  let seq = 1;
  let lastReconciled = 0;
  let spawned = false;
  let prevAlive = true;
  let deadSince = 0;
  const pending: MoveInput[] = [];
  let batch: MoveInput[] = [];
  let sendTimer = 0;
  let boardTimer = 0;
  let bobT = 0;

  function localSpawn(team: number): void {
    const s = spawns[team];
    phys.x = s.x;
    phys.y = s.y;
    phys.z = s.z;
    phys.vy = 0;
    spawned = true;
    myTeam = team;
    setHotbarForTeam(team);
    if (DEBUG) console.log('[debug] spawned on team', team, 'at', s.x, s.y, s.z);
  }

  if (room) {
    room.onMessage(Msg.WorldInit, (m: WorldInit) => {
      for (const d of m.diffs) worldRenderer.setBlock(d.x, d.y, d.z, d.b);
    });
    room.onMessage(Msg.BlockDiff, (d: BlockDiff) => worldRenderer.setBlock(d.x, d.y, d.z, d.b));
    room.onMessage(Msg.Feed, (m: FeedMessage) => hud.addFeed(m.text));
    room.onMessage(Msg.Pong, (t: number) => { ping = Date.now() - t; });
    setInterval(() => room?.send(Msg.Ping, Date.now()), 2000);
  } else {
    // Offline fallback: always spawn a playable local player.
    localSpawn(0);
    hud.addFeed('Offline mode — start the server for multiplayer');
  }

  input.onMouseDown = (button) => {
    swingT = 1; // swing animation on every click
    clicks.push(Date.now());
    const me: any = (room?.state as any)?.players?.get(myId);
    const alive = room ? !!me?.alive : true;
    if (!spawned || !alive) return;
    camera.getWorldDirection(rayDir);
    const hit = raycastVoxel(camera.position.x, camera.position.y, camera.position.z, rayDir.x, rayDir.y, rayDir.z, REACH, world.isSolid);
    if (!hit) return;
    if (button === 0) {
      if (room) room.send(Msg.Break, { x: hit.x, y: hit.y, z: hit.z });
      else if (BLOCKS[world.get(hit.x, hit.y, hit.z)]?.breakable) worldRenderer.setBlock(hit.x, hit.y, hit.z, BlockType.Air);
    } else if (button === 2) {
      const gx = hit.x + hit.nx;
      const gy = hit.y + hit.ny;
      const gz = hit.z + hit.nz;
      if (room) room.send(Msg.Place, { x: gx, y: gy, z: gz, block: HOTBAR[activeSlot].block });
      else if (world.get(gx, gy, gz) === BlockType.Air) worldRenderer.setBlock(gx, gy, gz, HOTBAR[activeSlot].block);
    }
  };

  let last = performance.now();
  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // --- Sync players from server state (poll-based: version-proof) ---
    // Guarded: room.state is empty until the first patch arrives; an
    // unguarded access here threw per-frame and aborted camera + render.
    let me: any = null;
    const players = room ? (room.state as any)?.players : null;
    if (room && players) {
      const seen = new Set<string>();
      players.forEach((p: any, id: string) => {
        seen.add(id);
        if (id === myId) {
          me = p;
          if (!spawned) {
            localSpawn(p.team);
            phys.x = p.x; phys.y = p.y; phys.z = p.z;
          }
          return;
        }
        if (!remotes.has(id)) remotes.add(id, p.team);
        remotes.updateTarget(id, p.x, p.y, p.z, p.yaw, !!p.alive);
      });
      remotes.prune(seen);
    }
    const alive = room ? (me ? !!me.alive : true) : true;

    // Respawn detection: snap prediction to the server spawn.
    if (me && !prevAlive && me.alive) {
      phys.x = me.x; phys.y = me.y; phys.z = me.z; phys.vy = 0;
      pending.length = 0;
      batch = [];
    }
    if (me && prevAlive && !me.alive) deadSince = now;
    prevAlive = alive;

    // --- Movement: predict locally, batch inputs at 20Hz ---
    const sprinting = input.locked && input.sprint && input.moveZ > 0 && alive;
    if (spawned && alive) {
      const move: MoveInput = {
        seq: seq++,
        dt,
        moveX: input.locked ? input.moveX : 0,
        moveZ: input.locked ? input.moveZ : 0,
        jump: input.locked && input.jump,
        sprint: input.locked && input.sprint,
        yaw: input.yaw,
      };
      stepPlayer(phys, move, world.isSolid);
      if (room) {
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
        if (me && me.lastSeq > lastReconciled) {
          lastReconciled = me.lastSeq;
          phys.x = me.x; phys.y = me.y; phys.z = me.z; phys.vy = me.vy;
          while (pending.length > 0 && pending[0].seq <= me.lastSeq) pending.shift();
          for (const m of pending) stepPlayer(phys, m, world.isSolid);
        }
      }
    }

    remotes.update(dt);

    // --- Camera: eye height, head bob, sprint FOV ---
    const moving = input.locked && (input.moveX !== 0 || input.moveZ !== 0);
    if (phys.onGround && moving && alive) bobT += dt * (sprinting ? 11 : 8);
    const bob = phys.onGround && moving ? Math.sin(bobT) * 0.05 : 0;
    camera.position.set(phys.x, phys.y + PLAYER_EYE + bob, phys.z);
    camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ');
    const targetFov = sprinting ? 83 : 75;
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
      camera.updateProjectionMatrix();
    }

    // --- Held block swing ---
    if (swingT > 0) {
      swingT = Math.max(0, swingT - dt * 5);
      const s = Math.sin(swingT * Math.PI);
      held.rotation.x = 0.2 - s * 0.9;
      held.position.z = -0.6 - s * 0.15;
    }

    // --- Targeting: selection box + ghost preview ---
    camera.getWorldDirection(rayDir);
    const hit = alive
      ? raycastVoxel(camera.position.x, camera.position.y, camera.position.z, rayDir.x, rayDir.y, rayDir.z, REACH, world.isSolid)
      : null;
    if (hit) {
      sel.visible = true;
      sel.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      const gx = hit.x + hit.nx;
      const gy = hit.y + hit.ny;
      const gz = hit.z + hit.nz;
      const overlapsSelf =
        gx + 1 > phys.x - PLAYER_HALF_W && gx < phys.x + PLAYER_HALF_W &&
        gy + 1 > phys.y && gy < phys.y + PLAYER_HEIGHT &&
        gz + 1 > phys.z - PLAYER_HALF_W && gz < phys.z + PLAYER_HALF_W;
      if (world.get(gx, gy, gz) === BlockType.Air && !overlapsSelf) {
        ghost.visible = true;
        ghost.position.set(gx + 0.5, gy + 0.5, gz + 0.5);
        ghostMat.color.setHex(BLOCKS[HOTBAR[activeSlot].block].color);
      } else {
        ghost.visible = false;
      }
    } else {
      sel.visible = false;
      ghost.visible = false;
    }

    // --- HUD ---
    frames++;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(frames / fpsTimer);
      frames = 0;
      fpsTimer = 0;
    }
    const cutoff = Date.now() - 1000;
    while (clicks.length > 0 && clicks[0] < cutoff) clicks.shift();
    hud.setStats(fps, room ? ping : null, clicks.length);
    hud.setHearts(me ? me.hp : 20);

    boardTimer += dt;
    if (boardTimer >= 0.25) {
      boardTimer = 0;
      const counts = TEAMS.map(() => 0);
      if (players) players.forEach((p: any) => { if (p.alive) counts[p.team]++; });
      if (!room || !players) counts[myTeam] = 1;
      const bedsAlive: number = (room?.state as any)?.bedsAlive ?? 0b1111;
      hud.setScoreboard(TEAMS.map((t, i) => ({
        name: t.name,
        color: `#${t.color.toString(16).padStart(6, '0')}`,
        bed: ((bedsAlive >> i) & 1) === 1,
        players: counts[i],
        you: i === myTeam,
      })));
    }

    // --- Status overlays ---
    const winner: number = (room?.state as any)?.winner ?? -1;
    if (winner >= 0) {
      hud.setStatus(`${TEAMS[winner].name.toUpperCase()} TEAM WINS!`);
    } else if (me && !alive) {
      const bedAlive = ((((room?.state as any)?.bedsAlive ?? 0b1111) >> me.team) & 1) === 1;
      if (bedAlive) {
        const left = Math.max(0, Math.ceil(RESPAWN_SECONDS - (now - deadSince) / 1000));
        hud.setStatus(`You died! Respawning in ${left}...`);
      } else {
        hud.setStatus('ELIMINATED — your bed was destroyed');
      }
    } else {
      hud.setStatus('');
    }

    if (DEBUG) {
      camera.getWorldDirection(rayDir);
      console.log(
        `[debug] player(${phys.x.toFixed(2)}, ${phys.y.toFixed(2)}, ${phys.z.toFixed(2)})` +
        ` cam(${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})` +
        ` dir(${rayDir.x.toFixed(2)}, ${rayDir.y.toFixed(2)}, ${rayDir.z.toFixed(2)})` +
        ` spawned=${spawned} locked=${input.locked}`,
      );
    }

    worldRenderer.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

start();
