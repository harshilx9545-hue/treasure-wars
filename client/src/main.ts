import './menu-theme.css';
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
  ATTACK_REACH,
  PLAYER_EYE,
  PLAYER_HALF_W,
  PLAYER_HEIGHT,
  RESPAWN_SECONDS,
  VOID_Y,
  WORLD_X,
  WORLD_Z,
  BlockType,
  TEAMS,
  POWERUPS,
  ALL_POWERUPS,
  PowerUp,
  ECONOMY,
  WEAPONS,
  WeaponId,
  isBed,
  type MoveInput,
  type PlayerPhysics,
  type StepMods,
  type BlockDiff,
  type WorldInit,
  type FeedMessage,
  type HitEvent,
  type BedDestroyedEvent,
  type NoticeMessage,
  type ExplosionEvent,
  type TeleportEvent,
} from '@bedwars/shared';
import type { Room } from 'colyseus.js';
import { createAtlas } from './atlas';
import { WorldRenderer } from './worldRenderer';
import { Input } from './input';
import { RemotePlayers } from './remotePlayers';
import { HUD, type PowerUpView } from './ui';
import { settings } from './settings';
import { audio } from './audio';
import { Menu } from './menu';
import { Particles } from './particles';
import { Mining } from './mining';
import { ViewModel } from './viewModel';
import { initGraphics } from './graphics';
import { Lobby } from './lobby';
import { Shop } from './shop';
import { EntityRenderer } from './entities';
import { Treasure } from './treasure';
import { EndScreen } from './endscreen';
import { Objective } from './objective';
import { Environment } from './environment';

const app = document.getElementById('app')!;
const hotbarEl = document.getElementById('hotbar')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.get().fov, innerWidth / innerHeight, 0.1, 400);
scene.add(camera);

const graphics = initGraphics(renderer, scene, camera);
graphics.applyRenderDistance(settings.get().renderDistance);
settings.subscribe((s) => graphics.applyRenderDistance(s.renderDistance));

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  graphics.resize(innerWidth, innerHeight);
});

const world = new VoxelWorld();
const spawns = generateMap(world);
const atlas = createAtlas();
const worldRenderer = new WorldRenderer(scene, world, atlas);
worldRenderer.markAllDirty();
worldRenderer.update(Infinity);

// Treasure chests replace the beds visually (gameplay logic unchanged).
let treasure = new Treasure(scene, world);

// Pirate-arena decoration (client-only, non-collidable): ocean, FBX trees,
// crates, barrels, torches, cannons, flags, ships, statues, rope bridges. The
// layout is deterministic, so it stays valid across rematches (same world).
const environment = new Environment(scene, world, spawns);

/** Rebuild the base world + treasures for a rematch (server sends WorldReset). */
function resetLocalWorld(): void {
  world.data.fill(0);
  generateMap(world);
  worldRenderer.markAllDirty();
  worldRenderer.update(Infinity);
  treasure.dispose();
  treasure = new Treasure(scene, world);
}

// Selection + ghost preview
const sel = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000 }),
);
sel.visible = false;
scene.add(sel);
const ghostMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMat);
ghost.visible = false;
scene.add(ghost);

const input = new Input(renderer.domElement);
const remotes = new RemotePlayers(scene);
const hud = new HUD();
const particles = new Particles(scene);
const mining = new Mining(scene);
const viewModel = new ViewModel(camera);
const menu = new Menu();
const entities = new EntityRenderer(scene);
const shop = new Shop();
const endScreen = new EndScreen();
const objective = new Objective();
endScreen.onPlayAgain = () => { playAgainRequested = true; room?.send(Msg.Rematch, {}); };
endScreen.onReturnLobby = () => { playAgainRequested = false; room?.send(Msg.Rematch, {}); };

// Lobby overview camera framing (backdrop before the match starts).
const CENTER = new THREE.Vector3(WORLD_X / 2, 40, WORLD_Z / 2);
camera.position.set(CENTER.x + 40, 46, CENTER.z + 40);
camera.lookAt(CENTER.x, 22, CENTER.z);

// (Removed the floating shop beacon/indicator — the "Press E to open Shop" hint
// and proximity trigger are enough; the glowing marker was distracting.)

// ------- Session state -------
let room: Room | null = null;
let offline = false;
let started = false;
let handlersAttached = false;
let musicStarted = false;
let myId = 'local';

const phys: PlayerPhysics = { x: 0, y: 30, z: 0, vx: 0, vz: 0, vy: 0, onGround: false };
let myTeam = 0;
let seq = 1;
let lastReconciled = 0;
let spawned = false;
let prevAlive = true;
let prevOnGround = true;
let prevHp = 20;
let prevCoins = -1;
let prevWinner = -1;
let endShown = false;
let playAgainRequested = false;
let deadSince = 0;
let landDip = 0;
let stepTimer = 0;
let shake = 0;
let offlineDead = false;
let offlineDeadUntil = 0;
let placeCooldown = 0;
const PLACE_COOLDOWN = 0.16; // seconds between placements while holding RMB (Minecraft-like)
let blocking = false; // shield raised
const pending: MoveInput[] = [];
let batch: MoveInput[] = [];
let sendTimer = 0;
let boardTimer = 0;
let bobT = 0;

let ping: number | null = null;
const clicks: number[] = [];
let frames = 0;
let fps = 0;
let fpsTimer = 0;

const rayDir = new THREE.Vector3();

const powerCooldownUntil = new Map<number, number>();
const localEffects = new Map<number, number>();

// Offline/practice economy — a local mirror of a player + team so the shop,
// coins, inventory and purchases all function without a server.
const localMe: any = {
  team: 0, alive: true, hp: 20,
  coins: 0, coinsEarned: 0,
  wool: 0, plank: 0, stone: 0,
  swordTier: 0, pickTier: 0, shears: false,
  tnt: 0, pearls: 0, fireballs: 0, alarms: 0,
  weapon: WeaponId.IronSword, weapons: 1 << WeaponId.IronSword, blocking: false,
  effects: new Map<string, number>(),
};
const localTeam = { armorTier: 0, genLevel: 0 };
let coinAcc = 0;

