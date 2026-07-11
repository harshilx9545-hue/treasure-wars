import * as THREE from 'three';
import { WeaponId, WEAPONS } from '@bedwars/shared';
import { weaponModels } from './weaponModels';

/**
 * First-person weapon RIG (not a camera-space sprite rotation).
 *
 * Hierarchy — exactly as a real FP rig:
 *
 *   camera
 *     └── weaponRoot   whole-rig motion: idle bob, breathing, equip, bow draw,
 *          │           inertia/secondary sway, thrust lunge
 *          └── handRoot   the HAND — the swing pivot. All attack arcs happen
 *               │         here: it translates (raise / drop / thrust) AND
 *               │         rotates (pitch/yaw) so the hand DRIVES the weapon.
 *               └── rightHand   grip / wrist twist
 *                    └── weapon (GLB), offset so the handle sits at the hand
 *                                and the blade/tip extends far out in front.
 *
 * The pivot is at the hand, and the weapon head is offset well away from it, so
 * rotating handRoot makes the TIP travel through a big 3D arc while the handle
 * stays put — never a spin about the mesh centre. Attacks are keyframed with
 * anticipation → acceleration → follow-through → recovery, driven mostly by
 * translation + pitch/yaw (roll is kept tiny to avoid the flat-spin look).
 *
 * Purely cosmetic — combat, damage, reach and networking are untouched.
 */

const HALF_PI = Math.PI / 2;
// The virtual hand/grip position in view space (right, low, close to camera).
// The weapon extends up-and-forward from here, giving the tip a long lever arm.
const HAND = new THREE.Vector3(0.30, -0.50, -0.35);

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const smoother = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10); // C2 smoothstep
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Attack keyframe. rx/ry/rz = HAND rotation (radians); tx/ty/tz = HAND
 * translation (metres). Rotation is pitch/yaw-dominated; translation supplies
 * the raise / drop / thrust so the weapon moves through real space.
 */
interface Key { t: number; rx: number; ry: number; rz: number; tx: number; ty: number; tz: number; }

// Sword — diagonal shoulder slash: cock up-right, sweep down-left, follow through.
const SLASH: Key[] = [
  { t: 0.00, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 },
  { t: 0.15, rx: 0.52, ry: 0.46, rz: -0.10, tx: 0.05, ty: 0.13, tz: 0.07 },   // anticipation
  { t: 0.38, rx: -0.98, ry: -0.58, rz: 0.12, tx: -0.11, ty: -0.11, tz: -0.12 }, // strike (accel)
  { t: 0.56, rx: -1.22, ry: -0.84, rz: 0.08, tx: -0.17, ty: -0.15, tz: -0.06 }, // follow-through
  { t: 1.00, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 },                        // recovery
];
// Axe — huge overhead: raise ABOVE the camera, then drop diagonally in a big arc.
const CHOP: Key[] = [
  { t: 0.00, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 },
  { t: 0.26, rx: 1.05, ry: 0.14, rz: -0.05, tx: 0.03, ty: 0.30, tz: 0.12 },     // overhead wind-up
  { t: 0.48, rx: -1.55, ry: -0.30, rz: 0.06, tx: -0.09, ty: -0.17, tz: -0.14 }, // heavy diagonal drop
  { t: 0.63, rx: -1.78, ry: -0.36, rz: 0.03, tx: -0.11, ty: -0.22, tz: -0.07 }, // follow-through
  { t: 1.00, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 },                        // heavy recovery
];
// Spear — pull back + down + wrist twist, then DRIVE forward on Z (tip ~1m out).
const THRUST: Key[] = [
  { t: 0.00, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 },
  { t: 0.16, rx: 0.16, ry: 0, rz: 0.12, tx: 0.02, ty: -0.05, tz: 0.16 },   // anticipation (pull back)
  { t: 0.40, rx: -0.10, ry: 0, rz: -0.05, tx: 0.0, ty: -0.04, tz: -0.72 }, // thrust forward on Z
  { t: 0.52, rx: -0.08, ry: 0, rz: -0.03, tx: 0.0, ty: -0.04, tz: -0.76 }, // full extension
  { t: 1.00, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 },                   // smooth retract
];

