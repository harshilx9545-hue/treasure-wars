import { VoxelWorld } from './world';
import { BlockType } from './blocks';
import { TeamId, TEAM_COUNT, TEAMS } from './teams';
import { WORLD_X, WORLD_Z } from './constants';

export const BASE_Y = 16;
export const ISLAND_RADIUS = 80; // map center -> team island center
export const DIAMOND_OFFSET = 39; // diagonal offset of diamond islands

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  team: TeamId;
}

function platform(
  w: VoxelWorld,
  x0: number,
  z0: number,
  sx: number,
  sz: number,
  y: number,
  top: BlockType,
  under: BlockType,
): void {
  for (let x = 0; x < sx; x++) {
    for (let z = 0; z < sz; z++) {
      w.set(x0 + x, y, z0 + z, top);
      w.set(x0 + x, y - 1, z0 + z, under);
    }
  }
}

function tree(w: VoxelWorld, x: number, y: number, z: number): void {
  for (let i = 0; i < 4; i++) w.set(x, y + i, z, BlockType.Wood);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = 2; dy <= 3; dy++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // rounded corners
        if (dx === 0 && dz === 0 && dy < 4) continue; // trunk
        w.set(x + dx, y + dy, z + dz, BlockType.Leaves);
      }
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue;
      w.set(x + dx, y + 4, z + dz, BlockType.Leaves);
    }
  }
  w.set(x, y + 5, z, BlockType.Leaves);
}

/**
 * Deterministic Bedwars map, generated identically on client and server:
 * - 4 team islands (23x23): grass with end-stone trim, bed, iron/gold
 *   generator pad, corner wool pillars and a tree
 * - 4 diamond generator islands on the diagonals
 * - 29x29 center island with a raised emerald platform, pillars and trees
 * - 3-wide plank bridges with a team-wool center stripe
 */
export function generateMap(w: VoxelWorld): SpawnPoint[] {
  const cx = Math.floor(WORLD_X / 2);
  const cz = Math.floor(WORLD_Z / 2);

  // --- Center island ---
  platform(w, cx - 14, cz - 14, 29, 29, BASE_Y, BlockType.Stone, BlockType.Bedrock);
  platform(w, cx - 4, cz - 4, 9, 9, BASE_Y + 1, BlockType.Stone, BlockType.Stone);
  w.set(cx, BASE_Y + 2, cz, BlockType.EmeraldBlock);
  for (const [ox, oz] of [[-4, -4], [-4, 4], [4, -4], [4, 4]] as const) {
    w.set(cx + ox, BASE_Y + 2, cz + oz, BlockType.Wood);
    w.set(cx + ox, BASE_Y + 3, cz + oz, BlockType.Wood);
  }
  tree(w, cx - 10, BASE_Y + 1, cz - 10);
  tree(w, cx + 10, BASE_Y + 1, cz + 10);

  // --- Diamond generator islands (diagonals) ---
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const gx = cx + sx * DIAMOND_OFFSET;
    const gz = cz + sz * DIAMOND_OFFSET;
    platform(w, gx - 4, gz - 4, 9, 9, BASE_Y, BlockType.Stone, BlockType.Stone);
    for (let i = -4; i <= 4; i++) {
      w.set(gx + i, BASE_Y, gz - 4, BlockType.EndStone);
      w.set(gx + i, BASE_Y, gz + 4, BlockType.EndStone);
      w.set(gx - 4, BASE_Y, gz + i, BlockType.EndStone);
      w.set(gx + 4, BASE_Y, gz + i, BlockType.EndStone);
    }
    w.set(gx, BASE_Y + 1, gz, BlockType.DiamondBlock);
  }

  // --- Team islands + bridges ---
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const spawns: SpawnPoint[] = [];

  for (let t = 0; t < TEAM_COUNT; t++) {
    const [dx, dz] = dirs[t];
    const px = Math.abs(dz); // perpendicular axis
    const pz = Math.abs(dx);
    const ix = cx + dx * ISLAND_RADIUS;
    const iz = cz + dz * ISLAND_RADIUS;
    const team = TEAMS[t];

    platform(w, ix - 11, iz - 11, 23, 23, BASE_Y, BlockType.Grass, BlockType.Dirt);
    // End-stone trim
    for (let i = -11; i <= 11; i++) {
      w.set(ix + i, BASE_Y, iz - 11, BlockType.EndStone);
      w.set(ix + i, BASE_Y, iz + 11, BlockType.EndStone);
      w.set(ix - 11, BASE_Y, iz + i, BlockType.EndStone);
      w.set(ix + 11, BASE_Y, iz + i, BlockType.EndStone);
    }
    // Corner wool pillars
    for (const [ox, oz] of [[-9, -9], [-9, 9], [9, -9], [9, 9]] as const) {
      w.set(ix + ox, BASE_Y + 1, iz + oz, team.wool);
      w.set(ix + ox, BASE_Y + 2, iz + oz, team.wool);
    }
    // Bed (two blocks, foot toward the bridge)
    w.set(ix - dx * 7, BASE_Y + 1, iz - dz * 7, team.bed);
    w.set(ix - dx * 8, BASE_Y + 1, iz - dz * 8, team.bed);
    // Iron/gold generator pad (inset into the floor, behind spawn)
    w.set(ix + dx * 7, BASE_Y, iz + dz * 7, BlockType.IronBlock);
    w.set(ix + dx * 7 + px, BASE_Y, iz + dz * 7 + pz, BlockType.GoldBlock);
    // Tree off to the side
    tree(w, ix + px * 6, BASE_Y + 1, iz + pz * 6);

    // Bridge: plank sides, team-wool center stripe
    for (let i = 15; i <= ISLAND_RADIUS - 12; i++) {
      for (let o = -1; o <= 1; o++) {
        w.set(cx + dx * i + px * o, BASE_Y, cz + dz * i + pz * o, o === 0 ? team.wool : BlockType.Plank);
      }
    }

    spawns.push({ x: ix + dx * 4 + 0.5, y: BASE_Y + 1, z: iz + dz * 4 + 0.5, team: t as TeamId });
  }

  return spawns;
}
