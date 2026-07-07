import { WORLD_X, WORLD_Y, WORLD_Z } from './constants';
import { BlockType } from './blocks';

/**
 * Flat typed-array voxel grid. Used identically on client (rendering,
 * prediction) and server (authority). No per-block objects, ever.
 */
export class VoxelWorld {
  readonly data: Uint8Array;

  constructor(
    readonly sx: number = WORLD_X,
    readonly sy: number = WORLD_Y,
    readonly sz: number = WORLD_Z,
  ) {
    this.data = new Uint8Array(sx * sy * sz);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  private index(x: number, y: number, z: number): number {
    return (y * this.sz + z) * this.sx + x;
  }

  get(x: number, y: number, z: number): number {
    return this.inBounds(x, y, z) ? this.data[this.index(x, y, z)] : BlockType.Air;
  }

  set(x: number, y: number, z: number, b: number): void {
    if (this.inBounds(x, y, z)) this.data[this.index(x, y, z)] = b;
  }

  /** Bound so it can be passed directly as an IsSolidFn. */
  isSolid = (x: number, y: number, z: number): boolean =>
    this.get(x, y, z) !== BlockType.Air;
}
