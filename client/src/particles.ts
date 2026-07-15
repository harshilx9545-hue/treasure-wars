import * as THREE from 'three';

const MAX = 800;
const OFFSCREEN_Y = -9999;

interface P {
  life: number;
  max: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
}

/**
 * One pooled Points cloud for all transient effects. Active/free typed lists
 * avoid scanning 800 dormant entries every frame, while GPU attributes upload
 * only after data actually changes.
 */
export class Particles {
  private geo = new THREE.BufferGeometry();
  private positions = new Float32Array(MAX * 3);
  private colors = new Float32Array(MAX * 3);
  private sizes = new Float32Array(MAX);
  private pool: P[] = [];
  private free = new Uint16Array(MAX);
  private active = new Uint16Array(MAX);
  private freeCount = MAX;
  private activeCount = 0;
  private positionAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;
  private positionDirty = false;
  private colorDirty = false;
  private points: THREE.Points;
  private tmp = new THREE.Color();

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX; i++) {
      this.pool.push({ life: 0, max: 1, vx: 0, vy: 0, vz: 0, gravity: 0 });
      this.free[i] = i;
      this.positions[i * 3 + 1] = OFFSCREEN_Y;
    }
    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3);
    this.geo.setAttribute('position', this.positionAttr);
    this.geo.setAttribute('color', this.colorAttr);
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
    scene.add(this.points);
  }

  private spawn(x: number, y: number, z: number, color: number, spread: number, up: number, life: number, gravity: number): void {
    if (this.freeCount === 0) return;
    const i = this.free[--this.freeCount]!;
    this.active[this.activeCount++] = i;
    const p = this.pool[i]!;
    p.life = life;
    p.max = life;
    p.vx = (Math.random() - 0.5) * spread;
    p.vz = (Math.random() - 0.5) * spread;
    p.vy = Math.random() * up;
    p.gravity = gravity;
    const n = i * 3;
    this.positions[n] = x;
    this.positions[n + 1] = y;
    this.positions[n + 2] = z;
    this.tmp.setHex(color);
    this.colors[n] = this.tmp.r;
    this.colors[n + 1] = this.tmp.g;
    this.colors[n + 2] = this.tmp.b;
    this.sizes[i] = 1;
    this.positionDirty = true;
    this.colorDirty = true;
  }

  dust(x: number, y: number, z: number, color: number, count = 14): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, z, color, 3, 3, 0.5 + Math.random() * 0.3, 9);
  }

  hit(x: number, y: number, z: number, count = 12): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, z, 0xff3b3b, 5, 4, 0.4, 12);
  }

  crit(x: number, y: number, z: number, count = 18): void {
    for (let i = 0; i < count; i++) this.spawn(x, y, z, 0xffd23f, 6, 5, 0.5, 8);
  }

  update(dt: number): void {
    let a = 0;
    while (a < this.activeCount) {
      const i = this.active[a]!;
      const p = this.pool[i]!;
      p.life -= dt;
      const n = i * 3;
      if (p.life <= 0) {
        this.positions[n + 1] = OFFSCREEN_Y;
        this.free[this.freeCount++] = i;
        this.active[a] = this.active[--this.activeCount]!;
        this.positionDirty = true;
        continue;
      }
      p.vy -= p.gravity * dt;
      this.positions[n] += p.vx * dt;
      this.positions[n + 1] += p.vy * dt;
      this.positions[n + 2] += p.vz * dt;
      this.positionDirty = true;
      a++;
    }
    if (this.positionDirty) {
      this.positionAttr.needsUpdate = true;
      this.positionDirty = false;
    }
    if (this.colorDirty) {
      this.colorAttr.needsUpdate = true;
      this.colorDirty = false;
    }
  }
}
