import * as THREE from 'three';

const MAX_COINS = 96;
const MAX_PROJECTILES = 24;
const MAX_TNT = 16;

/**
 * Batched server-entity visuals. The old implementation kept a separate Mesh
 * for every coin, projectile and TNT entity (up to 136 draw calls). These
 * pools retain the same visuals but reduce the live scene to five instanced
 * draw calls and avoid allocating objects while state is synchronized.
 */
export class EntityRenderer {
  private readonly dummy = new THREE.Object3D();
  private readonly coins: THREE.InstancedMesh;
  private readonly pearls: THREE.InstancedMesh;
  private readonly fireballs: THREE.InstancedMesh;
  private readonly arrows: THREE.InstancedMesh;
  private readonly tnts: THREE.InstancedMesh;
  private spin = 0;

  constructor(scene: THREE.Scene) {
    const coinGeo = new THREE.OctahedronGeometry(0.22);
    const coinMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x5a4300, metalness: 0.6, roughness: 0.3 });
    this.coins = this.makeInstanced(coinGeo, coinMat, MAX_COINS, true);

    const projGeo = new THREE.SphereGeometry(0.28, 10, 8);
    this.pearls = this.makeInstanced(projGeo, new THREE.MeshStandardMaterial({ color: 0x1fe0a0, emissive: 0x0a5a44, roughness: 0.4 }), MAX_PROJECTILES, false);
    this.fireballs = this.makeInstanced(projGeo, new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff4400, emissiveIntensity: 1.2, roughness: 0.5 }), MAX_PROJECTILES, false);
    this.arrows = this.makeInstanced(projGeo, new THREE.MeshStandardMaterial({ color: 0x9b6232, metalness: 0.15, roughness: 0.75 }), MAX_PROJECTILES, false);

    const tntGeo = new THREE.BoxGeometry(1, 1, 1);
    this.tnts = this.makeInstanced(tntGeo, new THREE.MeshStandardMaterial({ color: 0xd23b2b, emissive: 0x330000, roughness: 0.7 }), MAX_TNT, true);

    scene.add(this.coins, this.pearls, this.fireballs, this.arrows, this.tnts);
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, max: number, castShadow: boolean): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.count = 0;
    mesh.castShadow = castShadow;
    // These entities move frequently and each batch is only one draw call;
    // recalculating a dynamic aggregate bounds sphere costs more than it saves.
    mesh.frustumCulled = false;
    return mesh;
  }

  private write(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, scale = 1): void {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(0, this.spin, 0);
    this.dummy.scale.setScalar(scale);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  sync(state: any, dt: number): void {
    this.spin += dt * 2.5;

    let coins = 0;
    state?.drops?.forEach((d: any) => {
      if (coins >= MAX_COINS) return;
      this.write(this.coins, coins++, d.x, d.y + 0.5 + Math.sin(this.spin + d.x) * 0.12, d.z);
    });
    this.coins.count = coins;
    this.coins.instanceMatrix.needsUpdate = true;

    let pearls = 0; let fireballs = 0; let arrows = 0;
    state?.projectiles?.forEach((p: any) => {
      const mesh = p.kind === 0 ? this.pearls : p.kind === 2 ? this.arrows : this.fireballs;
      const i = p.kind === 0 ? pearls++ : p.kind === 2 ? arrows++ : fireballs++;
      if (i >= MAX_PROJECTILES) return;
      this.write(mesh, i, p.x, p.y, p.z);
    });
    this.pearls.count = Math.min(pearls, MAX_PROJECTILES);
    this.fireballs.count = Math.min(fireballs, MAX_PROJECTILES);
    this.arrows.count = Math.min(arrows, MAX_PROJECTILES);
    this.pearls.instanceMatrix.needsUpdate = true;
    this.fireballs.instanceMatrix.needsUpdate = true;
    this.arrows.instanceMatrix.needsUpdate = true;

    let tnts = 0;
    const pulse = 1 + Math.sin(this.spin * 6) * 0.06;
    state?.tnts?.forEach((t: any) => {
      if (tnts >= MAX_TNT) return;
      this.write(this.tnts, tnts++, t.x, t.y + 0.5, t.z, pulse);
    });
    this.tnts.count = tnts;
    this.tnts.instanceMatrix.needsUpdate = true;
  }
}
