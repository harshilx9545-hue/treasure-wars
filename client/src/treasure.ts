import * as THREE from 'three';
import { VoxelWorld, bedTeam, TEAMS, BASE_Y } from '@bedwars/shared';

/**
 * Visual Treasure chests that replace the beds. Gameplay is unchanged — beds
 * still exist in the voxel grid (invisible, see worldRenderer) and drive all
 * bed logic (health/destroy, bedsAlive bitmask, win/lose, multiplayer sync).
 * This class only renders a chest model at each team's bed and removes it when
 * that team's bed is destroyed.
 *
 * No treasure asset ships with the project, so the chest is built procedurally
 * (wood body + lid, gold trim, team-colored gem) to match the requested look.
 */
export class Treasure {
  private chests = new Map<number, THREE.Group>();
  private gems: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, world: VoxelWorld) {
    // Find each team's bed cells (beds sit around BASE_Y+1, so scan a thin band).
    const beds = new Map<number, { x: number; y: number; z: number }[]>();
    const y0 = Math.max(0, BASE_Y - 1);
    const y1 = Math.min(world.sy - 1, BASE_Y + 3);
    for (let x = 0; x < world.sx; x++) {
      for (let z = 0; z < world.sz; z++) {
        for (let y = y0; y <= y1; y++) {
          const t = bedTeam(world.get(x, y, z));
          if (t < 0) continue;
          let arr = beds.get(t);
          if (!arr) { arr = []; beds.set(t, arr); }
          arr.push({ x, y, z });
        }
      }
    }

    beds.forEach((cells, team) => {
      const color = TEAMS[team].color;
      const chest = this.buildChest(color);
      const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length + 0.5;
      const cz = cells.reduce((s, c) => s + c.z, 0) / cells.length + 0.5;
      const y = cells[0].y; // block bottom == island floor top
      // Orient the long axis along the two bed cells.
      let ry = 0;
      if (cells.length >= 2) {
        const dx = Math.abs(cells[1].x - cells[0].x);
        const dz = Math.abs(cells[1].z - cells[0].z);
        ry = dx >= dz ? 0 : Math.PI / 2;
      }
      chest.position.set(cx, y, cz);
      chest.rotation.y = ry;
      scene.add(chest);
      this.chests.set(team, chest);
    });
  }

  private buildChest(teamColor: number): THREE.Group {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.85 });
    const woodDark = new THREE.MeshStandardMaterial({ color: 0x432b14, roughness: 0.9 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xf5c542, metalness: 0.75, roughness: 0.3, emissive: 0x3a2c00, emissiveIntensity: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 0.55, roughness: 0.4 });

    const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.62, 0.92), wood);
    base.position.y = 0.31; base.castShadow = true; base.receiveShadow = true;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.34, 0.96), woodDark);
    lid.position.y = 0.8; lid.castShadow = true;

    // Gold trim: corner straps + a horizontal band + a front lock.
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.1, 0.98), gold);
    band.position.y = 0.62;
    const strapGeo = new THREE.BoxGeometry(0.1, 1.05, 0.98);
    const strapL = new THREE.Mesh(strapGeo, gold); strapL.position.set(-0.62, 0.5, 0);
    const strapR = new THREE.Mesh(strapGeo, gold); strapR.position.set(0.62, 0.5, 0);
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.1), gold);
    lock.position.set(0, 0.6, 0.5);

    // Team-colored gem on the lid so ownership reads at a glance.
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), accent);
    gem.position.set(0, 1.12, 0);
    this.gems.push(gem);

    g.add(base, lid, band, strapL, strapR, lock, gem);
    return g;
  }

  /** Remove a team's treasure when its bed is destroyed. */
  destroy(team: number): void {
    const c = this.chests.get(team);
    if (!c) return;
    this.removeGems(c);
    c.parent?.remove(c);
    this.disposeObject(c);
    this.chests.delete(team);
  }

  /** Remove every chest (used when the world is rebuilt for a rematch). */
  dispose(): void {
    this.chests.forEach((c) => {
      this.removeGems(c);
      c.parent?.remove(c);
      this.disposeObject(c);
    });
    this.chests.clear();
    this.gems.length = 0;
  }

  private removeGems(root: THREE.Object3D): void {
    this.gems = this.gems.filter((gem) => gem.parent !== root);
  }

  /** Chests are rebuilt on rematch, so release their procedural GPU resources. */
  private disposeObject(root: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as any).isMesh) return;
      geometries.add(mesh.geometry);
      const source = mesh.material;
      if (Array.isArray(source)) for (const m of source) materials.add(m);
      else materials.add(source);
    });
    geometries.forEach((geo) => geo.dispose());
    materials.forEach((mat) => mat.dispose());
  }

  /** Optional idle polish — gently spin the gems. */
  update(dt: number): void {
    for (const gem of this.gems) gem.rotation.y += dt * 1.5;
  }
}