type SwingKind = 'slash' | 'chop' | 'thrust' | 'none';
interface Recoil { pitch: number; roll: number; fwd: number; }

export class ViewModel {
  private camera: THREE.Camera;
  private weaponRoot = new THREE.Group(); // whole-rig motion (child of camera)
  private handRoot = new THREE.Group();   // the hand — swing pivot
  private rightHand = new THREE.Group();  // grip / wrist
  private block: THREE.Mesh;
  private blockMat: THREE.MeshLambertMaterial;

  private slashTrail: THREE.Mesh;
  private thrustTrail: THREE.Mesh;
  private nockedArrow: THREE.Object3D | null = null;
  private builtModel: THREE.Object3D | null = null;

  private mode: 'weapon' | 'block' = 'weapon';
  private currentWeapon: WeaponId | null = null;
  private pendingWeapon: WeaponId | null = null;

  private swingT = 0;
  private swingKind: SwingKind = 'none';
  private swingCrit = false;
  private hitStop = 0;
  private mining = false;
  private placeT = 0;
  private equipT = 0;
  private blocking = false;
  private bowCharge = 0;
  private bowReleaseT = 0;
  private bob = 0;
  private breath = 0;

  private recoilT = 0;
  private recoil: Recoil = { pitch: 0, roll: 0, fwd: 0 };

