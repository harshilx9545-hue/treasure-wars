import { VoxelWorld } from './world';
import { BlockType } from './blocks';
import { TeamId, TEAM_COUNT, TEAMS } from './teams';
import { WORLD_X, WORLD_Z } from './constants';

/**
 * PIRATE ARENA — one large island with four team forts around a contested
 * center. Generated identically on client and server (fully deterministic, no
 * Math.random), so collision/prediction/authority stay in perfect sync.
 *
 * Gameplay is unchanged: each fort still holds a 2-block "bed" (rendered as a
 * Treasure chest) as the objective, a coin generator, a spawn, and a shop
 * zone. Only the level layout and theme changed.
 */

export const BASE_Y = 16; // island surface height
export const SEA_Y = BASE_Y - 3; // decorative ocean level (client only)
export const ISLAND_RADIUS = 80; // island disc radius
export const FORT_OFFSET = 56; // center -> fort center distance
export const FORT_HALF = 15; // fort courtyard half-size (31x31)
export const CENTER_RADIUS = 20; // neutral center plaza radius
export const MAP_CENTER = Math.floor(WORLD_X / 2);

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  team: TeamId;
  /** Coin generator location on this fort. */
  gx: number;
  gy: number;
  gz: number;
}

/** Center of a team's two-block Treasure, used by objective systems and bots. */
export function treasurePosition(team: number): { x: number; y: number; z: number } {
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const [dx, dz] = dirs[team] ?? dirs[0]!;
  return {
    x: MAP_CENTER + dx * (FORT_OFFSET + 8) + 0.5,
    y: BASE_Y + 1,
    z: MAP_CENTER + dz * (FORT_OFFSET + 8) + 0.5,
  };
}

// Deterministic hash -> 0..1 (stable on every machine; used for coast jitter,
// rubble and pillar height variation so client and server agree exactly).
function h2(x: number, z: number): number {
  let n = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fillBox(w: VoxelWorld, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, b: BlockType): void {
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) w.set(x, y, z, b);
}

function column(w: VoxelWorld, x: number, z: number, y0: number, y1: number, b: BlockType): void {
  for (let y = y0; y <= y1; y++) w.set(x, y, z, b);
}

/** One large island: grass interior, sandy (end-stone) coast, a couple of soil layers. */
function buildIsland(w: VoxelWorld): void {
  const c = MAP_CENTER;
  const R = ISLAND_RADIUS;
  for (let x = c - R; x <= c + R; x++) {
    for (let z = c - R; z <= c + R; z++) {
      const dx = x - c;
      const dz = z - c;
      const d = Math.sqrt(dx * dx + dz * dz);
      const rr = R - h2(x, z) * 5; // jagged coastline
      if (d > rr) continue;
      const beach = d > rr - 4;
      w.set(x, BASE_Y, z, beach ? BlockType.EndStone : BlockType.Grass);
      w.set(x, BASE_Y - 1, z, BlockType.Dirt);
      w.set(x, BASE_Y - 2, z, BlockType.Stone);
    }
  }
}