// ------- Hotbar (owned weapons + blocks + utility) -------
interface Slot {
  kind: 'weapon' | 'block' | 'util';
  label: string;
  weapon?: WeaponId;
  block?: BlockType;
  invField?: 'wool' | 'plank' | 'stone';
  util?: 'tnt' | 'pearl' | 'fireball' | 'alarm';
  color?: number;
}
const UTIL_COUNT: Record<string, string> = { tnt: 'tnt', pearl: 'pearls', fireball: 'fireballs', alarm: 'alarms' };
let HOTBAR: Slot[] = [];
let activeSlot = 0;
let hotbarSig = '';
let hotbarOwnedSig = '';
let lastEquippedWeapon = -1;

function getMe(): any {
  if (offline) return started ? localMe : null;
  return room ? (room.state as any)?.players?.get(myId) : null;
}

function myTeamNow(me: any): number {
  return me?.team ?? myTeam;
}

/** Rebuild the hotbar layout when the owned-weapon set / team changes. */
function rebuildHotbar(me: any): void {
  const owned = me?.weapons ?? (1 << WeaponId.IronSword);
  const team = myTeamNow(me);
  const sig = `${owned}#${team}`;
  if (sig === hotbarOwnedSig) return;
  hotbarOwnedSig = sig;

  const slots: Slot[] = [];
  for (const def of Object.values(WEAPONS)) {
    if ((owned >> def.id) & 1) slots.push({ kind: 'weapon', label: def.name, weapon: def.id, color: def.color });
  }
  slots.push({ kind: 'block', label: 'Wool', block: TEAMS[team].wool, invField: 'wool' });
  slots.push({ kind: 'block', label: 'Plank', block: BlockType.Plank, invField: 'plank' });
  slots.push({ kind: 'block', label: 'Stone', block: BlockType.Stone, invField: 'stone' });
  slots.push({ kind: 'util', label: 'TNT', util: 'tnt', color: 0xd23b2b });
  slots.push({ kind: 'util', label: 'Pearl', util: 'pearl', color: 0x1fe0a0 });
  slots.push({ kind: 'util', label: 'Fireball', util: 'fireball', color: 0xff7a1a });
  slots.push({ kind: 'util', label: 'Alarm', util: 'alarm', color: 0xffd23f });
  HOTBAR = slots.slice(0, 9);
  if (activeSlot >= HOTBAR.length) activeSlot = 0;
  hotbarSig = '';
}

function slotCount(slot: Slot, me: any): number {
  if (slot.kind === 'weapon') return -1;
  if (slot.kind === 'block') return me ? (me[slot.invField!] ?? 0) : 0;
  return me ? (me[UTIL_COUNT[slot.util!]] ?? 0) : 0;
}

function renderHotbar(me: any): void {
  rebuildHotbar(me);
  const sig = HOTBAR.map((s, i) => `${i === activeSlot ? '*' : ''}${slotCount(s, me)}`).join('|');
  if (sig === hotbarSig) return;
  hotbarSig = sig;
  hotbarEl.innerHTML = HOTBAR.map((s, i) => {
    let swatch: string;
    let count = '';
    if (s.kind === 'weapon') {
      swatch = `<div class="swatch" style="background:#${(s.color ?? 0xcccccc).toString(16).padStart(6, '0')}">\u2694</div>`;
    } else if (s.kind === 'block') {
      swatch = `<div class="swatch" style="background:#${BLOCKS[s.block!].color.toString(16).padStart(6, '0')}"></div>`;
      const c = slotCount(s, me);
      count = c === Infinity ? '' : `<span class="slot-count">${c}</span>`;
    } else {
      swatch = `<div class="swatch" style="background:#${(s.color ?? 0x888888).toString(16).padStart(6, '0')}"></div>`;
      count = `<span class="slot-count">${slotCount(s, me)}</span>`;
    }
    const empty = (s.kind === 'block' || s.kind === 'util') && slotCount(s, me) <= 0 ? ' empty' : '';
    return `<div class="slot${i === activeSlot ? ' active' : ''}${empty}">${swatch}<span class="slot-num">${i + 1}</span>${count}<span class="slot-label">${s.label}</span></div>`;
  }).join('');
  applyActiveItemVisual(me);
}

/** Update the first-person view model to match the active slot. */
function applyActiveItemVisual(me: any): void {
  const s = HOTBAR[activeSlot];
  if (!s) return;
  if (s.kind === 'weapon') viewModel.setWeapon(s.weapon!);
  else if (s.kind === 'block') viewModel.setBlock(BLOCKS[s.block!].color);
  else viewModel.setBlock(s.color ?? 0x888888);
}

/** User selected a hotbar slot: equip weapon (synced) or hold block/utility. */
function selectSlot(i: number): void {
  if (i >= HOTBAR.length || i === activeSlot) return;
  activeSlot = i;
  const s = HOTBAR[i];
  if (s.kind === 'weapon' && s.weapon !== undefined) {
    if (room) room.send(Msg.Weapon, { weapon: s.weapon });
    else localMe.weapon = s.weapon;
    lastEquippedWeapon = s.weapon;
    // dropping a raised shield when switching away
    if (blocking && s.weapon !== WeaponId.Shield) setBlocking(false);
  }
  audio.play('click');
  hotbarSig = '';
  renderHotbar(getMe());
}

/** React to the server auto-equipping a weapon (e.g., after a purchase). */
function equipWeaponVisual(weaponId: number): void {
  const idx = HOTBAR.findIndex((s) => s.kind === 'weapon' && s.weapon === weaponId);
  if (idx >= 0) { activeSlot = idx; hotbarSig = ''; renderHotbar(getMe()); }
}

