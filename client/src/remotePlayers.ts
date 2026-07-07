import * as THREE from 'three';
import { TEAMS, PLAYER_HALF_W, PLAYER_HEIGHT } from '@bedwars/shared';

const MAX_PLAYERS = 16;

interface Entry {
  mesh: THREE.Mesh;
  tx: number;
  ty: number;
  tz: number;
  fresh: boolean;
}

/**
 * Fixed pool of remote player meshes allocated once at load — no runtime
 * Mesh/Geometry/Material creation. Positions are smoothed toward the latest
 * server state (placeholder for snapshot-buffer interpolation).
 */
export class RemotePlayers {
  private pool: THREE.Mesh[] = [];
  private active = new Map<string, Entry>();
  private materials = TEAMS.map((t) => new THREE.MeshBasicMaterial({ color: t.color }));
  private geometry = new THREE.BoxGeometry(PLAYER_HALF_W * 2, PLAYER_HEIGHT, PLAYER_HALF_W * 2);

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.materials[0]);
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push(mesh);
    }
  }

  add(id: string, team: number): void {
    const mesh = this.pool.pop();
    if (!mesh) return;
    mesh.material = this.materials[team % this.materials.length];
    mesh.visible = true;
    this.active.set(id, { mesh, tx: 0, ty: 0, tz: 0, fresh: true });
  }

  updateTarget(id: string, x: number, y: number, z: number): void {
    const e = this.active.get(id);
    if (!e) return;
    e.tx = x;
    e.ty = y;
    e.tz = z;
    if (e.fresh) {
      e.mesh.position.set(x, y + PLAYER_HEIGHT / 2, z);
      e.fresh = false;
    }
  }

  remove(id: string): void {
    const e = this.active.get(id);
    if (!e) return;
    e.mesh.visible = false;
    this.pool.push(e.mesh);
    this.active.delete(id);
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-12 * dt);
    this.active.forEach((e) => {
      e.mesh.position.x += (e.tx - e.mesh.position.x) * k;
      e.mesh.position.y += (e.ty + PLAYER_HEIGHT / 2 - e.mesh.position.y) * k;
      e.mesh.position.z += (e.tz - e.mesh.position.z) * k;
    });
  }
}