/** Contested center: stone plaza, grand (decorative) generator dais, ruins + cover. */
function buildCenter(w: VoxelWorld): void {
  const c = MAP_CENTER;
  const R = CENTER_RADIUS;
  // Plaza floor.
  for (let x = c - R; x <= c + R; x++) {
    for (let z = c - R; z <= c + R; z++) {
      const d = Math.hypot(x - c, z - c);
      if (d > R) continue;
      w.set(x, BASE_Y, z, d > R - 2 ? BlockType.Plank : BlockType.Stone);
    }
  }
  // Raised central dais with a grand gold/diamond centerpiece (visual generator).
  for (let x = c - 5; x <= c + 5; x++)
    for (let z = c - 5; z <= c + 5; z++)
      if (Math.hypot(x - c, z - c) <= 5) w.set(x, BASE_Y + 1, z, BlockType.Stone);
  w.set(c, BASE_Y + 2, c, BlockType.GoldBlock);
  w.set(c, BASE_Y + 3, c, BlockType.DiamondBlock);

  // Ruined pillars ringing the plaza (varying, some broken).
  const pillars = 8;
  for (let i = 0; i < pillars; i++) {
    const a = (i / pillars) * Math.PI * 2;
    const px = Math.round(c + Math.cos(a) * 14);
    const pz = Math.round(c + Math.sin(a) * 14);
    const hgt = 3 + Math.floor(h2(px, pz) * 4); // 3..6
    column(w, px, pz, BASE_Y + 1, BASE_Y + hgt, BlockType.Stone);
    if (h2(px, pz) > 0.5) w.set(px, BASE_Y + hgt + 1, pz, BlockType.Stone); // broken cap
  }
  // Scattered cover blocks + statue pedestals for PvP.
  const cover: Array<[number, number, number]> = [
    [10, 0, 1], [-10, 0, 1], [0, 10, 1], [0, -10, 1],
    [7, 7, 2], [-7, -7, 2], [7, -7, 1], [-7, 7, 1],
  ];
  for (const [ox, oz, hh] of cover) column(w, c + ox, c + oz, BASE_Y + 1, BASE_Y + hh, BlockType.Stone);
  // Statue pedestals (client places the statues on top).
  for (const [ox, oz] of [[13, 13], [-13, -13]] as const) fillBox(w, c + ox - 1, BASE_Y + 1, c + oz - 1, c + ox + 1, BASE_Y + 2, c + oz + 1, BlockType.Stone);
}

/** Wall ring with 4 central entrances (one per edge) and crenellated top. */
function fortWalls(w: VoxelWorld, fx: number, fz: number, half: number, team: number): void {
  const y0 = BASE_Y + 1;
  const h = 4;
  let idx = 0;
  for (let ox = -half; ox <= half; ox++) {
    for (let oz = -half; oz <= half; oz++) {
      const onX = Math.abs(ox) === half;
      const onZ = Math.abs(oz) === half;
      if (!onX && !onZ) continue; // perimeter only
      // Central 3-wide gate on each edge.
      const gate = (onX && Math.abs(oz) <= 1) || (onZ && Math.abs(ox) <= 1);
      if (gate) continue;
      column(w, fx + ox, fz + oz, y0, y0 + h - 1, BlockType.Stone);
      if ((idx++ & 1) === 0) w.set(fx + ox, y0 + h, fz + oz, BlockType.Stone); // battlement
      // Team-colored banner accent every few blocks.
      if ((onX && oz === half - 2) || (onZ && ox === half - 2)) w.set(fx + ox, y0 + h - 1, fz + oz, TEAMS[team].wool);
    }
  }
}