setActiveWeaponDefault();
function setActiveWeaponDefault(): void {
  rebuildHotbar(getMe());
  applyActiveItemVisual(getMe());
}

input.onHotbar = (i) => selectSlot(i);

// ------- Power-ups -------
function currentEffects(now: number): Map<number, number> {
  const out = new Map<number, number>();
  if (offline) {
    for (const [k, exp] of [...localEffects]) { if (exp <= now) localEffects.delete(k); else out.set(k, exp); }
    return out;
  }
  const me = getMe();
  if (me?.effects) me.effects.forEach((exp: number, key: string) => { if (exp > now) out.set(Number(key), exp); });
  return out;
}
function currentMods(now: number): StepMods & { hasteMult: number } {
  const eff = currentEffects(now);
  let speedMult = 1, jumpMult = 1, hasteMult = 1;
  eff.forEach((_e, type) => {
    const def = POWERUPS[type as PowerUp];
    if (!def) return;
    speedMult *= def.speedMult; jumpMult *= def.jumpMult; hasteMult *= def.hasteMult;
  });
  return { speedMult, jumpMult, hasteMult };
}

function localSpawn(team: number): void {
  const s = spawns[team];
  phys.x = s.x; phys.y = s.y; phys.z = s.z;
  phys.vx = 0; phys.vz = 0; phys.vy = 0;
  spawned = true;
  myTeam = team;
  hotbarOwnedSig = ''; // team changed -> rebuild hotbar (wool color)
  rebuildHotbar(getMe());
}

function canPlay(): boolean {
  if (!started) return false;
  if (offline) return true;
  return ((room?.state as any)?.phase ?? 'lobby') === 'playing';
}

function setBlocking(on: boolean): void {
  if (blocking === on) return;
  blocking = on;
  viewModel.setBlocking(on);
  if (room) room.send(Msg.Block, { blocking: on });
  else localMe.blocking = on;
}

function activeWeaponDef() {
  const s = HOTBAR[activeSlot];
  if (s && s.kind === 'weapon' && s.weapon !== undefined) return WEAPONS[s.weapon];
  return null;
}

/** Offline/practice purchase logic — mirrors the server's authoritative rules. */
function localBuy(id: string): void {
  const me = localMe;
  const team = localTeam;
  const notice = (t: string, ok: boolean) => hud.showNotice(t, ok);
  const charge = (cost: number): boolean => {
    if (me.coins < cost) { notice(`Not enough coins (need ${cost})`, false); return false; }
    me.coins -= cost;
    return true;
  };
  switch (id) {
    case 'block_wool': { const b = ECONOMY.blocks.wool; if (!charge(b.price * b.stack)) return; me.wool += b.stack; notice(`+${b.stack} Wool`, true); break; }
    case 'block_plank': { const b = ECONOMY.blocks.plank; if (!charge(b.price * b.stack)) return; me.plank += b.stack; notice(`+${b.stack} Planks`, true); break; }
    case 'block_stone': {
      const b = ECONOMY.blocks.stone;
      if (me.coinsEarned < b.unlockCoinsEarned) { notice(`Stone unlocks after earning ${b.unlockCoinsEarned} coins`, false); return; }
      if (!charge(b.price * b.stack)) return; me.stone += b.stack; notice(`+${b.stack} Stone`, true); break;
    }
    case 'weapon_axe': buyWeaponLocal(WeaponId.Axe, charge, notice); break;
    case 'weapon_pickaxe': buyWeaponLocal(WeaponId.Pickaxe, charge, notice); break;
    case 'weapon_spear': buyWeaponLocal(WeaponId.Spear, charge, notice); break;
    case 'weapon_bow': buyWeaponLocal(WeaponId.Bow, charge, notice); break;
    case 'weapon_shield': buyWeaponLocal(WeaponId.Shield, charge, notice); break;
    case 'weapon_doubleaxe': buyWeaponLocal(WeaponId.DoubleAxe, charge, notice); break;
    case 'armor': { const n = team.armorTier + 1; if (n >= ECONOMY.armor.length) { notice('Max armor tier', false); return; } if (!charge(ECONOMY.armor[n].price)) return; team.armorTier = n; notice(`Team armor: ${ECONOMY.armor[n].name}`, true); break; }
    case 'pick': { const n = me.pickTier + 1; if (n >= ECONOMY.pickaxes.length) { notice('Max pickaxe tier', false); return; } if (!charge(ECONOMY.pickaxes[n].price)) return; me.pickTier = n; notice(`Bought ${ECONOMY.pickaxes[n].name}`, true); break; }
    case 'shears': { if (me.shears) { notice('Already own Shears', false); return; } if (!charge(ECONOMY.shears.price)) return; me.shears = true; notice('Bought Shears', true); break; }
    case 'tnt': { if (!charge(ECONOMY.utility.tnt.price)) return; me.tnt += 1; notice('+1 TNT', true); break; }
    case 'pearl': { if (!charge(ECONOMY.utility.pearl.price)) return; me.pearls += 1; notice('+1 Ender Pearl', true); break; }
    case 'fireball': { if (!charge(ECONOMY.utility.fireball.price)) return; me.fireballs += 1; notice('+1 Fireball', true); break; }
    case 'alarm': { if (!charge(ECONOMY.utility.alarm.price)) return; me.alarms += 1; notice('+1 Alarm Trap', true); break; }
    case 'gen_upgrade': { const n = team.genLevel + 1; if (n >= ECONOMY.generator.levels.length) { notice('Generator maxed', false); return; } if (!charge(ECONOMY.generator.levels[n].cost)) return; team.genLevel = n; notice(`Generator upgraded to Lv ${n}`, true); break; }
    default: notice('Unknown item', false); return;
  }
  hotbarSig = ''; // refresh hotbar counts
  shop.refresh();
}

