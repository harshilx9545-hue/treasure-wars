/**
 * Weapon system config — shared by client (models, view model, hotbar, shop)
 * and server (authoritative combat). One sword only (Iron Sword).
 *
 * Model files live in /weapons/GLB. Each GLB is a single self-contained mesh
 * with the embedded atlas texture. There is no pickaxe asset in the pack, so
 * the Pickaxe uses an axe variant as its visual (noted below); swap `glb` here
 * to retarget any weapon without touching gameplay code.
 */
export enum WeaponId {
  IronSword = 0,
  Axe = 1,
  Pickaxe = 2,
  Spear = 3,
  Shield = 4,
  DoubleAxe = 5,
  Bow = 6,
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  glb: string; // file in weapons/GLB (without extension)
  price: number; // shop cost in coins (0 = starting weapon)
  damage: number; // melee hit damage
  cooldownMs: number; // attack speed
  range: number; // melee reach (blocks)
  knockback: number; // horizontal knockback multiplier
  breakMult: number; // block-mining speed multiplier while held
  shield: boolean; // shield: blocks, cannot attack
  /** Ranged weapons use the authoritative projectile path rather than melee reach. */
  ranged?: { speed: number; gravity: number; projectileLifetimeMs: number };
  color: number; // UI accent
  // First-person / hand attachment transform (tunable, per-weapon).
  fp: { scale: number; pos: [number, number, number]; rot: [number, number, number] };
  hand: { scale: number; pos: [number, number, number]; rot: [number, number, number] };
}

const D = Math.PI / 180;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  [WeaponId.IronSword]: {
    id: WeaponId.IronSword, name: 'Iron Sword', glb: 'sword_1', price: 0,
    damage: 6, cooldownMs: 450, range: 3.2, knockback: 1, breakMult: 1,
    shield: false, color: 0xd8d8e0,
    fp: { scale: 1, pos: [0.42, -0.4, -0.7], rot: [-10 * D, 10 * D, 8 * D] },
    hand: { scale: 1, pos: [0.02, 0, 0.02], rot: [0, 0, 0] },
  },
  [WeaponId.Axe]: {
    id: WeaponId.Axe, name: 'Axe', glb: 'axe_1', price: 20,
    damage: 7, cooldownMs: 600, range: 3.0, knockback: 1.1, breakMult: 1.6,
    shield: false, color: 0xc9a06a,
    fp: { scale: 1, pos: [0.44, -0.42, -0.7], rot: [-10 * D, 0, 6 * D] },
    hand: { scale: 1, pos: [0.02, 0, 0.02], rot: [0, 0, 0] },
  },
  [WeaponId.Pickaxe]: {
    // No pickaxe model in the pack — uses axe_3 as a distinct visual stand-in.
    id: WeaponId.Pickaxe, name: 'Pickaxe', glb: 'axe_3', price: 15,
    damage: 3, cooldownMs: 500, range: 2.8, knockback: 0.8, breakMult: 3,
    shield: false, color: 0x9fb0c0,
    fp: { scale: 1, pos: [0.44, -0.42, -0.7], rot: [-10 * D, 0, 6 * D] },
    hand: { scale: 1, pos: [0.02, 0, 0.02], rot: [0, 0, 0] },
  },
  [WeaponId.Spear]: {
    id: WeaponId.Spear, name: 'Spear', glb: 'spear_1', price: 40,
    damage: 8, cooldownMs: 750, range: 4.4, knockback: 1.1, breakMult: 1,
    shield: false, color: 0xbfc7cf,
    fp: { scale: 1, pos: [0.4, -0.35, -0.85], rot: [0, 0, 0] },
    hand: { scale: 1, pos: [0.02, 0, 0.1], rot: [0, 0, 0] },
  },
  [WeaponId.Shield]: {
    id: WeaponId.Shield, name: 'Shield', glb: 'shield_1', price: 25,
    damage: 0, cooldownMs: 500, range: 2.5, knockback: 0.5, breakMult: 0.6,
    shield: true, color: 0xb0b8c8,
    fp: { scale: 1, pos: [0.4, -0.35, -0.6], rot: [0, -20 * D, 0] },
    hand: { scale: 1, pos: [-0.05, 0.05, 0.02], rot: [0, 0, 0] },
  },
  [WeaponId.DoubleAxe]: {
    id: WeaponId.DoubleAxe, name: 'Double Battle Axe', glb: 'axe_2', price: 60,
    damage: 11, cooldownMs: 1000, range: 3.0, knockback: 2.2, breakMult: 1.2,
    shield: false, color: 0xd05a3a,
    fp: { scale: 1, pos: [0.46, -0.44, -0.72], rot: [-10 * D, 0, 6 * D] },
    hand: { scale: 1, pos: [0.02, 0, 0.02], rot: [0, 0, 0] },
  },
  [WeaponId.Bow]: {
    id: WeaponId.Bow, name: 'Bow', glb: 'bow_1', price: 45,
    damage: 6, cooldownMs: 850, range: 30, knockback: 0.55, breakMult: 0.8,
    shield: false, ranged: { speed: 34, gravity: 11, projectileLifetimeMs: 1800 }, color: 0xa56a38,
    fp: { scale: 1, pos: [0.44, -0.42, -0.72], rot: [-8 * D, 0, 0] },
    hand: { scale: 1, pos: [0.02, 0, 0.02], rot: [0, 0, 0] },
  },
};

export const ALL_WEAPONS: WeaponDef[] = Object.values(WEAPONS);

/** Weapons a player starts the match with. */
export const STARTING_WEAPONS = [WeaponId.IronSword];

export function isWeapon(v: number): v is WeaponId {
  return v in WEAPONS;
}