function fortTower(w: VoxelWorld, tx: number, tz: number, height: number, team: number): void {
  const y0 = BASE_Y + 1;
  // 3x3 stone shaft.
  fillBox(w, tx - 1, y0, tz - 1, tx + 1, y0 + height - 1, tz + 1, BlockType.Stone);
  // Hollow the top so it's a lookout.
  fillBox(w, tx, y0 + height - 2, tz, tx, y0 + height - 1, tz, BlockType.Air);
  // Wooden crown + crenellations.
  for (const [ox, oz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) w.set(tx + ox, y0 + height, tz + oz, BlockType.Wood);
  // Flag pole + team flag at the very top.
  column(w, tx, y0 + height, tz, y0 + height + 2, BlockType.Wood);
  w.set(tx, y0 + height + 3, tz, TEAMS[team].wool);
}

/** Small enclosed vault holding the team treasure (bed), with a front doorway. */
function fortVault(w: VoxelWorld, vx: number, vz: number, dx: number, dz: number, px: number, pz: number, team: number): void {
  const y0 = BASE_Y + 1;
  const half = 3;
  // Walls + roof.
  for (let ox = -half; ox <= half; ox++) {
    for (let oz = -half; oz <= half; oz++) {
      const perimeter = Math.abs(ox) === half || Math.abs(oz) === half;
      if (perimeter) column(w, vx + ox, vz + oz, y0, y0 + 3, BlockType.Stone);
      w.set(vx + ox, y0 + 4, vz + oz, BlockType.Wood); // roof
    }
  }
  // Doorway facing the courtyard/front (toward -dx from the vault).
  const doorX = vx - dx * half;
  const doorZ = vz - dz * half;
  w.set(doorX, y0, doorZ, BlockType.Air);
  w.set(doorX, y0 + 1, doorZ, BlockType.Air);
  // Gold trim inside.
  for (const [ox, oz] of [[-2, -2], [-2, 2], [2, -2], [2, 2]] as const) w.set(vx + ox, y0, vz + oz, BlockType.GoldBlock);
  // The TREASURE: two adjacent bed blocks (rendered as a chest, same bed logic).
  w.set(vx, y0, vz, TEAMS[team].bed);
  w.set(vx + px, y0, vz + pz, TEAMS[team].bed);
}

function buildFort(w: VoxelWorld, dx: number, dz: number, team: number): SpawnPoint {
  const c = MAP_CENTER;
  const fx = c + dx * FORT_OFFSET;
  const fz = c + dz * FORT_OFFSET;
  const px = -dz; // perpendicular unit
  const pz = dx;
  const H = FORT_HALF;

  // Courtyard floor (stone plaza over the island grass) + plank rim.
  for (let ox = -H; ox <= H; ox++)
    for (let oz = -H; oz <= H; oz++)
      w.set(fx + ox, BASE_Y, fz + oz, Math.max(Math.abs(ox), Math.abs(oz)) >= H - 1 ? BlockType.Plank : BlockType.Stone);

  fortWalls(w, fx, fz, H, team);

  // Corner towers — back two are tall watchtowers (high ground), front two shorter.
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const tx = fx + sx * (H - 1);
    const tz = fz + sz * (H - 1);
    const back = sx * dx + sz * dz > 0; // corner on the far (dock) side
    fortTower(w, tx, tz, back ? 9 : 6, team);
  }

  // Treasure vault toward the back of the fort.
  fortVault(w, fx + dx * 8, fz + dz * 8, dx, dz, px, pz, team);

  // Generator pad toward the front (center side).
  const gx = fx - dx * 8;
  const gz = fz - dz * 8;
  w.set(gx, BASE_Y, gz, BlockType.IronBlock);
  w.set(gx + px, BASE_Y, gz + pz, BlockType.GoldBlock);
  w.set(gx - px, BASE_Y, gz - pz, BlockType.IronBlock);

  // Dock: plank pier extending out the back over the water, with support posts.
  for (let i = H + 1; i <= H + 12; i++) {
    for (let o = -1; o <= 1; o++) {
      w.set(fx + dx * i + px * o, BASE_Y, fz + dz * i + pz * o, BlockType.Plank);
    }
    if (i % 4 === 0) column(w, fx + dx * i, SEA_Y, fz + dz * i, BASE_Y - 1, BlockType.Wood); // post
  }

  return {
    x: fx - dx * 3 + 0.5,
    y: BASE_Y + 1,
    z: fz - dz * 3 + 0.5,
    team: team as TeamId,
    gx: gx + 0.5,
    gy: BASE_Y + 1,
    gz: gz + 0.5,
  };
}

/** Wide plank roads from the center plaza to each fort's front gate. */
function buildRoads(w: VoxelWorld, dirs: Array<[number, number]>): void {
  const c = MAP_CENTER;
  for (const [dx, dz] of dirs) {
    const px = -dz;
    const pz = dx;
    for (let i = CENTER_RADIUS - 1; i <= FORT_OFFSET - FORT_HALF; i++) {
      for (let o = -1; o <= 1; o++) {
        const x = c + dx * i + px * o;
        const z = c + dz * i + pz * o;
        if (w.get(x, BASE_Y, z) === BlockType.Grass || w.get(x, BASE_Y, z) === BlockType.EndStone) {
          w.set(x, BASE_Y, z, BlockType.Plank);
        }
      }
    }
  }
}

export function generateMap(w: VoxelWorld): SpawnPoint[] {
  buildIsland(w);
  buildCenter(w);

  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  buildRoads(w, dirs);

  const spawns: SpawnPoint[] = [];
  for (let t = 0; t < TEAM_COUNT; t++) {
    const [dx, dz] = dirs[t];
    spawns.push(buildFort(w, dx, dz, t));
  }
  return spawns;
}