function buyWeaponLocal(w: WeaponId, charge: (c: number) => boolean, notice: (t: string, ok: boolean) => void): void {
  const def = WEAPONS[w];
  if ((localMe.weapons >> w) & 1) { notice(`Already own ${def.name}`, false); return; }
  if (!charge(def.price)) return;
  localMe.weapons |= (1 << w);
  localMe.weapon = w;
  hotbarOwnedSig = '';
  notice(`Bought ${def.name}`, true);
}

// ------- Attack targeting -------
function findAttackTarget(): string | null {
  const positions = remotes.positions();
  let best: string | null = null;
  const weapon = activeWeaponDef();
  let bestDist = (weapon?.range ?? ATTACK_REACH) + 0.8;
  for (const p of positions) {
    const dx = p.x - camera.position.x;
    const dy = p.y + 1.0 - camera.position.y;
    const dz = p.z - camera.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > bestDist) continue;
    const dot = (dx * rayDir.x + dy * rayDir.y + dz * rayDir.z) / (dist || 1);
    if (dot < 0.94) continue;
    best = p.id;
    bestDist = dist;
  }
  return best;
}

// ------- Input handlers -------
input.onMouseDown = (button) => {
  if (!canPlay()) return;
  const me = getMe();
  const alive = offline ? !offlineDead : !!me?.alive;
  if (!spawned || !alive) return;
  clicks.push(Date.now());
  const wdef = activeWeaponDef();

  if (button === 0) {
    // Melee attack with the active weapon (shields can't melee).
    if (wdef?.shield) return;
    const targetId = findAttackTarget();
    const crit = !phys.onGround && phys.vy < -0.15;
    viewModel.swing(crit);
    audio.play('swing');
    if (targetId && room) room.send(Msg.Attack, { target: targetId, crit });
    return;
  }

  if (button === 2) {
    camera.getWorldDirection(rayDir);
    // Weapon-specific right-click: shield block.
    if (wdef?.shield) { setBlocking(true); return; }

    const slot = HOTBAR[activeSlot];
    if (slot.kind === 'block') {
      if (slotCount(slot, me) <= 0) { hud.showNotice('Out of ' + slot.label, false); return; }
      if (tryPlaceBlock()) placeCooldown = PLACE_COOLDOWN; // hold RMB to keep bridging
    } else if (slot.kind === 'util' && room) {
      if (slotCount(slot, me) <= 0) { hud.showNotice('Out of ' + slot.label, false); return; }
      if (slot.util === 'tnt') {
        const hit = raycastVoxel(camera.position.x, camera.position.y, camera.position.z, rayDir.x, rayDir.y, rayDir.z, REACH, world.isSolid);
        if (!hit) return;
        const gx = hit.x + hit.nx, gy = hit.y + hit.ny, gz = hit.z + hit.nz;
        room.send(Msg.UseItem, { item: 'tnt', x: gx, y: gy, z: gz, dx: 0, dy: 0, dz: 0 });
      } else if (slot.util === 'alarm') {
        room.send(Msg.UseItem, { item: 'alarm', x: phys.x, y: phys.y, z: phys.z, dx: 0, dy: 0, dz: 0 });
      } else {
        room.send(Msg.UseItem, { item: slot.util!, x: phys.x, y: phys.y, z: phys.z, dx: rayDir.x, dy: rayDir.y, dz: rayDir.z });
        viewModel.swing(false);
      }
    }
  }
};

input.onMouseUp = (button) => {
  if (button !== 2) return;
  // Release shield.
  if (blocking) setBlocking(false);
};

function placeableAt(gx: number, gy: number, gz: number): boolean {
  // Must be empty (never place inside the targeted block).
  if (world.get(gx, gy, gz) !== BlockType.Air) return false;
  // Never place inside the player's own AABB (raycast already ignores the
  // player since it only tests voxels, but the destination could still be
  // where we stand).
  const overlapsSelf =
    gx + 1 > phys.x - PLAYER_HALF_W && gx < phys.x + PLAYER_HALF_W &&
    gy + 1 > phys.y && gy < phys.y + PLAYER_HEIGHT &&
    gz + 1 > phys.z - PLAYER_HALF_W && gz < phys.z + PLAYER_HALF_W;
  return !overlapsSelf;
}

/**
 * Place one block on the face the player is aiming at.
 *
 * Raycasts the voxel grid (which ignores the player entirely), reads the hit
 * face normal, and places the block in the adjacent empty cell one step along
 * that normal — so top/bottom/left/right/front/back all work, on terrain and
 * on previously-placed blocks alike. Grid snapping is inherent to the voxel
 * grid. Optimistically updates the local world so the new block is instantly a
 * valid surface for the next placement (continuous bridging).
 *
 * @returns true if a block was placed.
 */
function tryPlaceBlock(): boolean {
  const slot = HOTBAR[activeSlot];
  if (slot.kind !== 'block' || slot.block === undefined) return false;
  const me = getMe();
  if (slotCount(slot, me) <= 0) return false;

  camera.getWorldDirection(rayDir);
  const hit = raycastVoxel(
    camera.position.x, camera.position.y, camera.position.z,
    rayDir.x, rayDir.y, rayDir.z, REACH, world.isSolid,
  );
  if (!hit) return false;

  // Adjacent cell = hit block + face normal (the empty cell we're aiming at).
  const gx = hit.x + hit.nx;
  const gy = hit.y + hit.ny;
  const gz = hit.z + hit.nz;
  if (!placeableAt(gx, gy, gz)) return false;

  viewModel.place();
  audio.play('place');
  worldRenderer.setBlock(gx, gy, gz, slot.block); // optimistic; server re-affirms via BlockDiff
  if (room) {
    room.send(Msg.Place, { x: gx, y: gy, z: gz, block: slot.block });
  } else {
    localMe[slot.invField!] = Math.max(0, (localMe[slot.invField!] ?? 0) - 1);
    hotbarSig = '';
  }
  return true;
}

