import * as THREE from 'three';
import { WeaponId, WEAPONS } from '@bedwars/shared';
import { weaponModels } from './weaponModels';

/**
 * First-person view model attached to the camera. Renders the active weapon
 * GLB (or a held block for block/utility slots) and plays procedural equip /
 * attack / block / bow-draw / walk-bob animations. Purely cosmetic — it never
 * touches combat, damage or networking.
 *
 * Attack animations are weapon-type aware and eased (never linear):
 *   - swords: fast, snappy slash arc with a brief hit-pause on impact;
 *   - axes:   wide, heavy slash with more follow-through and recovery;
 *   - spear:  forward thrust that extends the weapon + nudges the camera;
 *   - bow:    smooth draw (nocked arrow appears + string pull) then a snappy
 *             release recoil.
 * White "swoosh" trails and impact hit-pauses give the swings weight.
 */

const HALF_PI = Math.PI / 2;
/** easeOutCubic — soft, natural deceleration for recoveries. */
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

export class ViewModel {
  private root = new THREE.Group();
  private weaponHolder = new THREE.Group();
  private block: THREE.Mesh;
  private blockMat: THREE.MeshLambertMaterial;

  // White motion-blur trails (drawn over the world during a swing).
  private slashTrail: THREE.Mesh;
  private thrustTrail: THREE.Mesh;
  private nockedArrow: THREE.Object3D | null = null;

  private mode: 'weapon' | 'block' = 'weapon';
  private currentWeapon: WeaponId | null = null;
  private pendingWeapon: WeaponId | null = null;

  private swingT = 0;
  private swingCrit = false;
  private hitStop = 0; // brief freeze at moment of impact
  private mining = false;
  private placeT = 0;
  private equipT = 0;
  private blocking = false;
  private bowCharge = 0; // visual draw amount 0..1 (not the networked charge)
  private bowReleaseT = 0; // release-recoil timer
  private bob = 0;
  private breath = 0; // idle breathing phase
  private camKick = 0; // forward camera dolly for the spear thrust (read by main)

  private restPos = new THREE.Vector3(0, 0, 0);
  private restRot = new THREE.Euler(0, 0, 0);

