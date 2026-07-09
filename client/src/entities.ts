import * as THREE from 'three';

/**
 * Pooled visuals for server-authoritative entities: coin drops, thrown
 * projectiles (ender pearl / fireball) and armed TNT. Meshes are allocated
 * once and assigned by index each frame from the synced schema maps.
 */
export class EntityRenderer {
  private coins: THREE.Mesh[] = [];
  private projs: THREE.Mesh[] = [];
  private tnts: THREE.Mesh[] = [];
  private spin = 0;

  constructor(scene: THREE.Scene) {
    const coinGeo = new THREE.OctahedronGeometry(0.22);
    const coinMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x5a4300, metalness: 0.6, roughness: 0.3 });
    for (let i = 0; i < 96; i++) {
      const m = new THREE.Mesh(coinGeo, coinMat);
      m.visible = false;
      m.castShadow = true;
      scene.add(m);
      this.coins.push(m);
    }

    const pearlMat = new THREE.MeshStandardMaterial({ color: 0x1fe0a0, emissive: 0x0a5a44, roughness: 0.4 });
    const fireMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff4400, emissiveIntensity: 1.2, roughness: 0.5 });
    const projGeo = new THREE.SphereGeometry(0.28, 10, 8);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(projGeo, i % 2 === 0 ? pearlMat : fireMat);
      m.visible = false;
      scene.add(m);
      this.projs.push(m);
    }
    // store both materials for reassignment
    this.pearlMat = pearlMat;
    this.fireMat = fireMat;

    const tntGeo = new THREE.BoxGeometry(1, 1, 1);
    const tntMat = new THREE.MeshStandardMaterial({ color: 0xd23b2b, emissive: 0x330000, roughness: 0.7 });
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(tntGeo, tntMat);
      m.visible = false;
      m.castShadow = true;
      scene.add(m);
      this.tnts.push(m);
    }
  }

  private pearlMat!: THREE.Material;
  private fireMat!: THREE.Material;

  sync(state: any, dt: number): void {
    this.spin += dt * 2.5;

    // Coins
    let ci = 0;
    state?.drops?.forEach((d: any) => {
      const m = this.coins[ci++];
      if (!m) return;
      m.visible = true;
      m.position.set(d.x, d.y + 0.5 + Math.sin(this.spin + d.x) * 0.12, d.z);
      m.rotation.y = this.spin;
    });
    for (let i = ci; i < this.coins.length; i++) this.coins[i]!.visible = false;

    // Projectiles
    let pi = 0;
    state?.projectiles?.forEach((p: any) => {
      const m = this.projs[pi++];
      if (!m) return;
      m.visible = true;
      m.material = p.kind === 0 ? this.pearlMat : this.fireMat;
      m.position.set(p.x, p.y, p.z);
      m.rotation.y = this.spin * 2;
    });
    for (let i = pi; i < this.projs.length; i++) this.projs[i]!.visible = false;

    // TNT (pulses as the fuse burns)
    let ti = 0;
    const pulse = 1 + Math.sin(this.spin * 6) * 0.06;
    state?.tnts?.forEach((t: any) => {
      const m = this.tnts[ti++];
      if (!m) return;
      m.visible = true;
      m.position.set(t.x, t.y + 0.5, t.z);
      m.scale.setScalar(pulse);
    });
    for (let i = ti; i < this.tnts.length; i++) this.tnts[i]!.visible = false;
  }
}