input.onPowerUp = (type) => {
  if (!canPlay()) return;
  const def = POWERUPS[type as PowerUp];
  if (!def) return;
  const now = Date.now();
  const eff = currentEffects(now);
  if (eff.has(type)) return;
  if ((powerCooldownUntil.get(type) ?? 0) > now) return;
  powerCooldownUntil.set(type, now + def.durationMs + def.cooldownMs);
  if (room) room.send(Msg.PowerUp, { type });
  else localEffects.set(type, now + def.durationMs);
  audio.play('powerup');
  hud.addFeed(`${def.name} activated!`);
};

input.onOpenShop = () => {
  if (shop.isOpen) { shop.close(); return; } // E toggles the shop closed (works while cursor is shown)
  if (!canPlay() || !input.locked) return; // only open during active play, not on menus/splash
  const me = getMe();
  if (!me?.alive) return;
  if (room) {
    shop.open(
      getMe,
      () => (room!.state as any).teams?.[getMe()?.team ?? 0] ?? { armorTier: 0, genLevel: 0 },
      (id) => room!.send(Msg.Purchase, { id }),
    );
  } else {
    shop.open(getMe, () => localTeam, (id) => localBuy(id));
  }
  // Release the pointer so the cursor shows for clicking shop buttons.
  document.exitPointerLock();
};
shop.onClose = () => { if (canPlay()) input.requestLock(); };

input.onLockChange = (locked) => {
  if (locked) {
    menu.hide();
    audio.resume();
    startMusicOnce();
  } else if (shop.isOpen || endScreen.visible) {
    // shop / end screen manage their own overlay; don't pop the pause menu
  } else if (started && !lobby.visible) {
    menu.showPause();
  }
};

function startMusicOnce(): void {
  if (!musicStarted) { audio.startMusic(); musicStarted = true; }
}

// ------- Room message handlers -------
function attachRoomHandlers(r: Room): void {
  if (handlersAttached) return;
  handlersAttached = true;
  r.onMessage(Msg.WorldInit, (m: WorldInit) => { for (const d of m.diffs) worldRenderer.setBlock(d.x, d.y, d.z, d.b); });
  r.onMessage(Msg.BlockDiff, (d: BlockDiff) => {
    const prev = world.get(d.x, d.y, d.z);
    worldRenderer.setBlock(d.x, d.y, d.z, d.b);
    if (d.b === BlockType.Air && prev !== BlockType.Air) particles.dust(d.x + 0.5, d.y + 0.5, d.z + 0.5, BLOCKS[prev]?.color ?? 0x888888);
  });
  r.onMessage(Msg.Feed, (m: FeedMessage) => hud.addFeed(m.text));
  r.onMessage(Msg.Pong, (t: number) => { ping = Date.now() - t; });
  r.onMessage(Msg.Hit, (h: HitEvent) => {
    if (h.crit) particles.crit(h.x, h.y, h.z); else particles.hit(h.x, h.y, h.z);
    if (h.target !== myId) remotes.hitFlash(h.target);
    if (h.by !== myId) remotes.playAttack(h.by); // sync the attacker's swing animation
    if (h.by === myId) { hud.showHitMarker(h.crit); audio.play(h.crit ? 'crit' : 'hit'); }
    else if (h.target === myId) { audio.play('hit'); hud.flashDamage(); }
    else audio.play('hit');
  });
  r.onMessage(Msg.BedDestroyed, (e: BedDestroyedEvent) => {
    audio.play('bed');
    treasure.destroy(e.team); // remove the team's treasure chest
    particles.dust(e.x + 0.5, e.y + 0.5, e.z + 0.5, TEAMS[e.team].color, 40);
  });
  r.onMessage(Msg.Notice, (n: NoticeMessage) => {
    if (lobby.visible) lobby.notice(n.text);
    else hud.showNotice(n.text, n.ok);
    shop.refresh();
  });
  r.onMessage(Msg.Explosion, (e: ExplosionEvent) => {
    audio.play('bed');
    particles.dust(e.x, e.y, e.z, e.kind === 'fireball' ? 0xff7a1a : 0xff5533, 60);
    const d = camera.position.distanceTo(new THREE.Vector3(e.x, e.y, e.z));
    if (d < e.radius * 3) shake = Math.max(shake, 0.4 * (1 - d / (e.radius * 3)));
  });
  r.onMessage(Msg.Teleport, (t: TeleportEvent) => {
    phys.x = t.x; phys.y = t.y; phys.z = t.z; phys.vx = 0; phys.vy = 0; phys.vz = 0;
    pending.length = 0; batch = [];
  });
  // Rematch: server reset the finished match to a fresh lobby.
  r.onMessage(Msg.WorldReset, () => {
    resetLocalWorld();
    started = false; menu.started = false;
    endShown = false; prevWinner = -1; prevHp = 20; prevCoins = -1;
    spawned = false;
    pending.length = 0; batch = [];
    hotbarOwnedSig = ''; hotbarSig = '';
    localEffects.clear(); powerCooldownUntil.clear();
    endScreen.hide();
    objective.reset();
    menu.hide();
    if (document.pointerLockElement) document.exitPointerLock();
    lobby.resurface();
    if (playAgainRequested) { playAgainRequested = false; r.send(Msg.Ready, { ready: true }); }
  });
  setInterval(() => r.send(Msg.Ping, Date.now()), 2000);
}

