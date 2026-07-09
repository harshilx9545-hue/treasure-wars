import * as THREE from 'three';

const MAX = 800;

interface P {
  life: number;
  max: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
}

/**
 * Single pooled THREE.Points cloud for every transient effect (block dust,
 * hit sparks, crit stars). No per-particle allocation at runtime.
 */
export class Particles {
  private geo = new THREE.BufferGeometry();
  private positions = new Float32Array(MAX * 3);
  private colors = new Float32Array(MAX * 3);
  private sizes = new Float32Array(MAX);
  private pool: P[] = [];
  private points: THREE.Points;
  private tmp = new THREE.Color();

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX; i++) this.pool.push({ life: 0, max: 1, vx: 0, vy: 0, vz: 0, gravity: 0 });
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    const mat = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    // Start every particle offscreen/dead.
    for (let i = 0; i < MAX; i++) this.positions[i * 3 + 1] = -9999;
    scene.add(this.points);
  }

  private spawn(x: number, y: number, z: number, color: number, spread: number, up: number, life: number, gravity: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.pool[i].life > 0) continue;
      const p = this.pool[i];
      p.life = life;
      p.max = life;
      p.vx = (Math.random() - 0.5) * spread;
      p.vz = (Math.random() - 0.5) * spread;
      p.vy = Math.random() * up;
      p.gravity = gravity;
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
      this.tmp.setHex(color);
      this.colors[i * 3] = this.tmp.r;
      this.colors[i * 3 + 1] = this.tmp.g;
      this.colors[i * 3 + 2] = this.tmp.b;
      this.sizes[i] = 1;
      return;
    }
  }

  /** Dust burst when a block is mined / broken. */
  dust(x: number, y: number, z: number, color: number, count = 14): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, z, color, 3, 3, 0.5 + Math.random() * 0.3, 9);
  }

  /** Red sparks on a melee hit. */
  hit(x: number, y: number, z: number, count = 12): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, z, 0xff3b3b, 5, 4, 0.4, 12);
  }

  /** Golden stars on a critical hit. */
  crit(x: number, y: number, z: number, count = 18): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, z, 0xffd23f, 6, 5, 0.5, 8);
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      const p = this.pool[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.positions[i * 3 + 1] = -9999;
        continue;
      }
      p.vy -= p.gravity * dt;
      this.positions[i * 3] += p.vx * dt;
      this.positions[i * 3 + 1] += p.vy * dt;
      this.positions[i * 3 + 2] += p.vz * dt;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
