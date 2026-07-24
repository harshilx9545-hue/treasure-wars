import * as THREE from 'three';
import { WeaponId } from '@bedwars/shared';
import {
  type PirateWeaponCategory,
  type WeaponMotion,
  weaponModels,
} from './weaponModels';

interface FirstPersonPose {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

const FIRST_PERSON_POSES: Readonly<Record<PirateWeaponCategory, FirstPersonPose>> = Object.freeze({
  dagger: { x: 0.42, y: -0.34, z: -0.67, rx: -0.46, ry: 0.08, rz: 0.48 },
  sword: { x: 0.45, y: -0.38, z: -0.73, rx: -0.52, ry: 0.10, rz: 0.43 },
  largeSword: { x: 0.47, y: -0.41, z: -0.80, rx: -0.55, ry: 0.10, rz: 0.38 },
  cutlass: { x: 0.47, y: -0.40, z: -0.76, rx: -0.56, ry: 0.12, rz: 0.40 },
  axe: { x: 0.47, y: -0.40, z: -0.78, rx: -0.52, ry: 0.10, rz: 0.36 },
  doubleAxe: { x: 0.51, y: -0.44, z: -0.84, rx: -0.50, ry: 0.08, rz: 0.31 },
});

const BLOCK_POSE: FirstPersonPose = Object.freeze({
  x: 0.42, y: -0.4, z: -0.7, rx: 0.2, ry: 0.6, rz: 0,
});

/**
 * Purely visual first-person weapon controller. Pirate templates, materials,
 * textures and geometry are cache-owned; switching only clones object nodes.
 */
export class ViewModel {
  private readonly root = new THREE.Group();
  private readonly weaponHolder = new THREE.Group();
  private readonly block: THREE.Mesh;
  private readonly blockMat: THREE.MeshLambertMaterial;
  private mode: 'weapon' | 'block' = 'weapon';
  private currentWeapon: WeaponId | null = null;
  private currentCategory: PirateWeaponCategory | null = null;
  private currentMotion: WeaponMotion | null = null;
  private pendingWeapon: WeaponId | null = null;
  private attackElapsed = 0;
  private attackDuration = 0;
  private swingCrit = false;
  private mining = false;
  private placeT = 0;
  private equipT = 0;
  private bobPhase = 0;
  private elapsed = 0;

  constructor(camera: THREE.Camera) {
    this.root.name = 'FirstPersonPirateWeaponRoot';
    this.weaponHolder.name = 'FirstPersonPirateWeapon';
    this.blockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.block = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), this.blockMat);
    this.block.visible = false;
    this.root.add(this.weaponHolder, this.block);
    camera.add(this.root);