// ------- Lobby wiring -------
const lobby = new Lobby({
  onRoomConnected: (r) => { room = r; offline = false; myId = r.sessionId; attachRoomHandlers(r); },
  onMatchStart: (r) => {
    room = r; offline = false; myId = r.sessionId; started = true; menu.started = true;
    menu.onCloseSettings = undefined;
    audio.resume();
    // Show a click-to-play splash so pointer lock is engaged from a real user
    // gesture. Joiners enter via a network event (no gesture), so a direct
    // requestPointerLock() would be rejected and they'd appear frozen.
    menu.showReady();
  },
  onOffline: () => {
    room = null; offline = true; started = true; menu.started = true;
    offlineDead = false;
    menu.onCloseSettings = undefined;
    // Free starting loadout, same as the server grants at match start.
    localMe.team = 0; localMe.alive = true; localMe.hp = 20;
    localMe.coins = 0; localMe.coinsEarned = 0;
    localMe.wool = ECONOMY.starting.wool; localMe.plank = 0; localMe.stone = 0;
    localMe.swordTier = ECONOMY.starting.swordTier; localMe.pickTier = 0; localMe.shears = false;
    localMe.tnt = 0; localMe.pearls = 0; localMe.fireballs = 0; localMe.alarms = 0;
    localTeam.armorTier = 0; localTeam.genLevel = 0;
    coinAcc = 0;
    localSpawn(0); hud.addFeed('Practice mode — coins generate automatically. Press E for the shop.');
    audio.resume();
    menu.showReady();
  },
  openSettings: () => {
    menu.onCloseSettings = () => { menu.hide(); lobby.showMain(); };
    menu.showSettings();
  },
});
menu.onResume = () => { audio.resume(); startMusicOnce(); input.requestLock(); };
menu.onUnstuck = () => {
  if (offline) { offlineDead = false; localSpawn(myTeam); }
  else room?.send(Msg.Unstuck, {});
};
menu.onExitMatch = () => exitMatch();

const fadeover = document.getElementById('fadeover')!;

/**
 * Leave the current match/practice cleanly and fade back to the Main Menu.
 * For multiplayer this sends a consented leave so the server runs onLeave
 * immediately (removing us from the lobby and disposing an emptied room — no
 * ghost player or ghost lobby). Local match state is fully reset either way.
 */
function exitMatch(): void {
  if (document.pointerLockElement) document.exitPointerLock();
  // Short fade out, swap to the menu behind the cover, then fade back in.
  fadeover.classList.add('on');
  window.setTimeout(() => {
    const leaving = room;
    // Reset local match/session state (mirrors the rematch teardown path).
    started = false; menu.started = false;
    endShown = false; prevWinner = -1; prevHp = 20; prevCoins = -1;
    spawned = false;
    pending.length = 0; batch = [];
    hotbarOwnedSig = ''; hotbarSig = '';
    localEffects.clear(); powerCooldownUntil.clear();
    offlineDead = false;
    endScreen.hide();
    objective.reset();
    menu.hide();
    resetLocalWorld();

    // Consented leave: server disposes the room when it empties (no ghosts).
    if (leaving) { try { leaving.leave(true); } catch { /* already closed */ } }
    room = null; offline = false;

    lobby.showMain();
    fadeover.classList.remove('on');
  }, 220);
}

