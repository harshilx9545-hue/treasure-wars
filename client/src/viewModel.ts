import * as THREE from 'three';
import { WeaponId, WEAPONS } from '@bedwars/shared';
import { weaponModels } from './weaponModels';

/**
 * First-person view model attached to the camera. Renders the active weapon
 * GLB (or a held block) and plays procedural, keyframed 3D attack animations.
 *
 * The weapons are single-mesh GLBs (no skeleton), so a natural swing is faked
 * the way film rigs do it: the model hangs off an OFFSET PIVOT (a virtual
 * shoulder / wrist). Rotating that pivot sweeps the blade or tip through a wide
 * arc in 3D space — carving through depth instead of spinning flat in front of
 * the lens. Each attack is a small keyframed clip with anticipation, a fast
 * strike, follow-through overshoot and an eased recovery, plus camera recoil,
 * view-driven inertia (secondary motion) and white motion-blur trails.
 *
 * Scene graph (all cosmetic; combat/networking untouched):
 *   camera → root → weaponHolder (hand: idle/bob/equip/inertia/bow-draw)
 *                     → swingPivot (offset pivot + keyframed swing arc)
 *                         → weapon model (+ nocked arrow for the bow)
 */

const HALF_PI = Math.PI / 2;
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const smoother = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10); // C2 smoothstep
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** One animation keyframe: pivot position offset + euler rotation at time t (0..1). */
interface Key { t: number; px: number; py: number; pz: number; rx: number; ry: number; rz: number; }

// --- Attack clips (authored as keyframes; read like real animation tracks) ---

