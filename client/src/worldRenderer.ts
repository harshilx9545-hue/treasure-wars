import * as THREE from 'three';
import { VoxelWorld, CHUNK, BlockType } from '@bedwars/shared';
import type { Atlas } from './atlas';

// Face corners: [x, y, z, u, v]; two triangles per visible face.
const FACES: { dir: [number, number, number]; shade: number; corners: [number, number, number, number, number][] }[] = [
  { dir: [-1, 0, 0], shade: 0.80, corners: [[0, 1, 0, 0, 1], [0, 0, 0, 0, 0], [0, 1, 1, 1, 1], [0, 0, 1, 1, 0]] },
  { dir: [1, 0, 0], shade: 0.80, corners: [[1, 1, 1, 0, 1], [1, 0, 1, 0, 0], [1, 1, 0, 1, 1], [1, 0, 0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.55, corners: [[1, 0, 1, 1, 0], [0, 0, 1, 0, 0], [1, 0, 0, 1, 1], [0, 0, 0, 0, 1]] },
  { dir: [0, 1, 0], shade: 1.00, corners: [[0, 1, 1, 1, 1], [1, 1, 1, 0, 1], [0, 1, 0, 1, 0], [1, 1, 0, 0, 0]] },
  { dir: [0, 0, -1], shade: 0.70, corners: [[1, 0, 0, 0, 0], [0, 0, 0, 1, 0], [1, 1, 0, 0, 1], [0, 1, 0, 1, 1]] },
  { dir: [0, 0, 1], shade: 0.70, corners: [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [0, 1, 1, 0, 1], [1, 1, 1, 1, 1]] },
];

function buildChunkGeometry(world: VoxelWorld, cx: number, cz: number, atlas: Atlas): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) {
    for (let z = cz * CHUNK; z < (cz + 1) * CHUNK; z++) {
      for (let y = 0; y < world.sy; y++) {
        const b = world.get(x, y, z);
        if (b === BlockType.Air) continue;
        const tile = atlas.tileIndex(b);
        const u0 = tile / atlas.tiles;
        const uw = 1 / atlas.tiles;
        for (const f of FACES) {
          // Hidden-face culling: only emit faces exposed to air.
          if (world.get(x + f.dir[0], y + f.dir[1], z + f.dir[2]) !== BlockType.Air) continue;
          const ndx = positions.length / 3;
          for (const c of f.corners) {
            positions.push(x + c[0], y + c[1], z + c[2]);
            uvs.push(u0 + c[3] * uw, c[4]);
            colors.push(f.shade, f.shade, f.shade);
          }
          indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3);
        }
      }
    }
  }

  if (indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere(); // enables frustum culling per chunk
  return geo;
}

/**
 * Merged BufferGeometry per 16x16 chunk column, one shared atlas material.
 * Never one Mesh per block. Dirty chunks are remeshed within a per-frame
 * budget so bursts of block changes can't spike the frame.
 */
export class WorldRenderer {
  private meshes = new Map<string, THREE.Mesh>();
  private dirty = new Set<string>();
  private material: THREE.MeshBasicMaterial;

  constructor(
    private scene: THREE.Scene,
    readonly world: VoxelWorld,
    private atlas: Atlas,
  ) {
    this.material = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true });
  }

  markAllDirty(): void {
    const nx = Math.ceil(this.world.sx / CHUNK);
    const nz = Math.ceil(this.world.sz / CHUNK);
    for (let cx = 0; cx < nx; cx++) for (let cz = 0; cz < nz; cz++) this.dirty.add(`${cx},${cz}`);
  }

  setBlock(x: number, y: number, z: number, b: number): void {
    this.world.set(x, y, z, b);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    this.dirty.add(`${cx},${cz}`);
    // Border blocks also expose/hide faces in neighbor chunks.
    if (x % CHUNK === 0) this.dirty.add(`${cx - 1},${cz}`);
    if (x % CHUNK === CHUNK - 1) this.dirty.add(`${cx + 1},${cz}`);
    if (z % CHUNK === 0) this.dirty.add(`${cx},${cz - 1}`);
    if (z % CHUNK === CHUNK - 1) this.dirty.add(`${cx},${cz + 1}`);
  }

  update(budget = 4): void {
    for (const key of this.dirty) {
      if (budget-- <= 0) break;
      this.dirty.delete(key);
      this.remesh(key);
    }
  }

  private remesh(key: string): void {
    const [cx, cz] = key.split(',').map(Number);
    if (cx < 0 || cz < 0 || cx >= Math.ceil(this.world.sx / CHUNK) || cz >= Math.ceil(this.world.sz / CHUNK)) return;
    const geo = buildChunkGeometry(this.world, cx, cz, this.atlas);
    let mesh = this.meshes.get(key);
    if (!geo) {
      if (mesh) {
        mesh.geometry.dispose();
        this.scene.remove(mesh);
        this.meshes.delete(key);
      }
      return;
    }
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new THREE.Mesh(geo, this.material);
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.meshes.set(key, mesh);
    }
  }
}
