import {
  GRAVITY,
  JUMP_VELOCITY,
  MOVE_SPEED,
  MAX_STEP_DT,
  PLAYER_HALF_W,
  PLAYER_HEIGHT,
} from './constants';

export type IsSolidFn = (x: number, y: number, z: number) => boolean;

export interface PlayerPhysics {
  x: number; // feet center
  y: number;
  z: number;
  vy: number;
  onGround: boolean;
}

export interface MoveInput {
  seq: number;
  dt: number;
  moveX: number; // strafe: -1..1
  moveZ: number; // forward: -1..1
  jump: boolean;
  yaw: number;
}

const EPS = 1e-4;

/** Broad-phase: test the player AABB only against the grid cells it overlaps. */
function boxCollides(isSolid: IsSolidFn, x: number, y: number, z: number): boolean {
  const x0 = Math.floor(x - PLAYER_HALF_W);
  const x1 = Math.floor(x + PLAYER_HALF_W);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + PLAYER_HEIGHT - EPS);
  const z0 = Math.floor(z - PLAYER_HALF_W);
  const z1 = Math.floor(z + PLAYER_HALF_W);
  for (let bx = x0; bx <= x1; bx++) {
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        if (isSolid(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

/**
 * Deterministic axis-separated AABB step. Runs on the client for prediction
 * and on the server for authority — identical results for identical inputs.
 */
export function stepPlayer(p: PlayerPhysics, input: MoveInput, isSolid: IsSolidFn): void {
  const dt = Math.min(Math.max(input.dt, 0), MAX_STEP_DT);
  if (dt === 0) return;

  let mx = input.moveX;
  let mz = input.moveZ;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  const vx = (mx * cos - mz * sin) * MOVE_SPEED;
  const vz = (-mz * cos - mx * sin) * MOVE_SPEED;

  if (input.jump && p.onGround) {
    p.vy = JUMP_VELOCITY;
    p.onGround = false;
  }
  p.vy += GRAVITY * dt;

  // X
  let nx = p.x + vx * dt;
  if (boxCollides(isSolid, nx, p.y, p.z)) nx = p.x;
  p.x = nx;

  // Z
  let nz = p.z + vz * dt;
  if (boxCollides(isSolid, p.x, p.y, nz)) nz = p.z;
  p.z = nz;

  // Y
  let ny = p.y + p.vy * dt;
  if (boxCollides(isSolid, p.x, ny, p.z)) {
    if (p.vy < 0) {
      ny = Math.floor(ny) + 1; // snap feet onto block top
      p.onGround = true;
    } else {
      ny = p.y;
    }
    p.vy = 0;
    if (boxCollides(isSolid, p.x, ny, p.z)) ny = p.y; // safety
  } else if (p.vy < 0) {
    p.onGround = false;
  }
  p.y = ny;
}

export interface RayHit {
  x: number;
  y: number;
  z: number;
  nx: number; // face normal of the hit
  ny: number;
  nz: number;
}

/** Amanatides & Woo voxel DDA. Direction must be normalized. */
export function raycastVoxel(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  isSolid: IsSolidFn,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  while (t <= maxDist) {
    if (isSolid(x, y, z)) return { x, y, z, nx, ny, nz };
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return null;
}
