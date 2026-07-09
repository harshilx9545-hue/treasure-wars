import * as THREE from 'three';

const STAGES = 10;
const TILE = 16;

/** Build a 10-stage crack texture atlas (transparent with growing black cracks). */
function makeCrackTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TILE * STAGES;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d')!;
  for (let s = 0; s < STAGES; s++) {
    const ox = s * TILE;
    const lines = s + 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    for (let l = 0; l < lines; l++) {
      // Deterministic-ish cracks radiating from center.
      const a = (l / lines) * Math.PI * 2 + s;
      const cx = ox + TILE / 2;
      const cy = TILE / 2;
      const len = 3 + s * 0.9;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.lineTo(cx + Math.cos(a + 0.6) * (len * 0.7), cy + Math.sin(a + 0.6) * (len * 0.7));
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(1 / STAGES, 1);
  return tex;
}

/**
 * Client-side progressive mining. Tracks the block currently being mined,
 * accumulates progress based on block hardness (and a haste multiplier),
 * and drives a crack overlay. Progress resets if the target changes or the
 * player stops holding the mine button.
 */
export class Mining {
  private tex = makeCrackTexture();
  private overlay: THREE.Mesh;
  private key: string | null = null;
  private hardness = 1;
  progress = 0; // 0..1

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.overlay = new THREE.Mesh(new THREE.BoxGeometry(1.01, 1.01, 1.01), mat);
    this.overlay.visible = false;
    scene.add(this.overlay);
  }

  private setStage(stage: number): void {
    this.tex.offset.x = stage / STAGES;
  }

  /** Reset all mining progress and hide the overlay. */
  reset(): void {
    this.key = null;
    this.progress = 0;
    this.overlay.visible = false;
  }

  /**
   * Advance mining for the current frame.
   * @returns true on the frame mining completes (caller should send Break).
   */
  update(
    dt: number,
    target: { x: number; y: number; z: number } | null,
    hardness: number,
    mining: boolean,
    hasteMult: number,
    onTick?: () => void,
  ): boolean {
    if (!mining || !target || !isFinite(hardness)) {
      if (this.progress !== 0) this.reset();
      return false;
    }
    const key = `${target.x},${target.y},${target.z}`;
    if (key !== this.key) {
      this.key = key;
      this.progress = 0;
      this.hardness = hardness;
      this.overlay.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
      this.overlay.visible = true;
    }
    const before = this.progress;
    this.progress += (dt * 1000 * hasteMult) / this.hardness;
    // Periodic mining tick (sound / dust) roughly 3x/sec.
    if (Math.floor(before * 8) !== Math.floor(this.progress * 8)) onTick?.();

    if (this.progress >= 1) {
      this.reset();
      return true;
    }
    this.setStage(Math.min(STAGES - 1, Math.floor(this.progress * STAGES)));
    return false;
  }
}
