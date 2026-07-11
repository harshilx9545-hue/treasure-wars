import * as THREE from 'three';
import { WeaponId, WEAPONS } from '@bedwars/shared';
import { weaponModels } from './weaponModels';

/**
 * First-person view model attached to the camera. Renders the active weapon
 * GLB (or a held block for block/utility slots) and plays procedural equip /
 * attack / block / walk-bob animations. Purely cosmetic.
 */
export class ViewModel {
  private root = new THREE.Group();
  private weaponHolder = new THREE.Group();
  private block: THREE.Mesh;
  private blockMat: THREE.MeshLambertMaterial;

  private mode: 'weapon' | 'block' = 'weapon';
  private currentWeapon: WeaponId | null = null;
  private pendingWeapon: WeaponId | null = null;

  private swingT = 0;
  private swingCrit = false;
  private mining = false;
  private placeT = 0;
  private equipT = 0;
  private blocking = false;
  private bob = 0;

  private restPos = new THREE.Vector3(0, 0, 0);
  private restRot = new THREE.Euler(0, 0, 0);

  constructor(camera: THREE.Camera) {
    this.blockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.block = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), this.blockMat);
    this.block.position.set(0.42, -0.4, -0.7);
    this.block.rotation.set(0.2, 0.6, 0);
    this.block.visible = false;

    this.root.add(this.weaponHolder, this.block);
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
    const model = weaponModels.buildFP(id);
    if (model) this.weaponHolder.add(model);
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
    // Shields don't swing.
    if (this.mode === 'weapon' && this.currentWeapon !== null) {
      const def = WEAPONS[this.currentWeapon];
      if (def.shield) return;
    }
    this.swingT = 1;
    this.swingCrit = crit;
  }

  setMining(on: boolean): void { this.mining = on; }
  place(): void { this.placeT = 1; }
  setBlocking(on: boolean): void { this.blocking = on; }

  update(dt: number, walking: boolean, sprinting: boolean, onGround: boolean): void {
    const holder = this.mode === 'weapon' ? this.weaponHolder : this.block;
    this.weaponHolder.visible = this.mode === 'weapon';
    this.block.visible = this.mode === 'block';

    // Walk bob.
    const bobAmt = walking && onGround ? (sprinting ? 1.4 : 1) : 0;
    this.bob += dt * (bobAmt > 0 ? (sprinting ? 12 : 8) : 0);
    const t = this.bob;

    let px = this.restPos.x + Math.sin(t) * 0.02 * bobAmt;
    let py = this.restPos.y + Math.abs(Math.cos(t)) * 0.03 * bobAmt;
    let pz = this.restPos.z;
    let rx = this.restRot.x;
    let ry = this.restRot.y;
    let rz = this.restRot.z + Math.sin(t) * 0.03 * bobAmt;

    const isShield = this.mode === 'weapon' && this.currentWeapon !== null && WEAPONS[this.currentWeapon].shield;

    // Mining chop.
    if (this.mining && this.swingT <= 0) {
      const m = Math.abs(Math.sin(performance.now() * 0.012));
      rx -= m * 0.6; py -= m * 0.04;
    }

    // Attack swing.
    if (this.swingT > 0) {
      this.swingT = Math.max(0, this.swingT - dt * 6);
      const s = Math.sin(this.swingT * Math.PI);
      rx -= s * 1.5;
      rz += s * 0.7 * (this.swingCrit ? 1.3 : 1);
      pz -= s * 0.12; px -= s * 0.08;
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

    // Equip slide-in.
    if (this.equipT > 0) {
      this.equipT = Math.max(0, this.equipT - dt * 4);
      py -= this.equipT * 0.5;
      rx += this.equipT * 0.8;
    }

    holder.position.set(px, py, pz);
    holder.rotation.set(rx, ry, rz);
    // Keep the other holder aligned so switching is seamless.
    this.root.position.copy(this.restPos);
    this.root.rotation.copy(this.restRot);
  }
}