    void weaponModels.load();
    weaponModels.onReady(() => {
      if (this.pendingWeapon !== null) this.applyWeapon(this.pendingWeapon);
    });
  }

  /** Select one of the six cached melee visuals. */
  setWeapon(id: WeaponId): void {
    this.mode = 'weapon';
    this.block.visible = false;
    this.weaponHolder.visible = true;
    if (this.currentWeapon === id) return;
    if (!weaponModels.ready) {
      this.pendingWeapon = id;
      return;
    }
    this.applyWeapon(id);
  }

  private applyWeapon(id: WeaponId): void {
    this.pendingWeapon = null;
    this.currentWeapon = id;
    this.currentCategory = weaponModels.category(id);
    this.currentMotion = weaponModels.motion(id);
    this.weaponHolder.clear();

    const model = weaponModels.buildFP(id);
    if (model) this.weaponHolder.add(model);
    else if (this.currentCategory) console.warn('[bedwars] missing first-person Pirate weapon', this.currentCategory);
    this.weaponHolder.visible = this.mode === 'weapon';
    this.equipT = 1;
  }

  /** Show a held block/utility cube; no weapon resources are changed or disposed. */
  setBlock(color: number): void {
    this.mode = 'block';
    this.weaponHolder.visible = false;
    this.block.visible = true;
    this.blockMat.color.setHex(color);
    this.equipT = 1;
  }

  swing(crit = false): void {
    if (this.mode !== 'weapon' || this.currentWeapon === null || !this.currentMotion) return;
    this.attackElapsed = 0;
    this.attackDuration = weaponModels.attackDuration(this.currentMotion);
    this.swingCrit = crit;
  }

  setMining(on: boolean): void { this.mining = on; }
  place(): void { this.placeT = 1; }

  update(dt: number, walking: boolean, sprinting: boolean, onGround: boolean): void {
    this.elapsed += dt;
    const holder = this.mode === 'weapon' ? this.weaponHolder : this.block;
    this.weaponHolder.visible = this.mode === 'weapon';
    this.block.visible = this.mode === 'block';

    const pose = this.mode === 'weapon' && this.currentCategory
      ? FIRST_PERSON_POSES[this.currentCategory]
      : BLOCK_POSE;
    let px = pose.x;
    let py = pose.y;
    let pz = pose.z;
    let rx = pose.rx;
    let ry = pose.ry;
    let rz = pose.rz;

    // Always-on subtle breathing and low-frequency hand sway.
    const breath = Math.sin(this.elapsed * 1.75);
    const sway = Math.sin(this.elapsed * 0.78);
    py += breath * 0.009;
    px += sway * 0.006;
    rx += breath * 0.008;
    ry += sway * 0.012;

    // Grounded walk/run bob. Phase is retained while idle to avoid snapping.
    const bobAmount = walking && onGround ? (sprinting ? 1.45 : 1) : 0;
    if (bobAmount > 0) this.bobPhase += dt * (sprinting ? 12 : 8);
    px += Math.sin(this.bobPhase) * 0.018 * bobAmount;
    py += Math.abs(Math.cos(this.bobPhase)) * 0.026 * bobAmount;
    rz += Math.sin(this.bobPhase) * 0.027 * bobAmount;
    rx += Math.cos(this.bobPhase * 2) * 0.012 * bobAmount;

    const attacking = this.attackDuration > 0 && this.attackElapsed < this.attackDuration;
    if (this.mining && !attacking) {
      const chop = Math.abs(Math.sin(this.elapsed * 12));
      rx -= chop * 0.6;
      py -= chop * 0.04;
    }

    if (attacking && this.currentMotion) {
      this.attackElapsed = Math.min(this.attackDuration, this.attackElapsed + dt);
      const progress = this.attackElapsed / this.attackDuration;
      const envelope = Math.sin(progress * Math.PI);
      const strength = this.swingCrit ? 1.18 : 1;

      if (this.currentMotion === 'stab') {
        pz -= envelope * 0.31 * strength;
        py += envelope * 0.035;
        rx -= envelope * 0.16;
      } else if (this.currentMotion === 'quickSlash') {
        rz += envelope * 1.05 * strength;
        rx -= envelope * 0.38;
        px -= envelope * 0.10;
      } else if (this.currentMotion === 'wideSlash') {
        rz += envelope * 1.42 * strength;
        ry -= envelope * 0.48;
        px -= envelope * 0.17;
        pz -= envelope * 0.08;
      } else if (this.currentMotion === 'overhead') {
        rx -= envelope * 1.58 * strength;
        ry += envelope * 0.18;
        py += envelope * 0.09;
        pz -= envelope * 0.10;
      } else if (this.currentMotion === 'doubleHeavy') {
        rx -= envelope * 1.82 * strength;
        rz += envelope * 0.52;
        py += envelope * 0.13;
        pz -= envelope * 0.14;
      }
    }

    if (this.placeT > 0) {
      this.placeT = Math.max(0, this.placeT - dt * 6);
      const push = Math.sin(this.placeT * Math.PI);
      pz -= push * 0.14;
      py -= push * 0.05;
    }

    if (this.equipT > 0) {
      this.equipT = Math.max(0, this.equipT - dt * 4.5);
      py -= this.equipT * 0.42;
      rx += this.equipT * 0.72;
    }

    holder.position.set(px, py, pz);
    holder.rotation.set(rx, ry, rz, 'XYZ');
  }
}