// Sword: diagonal shoulder slash — cock up-right, sweep down-left, follow through.
const SLASH: Key[] = [
  { t: 0.00, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
  { t: 0.16, px: 0.03, py: 0.05, pz: 0.06, rx: 0.38, ry: 0.42, rz: -0.30 }, // anticipation
  { t: 0.40, px: -0.06, py: -0.02, pz: -0.12, rx: -1.00, ry: -0.55, rz: 0.55 }, // strike
  { t: 0.58, px: -0.05, py: -0.03, pz: -0.08, rx: -1.20, ry: -0.78, rz: 0.38 }, // follow-through
  { t: 1.00, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }, // recovery
];
// Axe: heavy diagonal overhead chop — big wind-up, weighty drop, slow recover.
const CHOP: Key[] = [
  { t: 0.00, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
  { t: 0.24, px: 0.02, py: 0.10, pz: 0.10, rx: 0.72, ry: 0.18, rz: -0.14 }, // overhead wind-up
  { t: 0.46, px: -0.04, py: -0.06, pz: -0.12, rx: -1.38, ry: -0.28, rz: 0.16 }, // heavy chop
  { t: 0.60, px: -0.03, py: -0.07, pz: -0.10, rx: -1.55, ry: -0.34, rz: 0.10 }, // follow-through
  { t: 1.00, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }, // heavy recovery
];
// Spear: straight thrust — cock back, drive the tip deep into the world, pull back.
const THRUST: Key[] = [
  { t: 0.00, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
  { t: 0.16, px: 0.02, py: 0.03, pz: 0.16, rx: 0.14, ry: 0, rz: 0.06 }, // anticipation (pull back)
  { t: 0.38, px: 0.0, py: -0.02, pz: -0.62, rx: -0.05, ry: 0, rz: -0.05 }, // thrust — tip leads forward
  { t: 0.52, px: 0.0, py: -0.02, pz: -0.66, rx: -0.03, ry: 0, rz: -0.03 }, // full extension
  { t: 1.00, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }, // smooth pull back
];

type SwingKind = 'slash' | 'chop' | 'thrust' | 'none';

interface Recoil { pitch: number; roll: number; fwd: number; }

export class ViewModel {
  private camera: THREE.Camera;
  private root = new THREE.Group();
  private weaponHolder = new THREE.Group(); // "hand" — base pose, inertia, bow draw
  private swingPivot = new THREE.Group();   // offset pivot the weapon swings around
  private block: THREE.Mesh;
  private blockMat: THREE.MeshLambertMaterial;

  private slashTrail: THREE.Mesh;
  private thrustTrail: THREE.Mesh;
  private nockedArrow: THREE.Object3D | null = null;
  private builtModel: THREE.Object3D | null = null;

  private mode: 'weapon' | 'block' = 'weapon';
  private currentWeapon: WeaponId | null = null;
  private pendingWeapon: WeaponId | null = null;
  private pivot = new THREE.Vector3(); // current weapon's swing-pivot offset

  private swingT = 0;      // 1 -> 0 over the course of a swing
  private swingKind: SwingKind = 'none';
  private swingCrit = false;
  private hitStop = 0;     // brief freeze at the moment of impact
  private mining = false;
  private placeT = 0;
  private equipT = 0;
  private blocking = false;
  private bowCharge = 0;   // visual draw 0..1 (not the networked charge)
  private bowReleaseT = 0;
  private bob = 0;
  private breath = 0;

  // Camera recoil impulse (read by the frame loop and added to the view).
  private recoilT = 0;
  private recoil: Recoil = { pitch: 0, roll: 0, fwd: 0 };

  // View-driven inertia (secondary motion): the weapon lags fast camera turns.
  private lastYaw = 0;
  private lastPitch = 0;
  private haveLastView = false;
  private swayX = 0;
  private swayY = 0;

  private restPos = new THREE.Vector3(0, 0, 0);
  private restRot = new THREE.Euler(0, 0, 0);

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    this.blockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.block = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), this.blockMat);
    this.block.position.set(0.42, -0.4, -0.7);
    this.block.rotation.set(0.2, 0.6, 0);
    this.block.visible = false;

    const trailMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    this.slashTrail = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.66, 30, 1, Math.PI * 0.1, Math.PI * 1.0), trailMat.clone());
    this.slashTrail.position.set(0.05, -0.2, -0.72);
    this.slashTrail.renderOrder = 999;
    this.slashTrail.visible = false;
    this.thrustTrail = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 1.0), trailMat.clone());
    this.thrustTrail.position.set(0.18, -0.3, -1.0);
    this.thrustTrail.renderOrder = 999;
    this.thrustTrail.visible = false;

    this.weaponHolder.add(this.swingPivot, this.slashTrail, this.thrustTrail);
    this.root.add(this.weaponHolder, this.block);
    camera.add(this.root);

    weaponModels.onReady(() => {
      if (this.pendingWeapon !== null) this.applyWeapon(this.pendingWeapon);
    });
  }

  setWeapon(id: WeaponId): void {
    this.mode = 'weapon';
    this.block.visible = false;
    if (this.currentWeapon === id && this.builtModel) return;
    if (!weaponModels.ready) { this.pendingWeapon = id; return; }
    this.applyWeapon(id);
  }

  private pivotFor(id: WeaponId): THREE.Vector3 {
    // Virtual joint the weapon rotates about (view space: -z forward, +y up).
    switch (this.swingKindFor(id)) {
      case 'chop': return new THREE.Vector3(-0.06, 0.22, 0.08); // high shoulder (overhead)
      case 'slash': return new THREE.Vector3(-0.12, 0.15, 0.10); // shoulder
      case 'thrust': return new THREE.Vector3(0.02, -0.02, 0.14); // wrist, back toward camera
      default: return new THREE.Vector3(0, 0, 0);
    }
  }

  private swingKindFor(id: WeaponId): SwingKind {
    const def = WEAPONS[id];
    if (def.ranged || def.shield) return 'none';
    if (id === WeaponId.Spear) return 'thrust';
    if (id === WeaponId.Axe || id === WeaponId.DoubleAxe) return 'chop';
    return 'slash';
  }

  private applyWeapon(id: WeaponId): void {
    this.pendingWeapon = null;
    this.currentWeapon = id;
    this.swingPivot.clear();
    this.nockedArrow = null;
    this.builtModel = null;

    const model = weaponModels.buildFP(id);
    if (model) {
      // Hang the model off the pivot: pivot sits at the joint, model is
      // counter-offset so the rest pose is identical, then rotating the pivot
      // swings the weapon head through a true 3D arc.
      this.pivot.copy(this.pivotFor(id));
      model.position.set(-this.pivot.x, -this.pivot.y, -this.pivot.z);
      this.swingPivot.add(model);
      this.builtModel = model;
    }
    this.swingPivot.position.copy(this.pivot);
    this.swingPivot.rotation.set(0, 0, 0);

    if (WEAPONS[id].ranged) {
      const arrow = weaponModels.buildArrow();
      if (arrow) {
        arrow.scale.multiplyScalar(0.9);
        arrow.position.set(0, 0.02, 0.12 - this.pivot.z);
        arrow.rotation.set(HALF_PI, 0, 0);
        arrow.visible = false;
        this.swingPivot.add(arrow);
        this.nockedArrow = arrow;
      }
    }
    this.weaponHolder.visible = this.mode === 'weapon';
    this.equipT = 1;
  }

  setBlock(color: number): void {
    this.mode = 'block';
    this.weaponHolder.visible = false;
    this.block.visible = true;
    this.blockMat.color.setHex(color);
    this.equipT = 1;
  }

  swing(crit = false): void {
    if (this.mode === 'weapon' && this.currentWeapon !== null) {
      const def = WEAPONS[this.currentWeapon];
      if (def.ranged || def.shield) return; // bows/shields don't swing
      this.swingKind = this.swingKindFor(this.currentWeapon);
    } else {
      this.swingKind = 'slash';
    }
    this.swingT = 1;
    this.swingCrit = crit;
    this.hitStop = 0;
    // Camera recoil: a kick when the swing fires (impact adds more).
    if (this.swingKind === 'chop') this.punch(0.055, 0.02, 0);
    else if (this.swingKind === 'thrust') this.punch(0.02, 0, 0.06);
    else this.punch(0.03, 0.02, 0);
  }

  /** Loose the bow: hide the nocked arrow, snap forward, recoil the camera. */
  releaseBow(): void {
    this.bowReleaseT = 1;
    this.bowCharge = 0;
    if (this.nockedArrow) this.nockedArrow.visible = false;
    this.punch(0.03, 0, 0);
  }

  /** Brief hit-pause + extra camera recoil when the local blow lands. */
  impact(heavy = false): void {
    this.hitStop = heavy ? 0.09 : 0.05;
    this.punch(heavy ? 0.05 : 0.03, heavy ? 0.02 : 0.012, 0);
  }

  private punch(pitch: number, roll: number, fwd: number): void {
    this.recoilT = 1;
    this.recoil.pitch = pitch;
    this.recoil.roll = (Math.random() < 0.5 ? -1 : 1) * roll;
    this.recoil.fwd = fwd;
  }

  /** Camera recoil for this frame — added to the view by the frame loop. */
  getCameraRecoil(): Recoil {
    const e = easeOutCubic(this.recoilT);
    return { pitch: this.recoil.pitch * e, roll: this.recoil.roll * e, fwd: this.recoil.fwd * e };
  }

  setMining(on: boolean): void { this.mining = on; }
  place(): void { this.placeT = 1; }
  setBlocking(on: boolean): void { this.blocking = on; }
  setBowCharge(c: number): void { this.bowCharge = Math.max(0, Math.min(1, c)); }

  private sample(track: Key[], p: number, out: Key): void {
    if (p <= track[0].t) { Object.assign(out, track[0]); return; }
    const last = track[track.length - 1];
    if (p >= last.t) { Object.assign(out, last); return; }
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i], b = track[i + 1];
      if (p >= a.t && p < b.t) {
        const lt = smoother((p - a.t) / (b.t - a.t)); // eased local time
        out.px = lerp(a.px, b.px, lt); out.py = lerp(a.py, b.py, lt); out.pz = lerp(a.pz, b.pz, lt);
        out.rx = lerp(a.rx, b.rx, lt); out.ry = lerp(a.ry, b.ry, lt); out.rz = lerp(a.rz, b.rz, lt);
        return;
      }
    }
    Object.assign(out, last);
  }

  private kf: Key = { t: 0, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };

  update(dt: number, walking: boolean, sprinting: boolean, onGround: boolean): void {
    this.weaponHolder.visible = this.mode === 'weapon';
    this.block.visible = this.mode === 'block';

    // Decay camera recoil.
    if (this.recoilT > 0) this.recoilT = Math.max(0, this.recoilT - dt * 6);

    // --- Base "hand" pose: walk bob + idle breathing ---
    const bobAmt = walking && onGround ? (sprinting ? 1.4 : 1) : 0;
    this.bob += dt * (bobAmt > 0 ? (sprinting ? 12 : 8) : 0);
    const t = this.bob;
    this.breath += dt;
    const idle = 1 - Math.min(1, bobAmt);
    const breathe = Math.sin(this.breath * 1.6) * idle;
    const sway = Math.sin(this.breath * 0.8) * idle;

    let px = this.restPos.x + Math.sin(t) * 0.02 * bobAmt + sway * 0.004;
    let py = this.restPos.y + Math.abs(Math.cos(t)) * 0.03 * bobAmt + breathe * 0.006;
    let pz = this.restPos.z;
    let rx = this.restRot.x + breathe * 0.01;
    let ry = this.restRot.y + sway * 0.01;
    let rz = this.restRot.z + Math.sin(t) * 0.03 * bobAmt;

    // --- Secondary motion: weapon lags the camera when the view turns fast ---
    const cy = (this.camera as any).rotation?.y ?? 0;
    const cx = (this.camera as any).rotation?.x ?? 0;
    if (this.haveLastView) {
      const dYaw = cy - this.lastYaw;
      const dPitch = cx - this.lastPitch;
      const k = 1 - Math.exp(-dt * 12);
      this.swayX = lerp(this.swayX, Math.max(-0.14, Math.min(0.14, -dYaw * 2.4)), k);
      this.swayY = lerp(this.swayY, Math.max(-0.12, Math.min(0.12, -dPitch * 2.0)), k);
    }
    this.lastYaw = cy; this.lastPitch = cx; this.haveLastView = true;
    ry += this.swayX * 0.7; px += this.swayX * 0.16;
    rx += this.swayY * 0.6; py += this.swayY * 0.12;

    const isRanged = this.mode === 'weapon' && this.currentWeapon !== null && WEAPONS[this.currentWeapon].ranged;
    const isShield = this.mode === 'weapon' && this.currentWeapon !== null && WEAPONS[this.currentWeapon].shield;

    // Mining chop (light repetitive tap when no attack swing is playing).
    if (this.mining && this.swingT <= 0) {
      const m = Math.abs(Math.sin(performance.now() * 0.012));
      rx -= m * 0.6; py -= m * 0.04;
    }

    // --- Attack swing: keyframed arc on the offset pivot ---
    this.slashTrail.visible = false;
    this.thrustTrail.visible = false;
    if (this.swingT > 0 && this.swingKind !== 'none') {
      if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt); // freeze at impact
      else {
        const speed = this.swingKind === 'thrust' ? 7 : this.swingKind === 'chop' ? 4.6 : 8.4;
        this.swingT = Math.max(0, this.swingT - dt * speed);
      }
      const p = 1 - this.swingT;
      const track = this.swingKind === 'chop' ? CHOP : this.swingKind === 'thrust' ? THRUST : SLASH;
      this.sample(track, p, this.kf);
      const critScale = this.swingCrit ? 1.15 : 1;
      this.swingPivot.position.set(
        this.pivot.x + this.kf.px,
        this.pivot.y + this.kf.py,
        this.pivot.z + this.kf.pz,
      );
      this.swingPivot.rotation.set(this.kf.rx * critScale, this.kf.ry, this.kf.rz * critScale);

      // Motion-blur trail that sweeps with the blade / tip.
      const env = Math.sin(p * Math.PI);
      if (this.swingKind === 'thrust') {
        this.thrustTrail.visible = true;
        (this.thrustTrail.material as THREE.MeshBasicMaterial).opacity = env * 0.55;
        this.thrustTrail.position.z = -0.9 + this.kf.pz;
        this.thrustTrail.scale.setY(0.7 + Math.max(0, -this.kf.pz) * 0.9);
      } else {
        const heavy = this.swingKind === 'chop';
        this.slashTrail.visible = true;
        (this.slashTrail.material as THREE.MeshBasicMaterial).opacity = env * (heavy ? 0.6 : 0.5);
        this.slashTrail.rotation.z = 0.5 - (p - 0.5) * (heavy ? 2.2 : 1.7);
        const ts = heavy ? 1.28 : 1.0;
        this.slashTrail.scale.set(ts, ts, ts);
      }
    } else {
      // Rest: hold the pivot at its neutral offset.
      this.swingPivot.position.copy(this.pivot);
      this.swingPivot.rotation.set(0, 0, 0);
    }

    // Block place push.
    if (this.placeT > 0) {
      this.placeT = Math.max(0, this.placeT - dt * 6);
      const s = Math.sin(this.placeT * Math.PI);
      pz -= s * 0.14; py -= s * 0.05;
    }

    // Shield raise.
    if (isShield && this.blocking) {
      px -= 0.18; py += 0.12; pz += 0.15; ry += 0.5;
    }

    // Bow draw: pull the bow toward the eye, tilt it, draw the nocked arrow back.
    if (isRanged) {
      const c = this.bowCharge;
      if (c > 0) {
        const e = easeOutCubic(c);
        pz += e * 0.16; px -= e * 0.06; py += e * 0.03;
        rz += e * 0.14; rx -= e * 0.05;
        if (this.nockedArrow) {
          this.nockedArrow.visible = true;
          this.nockedArrow.position.z = (0.12 - this.pivot.z) + e * 0.24; // string pulls it back
        }
      } else if (this.nockedArrow && this.bowReleaseT <= 0) {
        this.nockedArrow.visible = false;
      }
      if (this.bowReleaseT > 0) {
        this.bowReleaseT = Math.max(0, this.bowReleaseT - dt * 5);
        const s = Math.sin(this.bowReleaseT * Math.PI);
        pz -= s * 0.18; rx += s * 0.22; // forward snap + recoil
      }
    }

    // Equip slide-in (eased).
    if (this.equipT > 0) {
      this.equipT = Math.max(0, this.equipT - dt * 4);
      const e = this.equipT;
      py -= e * 0.5;
      rx += e * 0.8;
    }

    this.weaponHolder.position.set(px, py, pz);
    this.weaponHolder.rotation.set(rx, ry, rz);
    this.block.position.set(0.42 + px, -0.4 + py, -0.7 + pz);
    this.root.position.copy(this.restPos);
    this.root.rotation.copy(this.restRot);
  }
}