  // Secondary motion: the rig lags fast view turns, then settles.
  private lastYaw = 0;
  private lastPitch = 0;
  private haveLastView = false;
  private swayX = 0;
  private swayY = 0;

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
    this.slashTrail = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.7, 30, 1, Math.PI * 0.08, Math.PI * 1.05), trailMat.clone());
    this.slashTrail.position.set(0.05, -0.2, -0.72);
    this.slashTrail.renderOrder = 999;
    this.slashTrail.visible = false;
    this.thrustTrail = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 1.1), trailMat.clone());
    this.thrustTrail.position.set(0.2, -0.32, -1.05);
    this.thrustTrail.renderOrder = 999;
    this.thrustTrail.visible = false;

    // Build the rig chain: camera → weaponRoot → handRoot → rightHand.
    this.handRoot.position.copy(HAND);   // pivot at the hand
    this.handRoot.add(this.rightHand);
    this.weaponRoot.add(this.handRoot, this.slashTrail, this.thrustTrail, this.block);
    camera.add(this.weaponRoot);

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
    this.rightHand.clear();
    this.nockedArrow = null;
    this.builtModel = null;

    // buildFP returns a group with the mesh at its FP position. Counter-offset
    // the whole group by -HAND so, at rest, the mesh lands exactly where it did
    // before — but now it hangs off the hand pivot, so swinging the hand sweeps
    // the tip through a wide arc (handle stays near the hand).
    const model = weaponModels.buildFP(id);
    if (model) {
      model.position.set(-HAND.x, -HAND.y, -HAND.z);
      this.rightHand.add(model);
      this.builtModel = model;
    }
    this.handRoot.position.copy(HAND);
    this.handRoot.rotation.set(0, 0, 0);
    this.rightHand.rotation.set(0, 0, 0);

    if (WEAPONS[id].ranged) {
      const arrow = weaponModels.buildArrow();
      if (arrow) {
        arrow.scale.multiplyScalar(0.95);
        // The rightHand group origin sits at the hand; place the nocked arrow at
        // the bow grip and point it FORWARD (-Z). It slides backward on draw.
        arrow.position.set(0.02, 0.0, -0.2);
        arrow.rotation.set(-HALF_PI, 0, 0); // lie along the shot axis, tip forward
        arrow.visible = false;
        this.rightHand.add(arrow);
        this.nockedArrow = arrow;
      }
    }
    this.weaponRoot.visible = true;
    this.handRoot.visible = this.mode === 'weapon';
    this.equipT = 1;
  }

  setBlock(color: number): void {
    this.mode = 'block';
    this.handRoot.visible = false;
    this.block.visible = true;
    this.blockMat.color.setHex(color);
    this.equipT = 1;
  }

  swing(crit = false): void {
    if (this.mode === 'weapon' && this.currentWeapon !== null) {
      const def = WEAPONS[this.currentWeapon];
      if (def.ranged || def.shield) return;
      this.swingKind = this.swingKindFor(this.currentWeapon);
    } else {
      this.swingKind = 'slash';
    }
    this.swingT = 1;
    this.swingCrit = crit;
    this.hitStop = 0;
    if (this.swingKind === 'chop') this.punch(0.06, 0.015, 0);
    else if (this.swingKind === 'thrust') this.punch(0.02, 0, 0.06);
    else this.punch(0.03, 0.018, 0);
  }

  releaseBow(): void {
    this.bowReleaseT = 1;
    this.bowCharge = 0;
    if (this.nockedArrow) this.nockedArrow.visible = false;
    this.punch(0.03, 0, 0);
  }

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

  getCameraRecoil(): Recoil {
    const e = easeOutCubic(this.recoilT);
    return { pitch: this.recoil.pitch * e, roll: this.recoil.roll * e, fwd: this.recoil.fwd * e };
  }

  setMining(on: boolean): void { this.mining = on; }
  place(): void { this.placeT = 1; }
  setBlocking(on: boolean): void { this.blocking = on; }
  setBowCharge(c: number): void { this.bowCharge = Math.max(0, Math.min(1, c)); }

  private kf: Key = { t: 0, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 };
  private sample(track: Key[], p: number, out: Key): void {
    if (p <= track[0].t) { Object.assign(out, track[0]); return; }
    const last = track[track.length - 1];
    if (p >= last.t) { Object.assign(out, last); return; }
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i], b = track[i + 1];
      if (p >= a.t && p < b.t) {
        const lt = smoother((p - a.t) / (b.t - a.t));
        out.rx = lerp(a.rx, b.rx, lt); out.ry = lerp(a.ry, b.ry, lt); out.rz = lerp(a.rz, b.rz, lt);
        out.tx = lerp(a.tx, b.tx, lt); out.ty = lerp(a.ty, b.ty, lt); out.tz = lerp(a.tz, b.tz, lt);
        return;
      }
    }
    Object.assign(out, last);
  }

  update(dt: number, walking: boolean, sprinting: boolean, onGround: boolean): void {
    this.handRoot.visible = this.mode === 'weapon';
    this.block.visible = this.mode === 'block';

    if (this.recoilT > 0) this.recoilT = Math.max(0, this.recoilT - dt * 6);

    // ---- weaponRoot: whole-rig carry motion (bob, breathing, sway, equip, bow) ----
    const bobAmt = walking && onGround ? (sprinting ? 1.4 : 1) : 0;
    this.bob += dt * (bobAmt > 0 ? (sprinting ? 12 : 8) : 0);
    const t = this.bob;
    this.breath += dt;
    const idle = 1 - Math.min(1, bobAmt);
    const breathe = Math.sin(this.breath * 1.6) * idle;
    const swayIdle = Math.sin(this.breath * 0.8) * idle;

    let px = Math.sin(t) * 0.02 * bobAmt + swayIdle * 0.004;
    let py = Math.abs(Math.cos(t)) * 0.03 * bobAmt + breathe * 0.006;
    let pz = 0;
    let rx = breathe * 0.01;
    let ry = swayIdle * 0.01;
    let rz = Math.sin(t) * 0.03 * bobAmt;

    // Secondary motion: lag fast view turns, then settle back.
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

    // Block place push + shield raise ride on the whole rig.
    if (this.placeT > 0) {
      this.placeT = Math.max(0, this.placeT - dt * 6);
      const s = Math.sin(this.placeT * Math.PI);
      pz -= s * 0.14; py -= s * 0.05;
    }
    if (isShield && this.blocking) { px -= 0.18; py += 0.12; pz += 0.15; ry += 0.5; }

    // Bow: draw the whole rig toward the eye + pull the nocked arrow backward.
    if (isRanged) {
      const c = this.bowCharge;
      if (c > 0) {
        const e = easeOutCubic(c);
        pz += e * 0.16; px -= e * 0.06; py += e * 0.03;
        rz += e * 0.12; rx -= e * 0.05;
        if (this.nockedArrow) {
          this.nockedArrow.visible = true;
          this.nockedArrow.position.z = -0.2 + e * 0.26; // slide backward toward the hand
        }
      } else if (this.nockedArrow && this.bowReleaseT <= 0) {
        this.nockedArrow.visible = false;
      }
      if (this.bowReleaseT > 0) {
        this.bowReleaseT = Math.max(0, this.bowReleaseT - dt * 5);
        const s = Math.sin(this.bowReleaseT * Math.PI);
        pz -= s * 0.2; rx += s * 0.22; // snap forward + recoil
      }
    }

    if (this.equipT > 0) {
      this.equipT = Math.max(0, this.equipT - dt * 4);
      py -= this.equipT * 0.5;
      rx += this.equipT * 0.8;
    }

    this.weaponRoot.position.set(px, py, pz);
    this.weaponRoot.rotation.set(rx, ry, rz);

    // ---- handRoot: the swing itself — hand translates + rotates, driving the weapon ----
    this.slashTrail.visible = false;
    this.thrustTrail.visible = false;
    if (this.swingT > 0 && this.swingKind !== 'none') {
      if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);
      else {
        const speed = this.swingKind === 'thrust' ? 7 : this.swingKind === 'chop' ? 4.4 : 8.2;
        this.swingT = Math.max(0, this.swingT - dt * speed);
      }
      const p = 1 - this.swingT;
      const track = this.swingKind === 'chop' ? CHOP : this.swingKind === 'thrust' ? THRUST : SLASH;
      this.sample(track, p, this.kf);
      const cs = this.swingCrit ? 1.12 : 1;
      // Hand translates (raise/drop/thrust) AND rotates (pitch/yaw) about itself.
      this.handRoot.position.set(HAND.x + this.kf.tx, HAND.y + this.kf.ty, HAND.z + this.kf.tz);
      this.handRoot.rotation.set(this.kf.rx * cs, this.kf.ry * cs, this.kf.rz);
      // Slight wrist twist on rightHand (secondary detail, not the main motion).
      this.rightHand.rotation.set(0, 0, this.kf.rz * 0.6);

      const env = Math.sin(p * Math.PI);
      if (this.swingKind === 'thrust') {
        this.thrustTrail.visible = true;
        (this.thrustTrail.material as THREE.MeshBasicMaterial).opacity = env * 0.55;
        this.thrustTrail.position.z = -0.95 + this.kf.tz;
        this.thrustTrail.scale.setY(0.7 + Math.max(0, -this.kf.tz) * 0.9);
      } else {
        const heavy = this.swingKind === 'chop';
        this.slashTrail.visible = true;
        (this.slashTrail.material as THREE.MeshBasicMaterial).opacity = env * (heavy ? 0.62 : 0.5);
        this.slashTrail.rotation.z = 0.5 - (p - 0.5) * (heavy ? 2.3 : 1.7);
        const ts = heavy ? 1.3 : 1.0;
        this.slashTrail.scale.set(ts, ts, ts);
      }
    } else {
      this.handRoot.position.copy(HAND);
      this.handRoot.rotation.set(0, 0, 0);
      this.rightHand.rotation.set(0, 0, 0);
    }

    // Mining chop (light tap when no attack swing is active).
    if (this.mining && this.swingT <= 0 && this.mode === 'weapon') {
      const m = Math.abs(Math.sin(performance.now() * 0.012));
      this.handRoot.rotation.x -= m * 0.5;
      this.handRoot.position.y = HAND.y - m * 0.04;
    }
  }
}