  constructor(camera: THREE.Camera) {
    this.blockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.block = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), this.blockMat);
    this.block.position.set(0.42, -0.4, -0.7);
    this.block.rotation.set(0.2, 0.6, 0);
    this.block.visible = false;

    // Crescent swoosh for slashing weapons; thin streak for the spear thrust.
    const trailMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    this.slashTrail = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.64, 28, 1, Math.PI * 0.12, Math.PI * 0.95), trailMat.clone());
    this.slashTrail.position.set(0.06, -0.22, -0.72);
    this.slashTrail.renderOrder = 999;
    this.slashTrail.visible = false;
    this.thrustTrail = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 1.0), trailMat.clone());
    this.thrustTrail.position.set(0.18, -0.3, -1.0);
    this.thrustTrail.renderOrder = 999;
    this.thrustTrail.visible = false;

    this.root.add(this.weaponHolder, this.block, this.slashTrail, this.thrustTrail);
    camera.add(this.root);

    weaponModels.onReady(() => {
      if (this.pendingWeapon !== null) this.applyWeapon(this.pendingWeapon);
    });
  }

  /** Show a weapon in first person (builds the GLB model, plays equip anim). */
  setWeapon(id: WeaponId): void {
    this.mode = 'weapon';
    this.block.visible = false;
    if (this.currentWeapon === id && this.weaponHolder.children.length > 0) return;
    if (!weaponModels.ready) { this.pendingWeapon = id; return; }
    this.applyWeapon(id);
  }

  private applyWeapon(id: WeaponId): void {
    this.pendingWeapon = null;
    this.currentWeapon = id;
    this.weaponHolder.clear();
    this.nockedArrow = null;
    const model = weaponModels.buildFP(id);
    if (model) this.weaponHolder.add(model);
    // A bow carries a nocked arrow that only shows while drawing.
    if (WEAPONS[id].ranged) {
      const arrow = weaponModels.buildArrow();
      if (arrow) {
        arrow.scale.multiplyScalar(0.9);
        arrow.position.set(0, 0.02, 0.12);
        arrow.rotation.set(HALF_PI, 0, 0); // lie along the shot direction (-z)
        arrow.visible = false;
        this.weaponHolder.add(arrow);
        this.nockedArrow = arrow;
      }
    }
    this.weaponHolder.visible = this.mode === 'weapon';
    this.equipT = 1; // play equip slide-in
  }

  /** Show a held block/utility cube of the given color. */
  setBlock(color: number): void {
    this.mode = 'block';
    this.weaponHolder.visible = false;
    this.block.visible = true;
    this.blockMat.color.setHex(color);
    this.equipT = 1;
  }

  swing(crit = false): void {
    // Bows/shields don't swing.
    if (this.mode === 'weapon' && this.currentWeapon !== null) {
      const def = WEAPONS[this.currentWeapon];
      if (def.ranged || def.shield) return;
    }
    this.swingT = 1;
    this.swingCrit = crit;
  }

  /** Loose the bow: hide the nocked arrow and play a snappy forward recoil. */
  releaseBow(): void {
    this.bowReleaseT = 1;
    this.bowCharge = 0;
    if (this.nockedArrow) this.nockedArrow.visible = false;
  }

  /** Brief hit-pause when the local player's blow actually lands. */
  impact(heavy = false): void {
    this.hitStop = heavy ? 0.09 : 0.05;
  }

  /** Forward camera dolly (spear thrust). Consumed by the frame loop. */
  getCameraKick(): number { return this.camKick; }

  setMining(on: boolean): void { this.mining = on; }
  place(): void { this.placeT = 1; }
  setBlocking(on: boolean): void { this.blocking = on; }
  setBowCharge(c: number): void { this.bowCharge = Math.max(0, Math.min(1, c)); }

  private isSpear(): boolean {
    return this.mode === 'weapon' && this.currentWeapon === WeaponId.Spear;
  }
  private isHeavy(): boolean {
    return this.currentWeapon === WeaponId.Axe || this.currentWeapon === WeaponId.DoubleAxe;
  }

  update(dt: number, walking: boolean, sprinting: boolean, onGround: boolean): void {
    const holder = this.mode === 'weapon' ? this.weaponHolder : this.block;
    this.weaponHolder.visible = this.mode === 'weapon';
    this.block.visible = this.mode === 'block';
    this.camKick = 0;

    // Walk bob.
    const bobAmt = walking && onGround ? (sprinting ? 1.4 : 1) : 0;
    this.bob += dt * (bobAmt > 0 ? (sprinting ? 12 : 8) : 0);
    const t = this.bob;

    // Idle breathing — a subtle always-on sway so the weapon never feels frozen.
    this.breath += dt;
    const idle = 1 - Math.min(1, bobAmt); // full breathing when still, fades while walking
    const breathe = Math.sin(this.breath * 1.6) * idle;
    const sway = Math.sin(this.breath * 0.8) * idle;

    let px = this.restPos.x + Math.sin(t) * 0.02 * bobAmt + sway * 0.004;
    let py = this.restPos.y + Math.abs(Math.cos(t)) * 0.03 * bobAmt + breathe * 0.006;
    let pz = this.restPos.z;
    let rx = this.restRot.x + breathe * 0.01;
    let ry = this.restRot.y + sway * 0.01;
    let rz = this.restRot.z + Math.sin(t) * 0.03 * bobAmt;

    const isRanged = this.mode === 'weapon' && this.currentWeapon !== null && WEAPONS[this.currentWeapon].ranged;
    const isShield = this.mode === 'weapon' && this.currentWeapon !== null && WEAPONS[this.currentWeapon].shield;

    // Mining chop.
    if (this.mining && this.swingT <= 0) {
      const m = Math.abs(Math.sin(performance.now() * 0.012));
      rx -= m * 0.6; py -= m * 0.04;
    }

    // Attack swing — weapon-type aware, eased, with a white trail.
    this.slashTrail.visible = false;
    this.thrustTrail.visible = false;
    if (this.swingT > 0) {
      // Hit-pause: freeze the swing for a beat at the moment of impact.
      if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);
      else {
        const speed = this.isSpear() ? 7 : this.isHeavy() ? 4.6 : 8.4; // axe slow+heavy, sword fast
        this.swingT = Math.max(0, this.swingT - dt * speed);
      }
      const p = 1 - this.swingT;          // 0..1 progress through the swing
      const env = Math.sin(p * Math.PI);  // rise then fall

      if (this.isSpear()) {
        // Forward thrust: extend the weapon out, pull the camera slightly with it.
        const ext = Math.sin(p * Math.PI);
        pz -= ext * 0.5;
        py -= ext * 0.05;
        px += ext * 0.03;
        rx += ext * 0.12;
        this.camKick = ext * 0.05;
        // Straight forward streak trail.
        this.thrustTrail.visible = true;
        (this.thrustTrail.material as THREE.MeshBasicMaterial).opacity = env * 0.55;
        this.thrustTrail.position.z = -0.9 - ext * 0.5;
        this.thrustTrail.scale.setY(0.7 + ext * 0.6);
      } else {
        // Slashing weapons: sweep an arc across the view. Axes swing wider/heavier.
        const heavy = this.isHeavy();
        const pitch = heavy ? 1.85 : 1.4;
        const roll = (heavy ? 1.25 : 0.85) * (this.swingCrit ? 1.25 : 1);
        const yaw = heavy ? 0.8 : 0.6;
        rx -= env * pitch;
        ry += (p - 0.5) * yaw;            // sweep left -> right
        rz += env * roll;
        px -= env * (heavy ? 0.05 : 0.08);
        py -= env * (heavy ? 0.08 : 0.04); // axe drops down with weight
        pz -= env * 0.12;
        // Crescent swoosh that sweeps with the blade.
        this.slashTrail.visible = true;
        (this.slashTrail.material as THREE.MeshBasicMaterial).opacity = env * (heavy ? 0.6 : 0.5);
        this.slashTrail.rotation.z = 0.4 - (p - 0.5) * (heavy ? 2.0 : 1.6);
        const ts = heavy ? 1.25 : 1.0;
        this.slashTrail.scale.set(ts, ts, ts);
      }
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

    // Bow draw — pull toward the eye, tilt the bow, reveal + draw the nocked arrow.
    if (isRanged) {
      const c = this.bowCharge;
      if (c > 0) {
        const e = easeOut(c);
        pz += e * 0.16; px -= e * 0.06; py += e * 0.03;
        rz += e * 0.14; rx -= e * 0.05;
        if (this.nockedArrow) {
          this.nockedArrow.visible = true;
          this.nockedArrow.position.z = 0.12 + e * 0.22; // string pulls the arrow back
        }
      } else if (this.nockedArrow) {
        this.nockedArrow.visible = false;
      }
      // Release recoil: quick forward snap, then eased return.
      if (this.bowReleaseT > 0) {
        this.bowReleaseT = Math.max(0, this.bowReleaseT - dt * 5);
        const s = Math.sin(this.bowReleaseT * Math.PI);
        pz -= s * 0.18; rx += s * 0.22;
      }
    }

    // Equip slide-in.
    if (this.equipT > 0) {
      this.equipT = Math.max(0, this.equipT - dt * 4);
      const e = this.equipT; // eased below via simple curve
      py -= e * 0.5;
      rx += e * 0.8;
    }

    holder.position.set(px, py, pz);
    holder.rotation.set(rx, ry, rz);
    // Keep the other holder aligned so switching is seamless.
    this.root.position.copy(this.restPos);
    this.root.rotation.copy(this.restRot);
  }
}
