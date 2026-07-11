import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WEAPONS, WeaponId, type WeaponDef } from '@bedwars/shared';

// Self-contained GLBs (single mesh + embedded atlas texture). Referenced in
// place from /weapons/GLB via Vite ?url imports — no assets are copied.
import sword_1 from '../../weapons/GLB/sword_1.glb?url';
import axe_1 from '../../weapons/GLB/axe_1.glb?url';
import axe_2 from '../../weapons/GLB/axe_2.glb?url';
import axe_3 from '../../weapons/GLB/axe_3.glb?url';
import spear_1 from '../../weapons/GLB/spear_1.glb?url';
import shield_1 from '../../weapons/GLB/shield_1.glb?url';

const URLS: Record<string, string> = { sword_1, axe_1, axe_2, axe_3, spear_1, shield_1 };

const FP_TARGET = 0.55; // normalized max-dimension for first-person weapons
const HAND_TARGET = 0.6; // normalized max-dimension for held (3rd person) weapons

interface Template {
  scene: THREE.Object3D;
  maxDim: number;
}

/**
 * Loads and caches all weapon GLBs once, then hands out lightweight clones
 * with normalized scale + per-weapon transforms (from the shared WEAPONS
 * config). Async, but small/local so it resolves almost immediately.
 */
class WeaponModels {
  private templates = new Map<string, Template>();
  ready = false;
  private waiters: Array<() => void> = [];

  load(): void {
    const loader = new GLTFLoader();
    const files = new Set<string>();
    for (const w of Object.values(WEAPONS)) files.add(w.glb);

    let pending = files.size;
    const done = () => { if (--pending <= 0) { this.ready = true; this.waiters.forEach((w) => w()); this.waiters = []; } };

    for (const file of files) {
      const url = URLS[file];
      if (!url) { console.warn('[bedwars] missing weapon url for', file); done(); continue; }
      loader.load(url, (gltf) => {
        const scene = gltf.scene;
        scene.traverse((o) => { const m = o as THREE.Mesh; if ((m as any).isMesh) m.castShadow = true; });
        const box = new THREE.Box3().setFromObject(scene);
        const size = new THREE.Vector3(); box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const tpl = { scene, maxDim };
        this.templates.set(file, tpl);
        done();
      }, undefined, (err) => { console.error('[bedwars] failed weapon', file, err); done(); });
    }
  }

  onReady(cb: () => void): void {
    if (this.ready) cb(); else this.waiters.push(cb);
  }

  private clone(tpl: Template): THREE.Object3D {
    return tpl.scene.clone(true);
  }

  /** First-person weapon model wrapped in a pivot with its FP transform applied. */
  buildFP(id: WeaponId): THREE.Object3D | null {
    const def = WEAPONS[id];
    const tpl = this.templates.get(def.glb);
    if (!def || !tpl) return null;
    return this.wrap(tpl, def, FP_TARGET, def.fp);
  }

  /** Held weapon model for a remote player's hand bone. */
  buildHand(id: WeaponId): THREE.Object3D | null {
    const def = WEAPONS[id];
    const tpl = this.templates.get(def.glb);
    if (!def || !tpl) return null;
    return this.wrap(tpl, def, HAND_TARGET, def.hand);
  }

  private wrap(tpl: Template, def: WeaponDef, target: number, t: { scale: number; pos: [number, number, number]; rot: [number, number, number] }): THREE.Object3D {
    const pivot = new THREE.Group();
    const model = this.clone(tpl);
    const s = (target / tpl.maxDim) * t.scale;
    model.scale.setScalar(s);
    model.position.set(t.pos[0], t.pos[1], t.pos[2]);
    model.rotation.set(t.rot[0], t.rot[1], t.rot[2]);
    pivot.add(model);
    void def;
    return pivot;
  }
}

export const weaponModels = new WeaponModels();
