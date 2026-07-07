import { VoxelWorld } from './world';
import { BlockType } from './blocks';
import { TeamId, TEAM_COUNT, TEAMS } from './teams';
import { WORLD_X, WORLD_Z } from './constants';

export const BASE_Y = 16;
export const ISLAND_RADIUS = 80; // distance from map center to island center

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

/**
 * Deterministic map generation shared by client and server: 4 team islands
 * at compass points, plank bridges to a stone center island over the void.
 * Only player-made changes need syncing (block diffs).
 */
export function generateMap(w: VoxelWorld): SpawnPoint[] {
  const cx = Math.floor(WORLD_X / 2);
  const cz = Math.floor(WORLD_Z / 2);

  // Center island (future diamond/emerald generator site)
  platform(w, cx - 12, cz - 12, 25, 25, BASE_Y, BlockType.Stone, BlockType.Bedrock);

  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const spawns: SpawnPoint[] = [];

  for (let t = 0; t < TEAM_COUNT; t++) {
    const [dx, dz] = dirs[t];
    const ix = cx + dx * ISLAND_RADIUS;
    const iz = cz + dz * ISLAND_RADIUS;

    platform(w, ix - 10, iz - 10, 21, 21, BASE_Y, BlockType.Grass, BlockType.Dirt);

    // Bridge from center island edge to team island edge (3 wide)
    for (let i = 13; i <= ISLAND_RADIUS - 11; i++) {
      for (let o = -1; o <= 1; o++) {
        w.set(cx + dx * i + Math.abs(dz) * o, BASE_Y, cz + dz * i + Math.abs(dx) * o, BlockType.Plank);
      }
    }

    // Bed placeholder: two team wool blocks (real bed entity lands in Phase 4)
    const bedX = ix - dx * 6;
    const bedZ = iz - dz * 6;
    w.set(bedX, BASE_Y + 1, bedZ, TEAMS[t].wool);
    w.set(bedX - dx, BASE_Y + 1, bedZ - dz, TEAMS[t].wool);

    spawns.push({ x: ix + dx * 4 + 0.5, y: BASE_Y + 1, z: iz + dz * 4 + 0.5, team: t as TeamId });
  }

  return spawns;
}