// ------- Frame loop -------
let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const epochNow = Date.now();

  const play = canPlay();
  const phaseNow = offline ? 'playing' : ((room?.state as any)?.phase ?? 'lobby');
  const ended = !offline && started && phaseNow === 'ended';

  // Cinematic objective popup: fire once the player is actually in the match
  // (past the click-to-play splash). Purely visual — never pauses the game.
  if (play && !ended && !menu.visible) objective.play();
  let me: any = null;
  const players = room ? (room.state as any)?.players : null;

  // Keep player avatars synced while playing AND during the frozen end screen.
  if ((play || ended) && room && players) {
    const seen = new Set<string>();
    players.forEach((p: any, id: string) => {
      seen.add(id);
      if (id === myId) {
        me = p;
        if (!spawned && play) { localSpawn(p.team); phys.x = p.x; phys.y = p.y; phys.z = p.z; }
        return;
      }
      if (!remotes.has(id)) remotes.add(id, p.team);
      remotes.updateTarget(id, p.x, p.y, p.z, p.yaw, !!p.alive, p.weapon ?? 0, p.name ?? '');
    });
    remotes.prune(seen);
  }

  // --- Match end: play stinger + show Victory/Defeat screen, then freeze. ---
  const winnerNow: number = (room?.state as any)?.winner ?? -1;
  if (winnerNow !== prevWinner && winnerNow >= 0) prevWinner = winnerNow;
  if (ended && !endShown && winnerNow >= 0) {
    endShown = true;
    const t = TEAMS[winnerNow] ?? TEAMS[0];
    endScreen.show(winnerNow === myTeam, t.name, `#${t.color.toString(16).padStart(6, '0')}`);
    hud.setStatus('');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Offline: drive the local player + coin generator so HUD/shop/economy work.
  if (play && offline) {
    me = localMe;
    localMe.alive = !offlineDead;
    localMe.hp = offlineDead ? 0 : 20;
    if (!offlineDead) {
      coinAcc += dt * 1000;
      const interval = ECONOMY.generator.levels[localTeam.genLevel]?.intervalMs ?? 1000;
      while (coinAcc >= interval) {
        coinAcc -= interval;
        localMe.coins += ECONOMY.generator.dropValue;
        localMe.coinsEarned += ECONOMY.generator.dropValue;
      }
    }
  }

  const alive = play ? (room ? (me ? !!me.alive : true) : !offlineDead) : true;
  const mods = currentMods(epochNow);

  if (play) {
    // Offline/practice respawn: mirrors the server's timer + bed-alive check.
    // (In practice there are no enemies, so your bed is always alive.)
    if (offline && offlineDead && epochNow >= offlineDeadUntil) {
      localSpawn(myTeam);
      offlineDead = false;
    }
    if (me && !prevAlive && me.alive) {
      phys.x = me.x; phys.y = me.y; phys.z = me.z; phys.vx = 0; phys.vz = 0; phys.vy = 0;
      pending.length = 0; batch = [];
    }
    if (me && prevAlive && !me.alive) { deadSince = now; audio.play('defeat'); }
    prevAlive = alive;

    if (me && me.hp < prevHp && me.alive) hud.flashDamage();
    if (me) prevHp = me.hp;

    const sprinting = input.locked && input.sprint && input.moveZ > 0 && alive;
    if (spawned && alive) {
      const move: MoveInput = {
        seq: seq++, dt,
        moveX: input.locked ? input.moveX : 0,
        moveZ: input.locked ? input.moveZ : 0,
        jump: input.locked && input.jump,
        sprint: input.locked && input.sprint,
        yaw: input.yaw,
      };
      const wasGround = phys.onGround;
      stepPlayer(phys, move, world.isSolid, mods);
      if (wasGround && !phys.onGround && move.jump) audio.play('jump');
      if (room) {
        pending.push(move); batch.push(move);
        if (pending.length > 120) pending.splice(0, pending.length - 120);
        sendTimer += dt * 1000;
        if (sendTimer >= TICK_MS && batch.length > 0) { room.send(Msg.Input, batch); batch = []; sendTimer = 0; }
        if (me && me.lastSeq > lastReconciled) {
          lastReconciled = me.lastSeq;
          phys.x = me.x; phys.y = me.y; phys.z = me.z; phys.vx = me.vx; phys.vz = me.vz; phys.vy = me.vy;
          while (pending.length > 0 && pending[0].seq <= me.lastSeq) pending.shift();
          for (const m of pending) stepPlayer(phys, m, world.isSolid, mods);
        }
      }
    }

    if (!prevOnGround && phys.onGround) { landDip = 0.12; audio.play('land'); }
    prevOnGround = phys.onGround;

    // Offline void death -> start the respawn countdown (server handles this
    // in multiplayer, but practice mode has no server to run the timer).
    if (offline && !offlineDead && phys.y < VOID_Y) {
      offlineDead = true;
      offlineDeadUntil = epochNow + RESPAWN_SECONDS * 1000;
      deadSince = now;
      audio.play('defeat');
    }

    remotes.update(dt);

    const moving = input.locked && (input.moveX !== 0 || input.moveZ !== 0);
    if (phys.onGround && moving && alive) {
      stepTimer -= dt;
      if (stepTimer <= 0) { audio.play('step'); stepTimer = sprinting ? 0.28 : 0.4; }
    } else stepTimer = 0;

    if (phys.onGround && moving && alive) bobT += dt * (sprinting ? 11 : 8);
    const bob = phys.onGround && moving ? Math.sin(bobT) * 0.05 : 0;
    if (landDip > 0) landDip = Math.max(0, landDip - dt * 0.8);
    if (shake > 0) shake = Math.max(0, shake - dt * 1.6);
    const sx = shake > 0 ? (Math.random() - 0.5) * shake : 0;
    const sy = shake > 0 ? (Math.random() - 0.5) * shake : 0;
    camera.position.set(phys.x + sx, phys.y + PLAYER_EYE + bob - landDip + sy, phys.z);
    camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ');
    const speedBoost = (mods.speedMult ?? 1) > 1.01;
    const targetFov = settings.get().fov + (sprinting ? 8 : 0) + (speedBoost ? 6 : 0);
    if (Math.abs(camera.fov - targetFov) > 0.05) { camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10); camera.updateProjectionMatrix(); }

    graphics.update(camera.position);

    // The shop is always reachable via E while alive — show the prompt.
    hud.setShopHint(alive && !shop.isOpen);

    // Targeting + mining
    camera.getWorldDirection(rayDir);
    const hit = alive ? raycastVoxel(camera.position.x, camera.position.y, camera.position.z, rayDir.x, rayDir.y, rayDir.z, REACH, world.isSolid) : null;
    const attackTarget = alive ? findAttackTarget() : null;
    const slot = HOTBAR[activeSlot];

    if (hit) {
      sel.visible = true;
      sel.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      const gx = hit.x + hit.nx, gy = hit.y + hit.ny, gz = hit.z + hit.nz;
      const showGhost = (slot.kind === 'block' || (slot.kind === 'util' && slot.util === 'tnt')) && placeableAt(gx, gy, gz);
      if (showGhost) {
        ghost.visible = true;
        ghost.position.set(gx + 0.5, gy + 0.5, gz + 0.5);
        ghostMat.color.setHex(slot.kind === 'block' ? BLOCKS[slot.block!].color : (slot.color ?? 0xd23b2b));
      } else ghost.visible = false;
    } else { sel.visible = false; ghost.visible = false; }

    const targetBlock = hit ? world.get(hit.x, hit.y, hit.z) : BlockType.Air;
    const def = BLOCKS[targetBlock];
    const wantMine = input.mouseLeft && alive && !!hit && !attackTarget;
    const canMineBlock = wantMine && def?.breakable;
    // Mining speed: powerup haste × pickaxe tier × active-weapon break multiplier.
    const pickSpeed = ECONOMY.pickaxes[me?.pickTier ?? 0]?.speed ?? 1;
    const weaponBreak = WEAPONS[(me?.weapon ?? WeaponId.IronSword) as WeaponId]?.breakMult ?? 1;
    const isWool = targetBlock >= BlockType.WoolRed && targetBlock <= BlockType.WoolYellow;
    const hasteMult = (mods.hasteMult ?? 1) * pickSpeed * weaponBreak * (me?.shears && isWool ? 1.6 : 1);
    viewModel.setMining(!!canMineBlock);
    const completed = mining.update(
      dt, hit ? { x: hit.x, y: hit.y, z: hit.z } : null,
      canMineBlock ? def!.hardness : Infinity, !!canMineBlock, hasteMult,
      () => { audio.play('mine'); if (hit) particles.dust(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, def!.color, 3); },
    );
    if (completed && hit) {
      audio.play('break');
      particles.dust(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, def!.color, 16);
      if (isBed(targetBlock)) audio.play('bed');
      if (room) room.send(Msg.Break, { x: hit.x, y: hit.y, z: hit.z });
      else if (def!.breakable && !isBed(targetBlock)) worldRenderer.setBlock(hit.x, hit.y, hit.z, BlockType.Air);
    }

    // Continuous placement: hold right mouse to keep placing on the aimed
    // face at a steady rate (BedWars-style bridging). The single-click case is
    // handled immediately in onMouseDown; this drives the repeat.
    if (placeCooldown > 0) placeCooldown -= dt;
    if (input.mouseRight && alive && !shop.isOpen && slot.kind === 'block' && placeCooldown <= 0) {
      if (tryPlaceBlock()) placeCooldown = PLACE_COOLDOWN;
    }

    viewModel.update(dt, moving, sprinting, phys.onGround);
    renderHotbar(me);
    // Sync the local view model to the authoritative equipped weapon (e.g.
    // after a purchase auto-equips it, or any server-driven change).
    if (me && me.weapon !== lastEquippedWeapon) {
      lastEquippedWeapon = me.weapon;
      equipWeaponVisual(me.weapon);
    }

    // HUD
    hud.setHearts(me ? me.hp : (offline && offlineDead ? 0 : 20));
    hud.setCoins(me ? me.coins : 0);
    if (me && me.coins !== prevCoins) { prevCoins = me.coins; if (shop.isOpen) shop.refresh(); }
    hud.update(dt);

    const eff = currentEffects(epochNow);
    const puViews: PowerUpView[] = ALL_POWERUPS.map((p) => {
      const exp = eff.get(p.id);
      const active = exp !== undefined && exp > epochNow;
      const readyAt = powerCooldownUntil.get(p.id) ?? 0;
      const cooldownFrac = !active && readyAt > epochNow ? Math.min(1, (readyAt - epochNow) / p.cooldownMs) : 0;
      return {
        name: p.name, color: `#${p.color.toString(16).padStart(6, '0')}`,
        activeFrac: active ? Math.max(0, (exp! - epochNow) / p.durationMs) : 0,
        cooldownFrac, active,
      };
    });
    hud.setPowerups(puViews);

    // Kill counter (local player).
    hud.setKills(me ? me.kills : 0, me ? me.deaths : 0, me ? me.assists : 0);

    // Match timer (top-center) — server-driven when online.
    hud.setTimer(offline ? -1 : ((room?.state as any)?.timeLeftMs ?? -1));

    boardTimer += dt;
    if (boardTimer >= 0.25) {
      boardTimer = 0;
      const alive = TEAMS.map(() => 0);
      const teamKills = TEAMS.map(() => 0);
      if (players) players.forEach((p: any) => { if (p.alive) alive[p.team]++; teamKills[p.team] += p.kills ?? 0; });
      if (!room || !players) alive[myTeam] = 1;
      const bedsAlive: number = (room?.state as any)?.bedsAlive ?? 0b1111;
      hud.setScoreboard(TEAMS.map((t, i) => ({
        name: t.name, color: `#${t.color.toString(16).padStart(6, '0')}`,
        treasureAlive: ((bedsAlive >> i) & 1) === 1, alive: alive[i], kills: teamKills[i], you: i === myTeam,
      })));

      // Objective tracker: my treasure standing + how many enemy treasures remain.
      const myTreasureAlive = ((bedsAlive >> myTeam) & 1) === 1;
      let enemyTreasuresLeft = 0;
      for (let i = 0; i < TEAMS.length; i++) if (i !== myTeam && ((bedsAlive >> i) & 1) === 1) enemyTreasuresLeft++;
      objective.setProgress(myTreasureAlive, enemyTreasuresLeft);
    }

    // Death / respawn countdown (win/lose is shown on the end screen).
    if (offline && offlineDead) {
      const left = Math.max(0, Math.ceil((offlineDeadUntil - epochNow) / 1000));
      hud.setStatus(`You died! Respawning in ${left}...`);
    } else if (me && !alive) {
      const bedAlive = ((((room?.state as any)?.bedsAlive ?? 0b1111) >> me.team) & 1) === 1;
      if (bedAlive) { const left = Math.max(0, Math.ceil(RESPAWN_SECONDS - (now - deadSince) / 1000)); hud.setStatus(`You died! Respawning in ${left}...`); }
      else hud.setStatus('ELIMINATED — your Treasure was destroyed');
    } else hud.setStatus('');
  } else if (ended) {
    // Match over: freeze the scene (camera stays put), let avatars settle to
    // idle, and keep the world lit while the Victory/Defeat screen is shown.
    remotes.update(dt);
    graphics.update(camera.position);
    hud.setStatus('');
    hud.setShopHint(false);
    hud.setTimer(-1);
  } else {
    // Lobby backdrop: slow orbit around the map.
    const a = now * 0.00005;
    camera.position.set(CENTER.x + Math.cos(a) * 70, 52, CENTER.z + Math.sin(a) * 70);
    camera.lookAt(CENTER.x, 20, CENTER.z);
    graphics.update(camera.position);
    hud.setShopHint(false);
    hud.setTimer(-1);
  }

  // Entities (coins / projectiles / tnt) render whenever a match is live.
  if (room && ((room.state as any)?.phase === 'playing')) entities.sync(room.state, dt);

  // Stats
  frames++; fpsTimer += dt;
  if (fpsTimer >= 0.5) { fps = Math.round(frames / fpsTimer); frames = 0; fpsTimer = 0; }
  const cutoff = epochNow - 1000;
  while (clicks.length > 0 && clicks[0]! < cutoff) clicks.shift();
  hud.setStats(fps, room ? ping : null, clicks.length);

  particles.update(dt);
  treasure.update(dt);
  environment.update(dt);
  worldRenderer.update();
  graphics.render();
}
requestAnimationFrame(frame);
