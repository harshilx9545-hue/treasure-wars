import * as THREE from 'three';
import { TEAMS } from '@bedwars/shared';

const MAX_PLAYERS = 16;

interface Slot {
  group: THREE.Group;
  body: THREE.Mesh;
}

interface Entry extends Slot {
  tx: number;
  ty: number;
  tz: number;
  tyaw: number;
  fresh: boolean;
}

/**
 * Fixed pool of remote player models (body + head) allocated once at load —
 * no runtime Mesh/Geometry/Material creation. Positions/yaw are smoothed
 * toward the latest server state.
 */
export class RemotePlayers {
  private pool: Slot[] = [];
  private active = new Map<string, Entry>();
  private teamMats = TEAMS.map((t) => new THREE.MeshLambertMaterial({ color: t.color }));
  private headMat = new THREE.MeshLambertMaterial({ color: 0xd8a06a });
  private bodyGeo = new THREE.BoxGeometry(0.6, 1.2, 0.35);
  private headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeo, this.teamMats[0]);
      body.position.y = 0.6;
      const head = new THREE.Mesh(this.headGeo, this.headMat);
      head.position.y = 1.5;
      group.add(body, head);
      group.visible = false;
      scene.add(group);
      this.pool.push({ group, body });
    }
  }

  has(id: string): boolean {
    return this.active.has(id);
  }

  add(id: string, team: number): void {
    const slot = this.pool.pop();
    if (!slot) return;
    slot.body.material = this.teamMats[team % this.teamMats.length];
    slot.group.visible = true;
    this.active.set(id, { ...slot, tx: 0, ty: 0, tz: 0, tyaw: 0, fresh: true });
  }

  updateTarget(id: string, x: number, y: number, z: number, yaw: number, visible: boolean): void {
    const e = this.active.get(id);
    if (!e) return;
    e.tx = x;
    e.ty = y;
    e.tz = z;
    e.tyaw = yaw;
    e.group.visible = visible;
    if (e.fresh) {
      e.group.position.set(x, y, z);
      e.group.rotation.y = yaw;
      e.fresh = false;
    }
  }

  remove(id: string): void {
    const e = this.active.get(id);
    if (!e) return;
    e.group.visible = false;
    this.pool.push({ group: e.group, body: e.body });
    this.active.delete(id);
  }

  prune(seen: Set<string>): void {
    for (const id of [...this.active.keys()]) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-12 * dt);
    this.active.forEach((e) => {
      e.group.position.x += (e.tx - e.group.position.x) * k;
      e.group.position.y += (e.ty - e.group.position.y) * k;
      e.group.position.z += (e.tz - e.group.position.z) * k;
      let d = e.tyaw - e.group.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      e.group.rotation.y += d * k;
    });
  }
}
