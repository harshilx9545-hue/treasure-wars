import { ATTACK_REACH } from './constants';

/** The complete melee weapon set shared by client presentation and server authority. */
export enum WeaponId {
  Dagger = 0,
  NormalSword = 1,
  LargeSword = 2,
  Cutlass = 3,
  Axe = 4,
  DoubleAxe = 5,
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  price: number;
  damage: number;
  cooldownMs: number;
  range: number;
  knockback: number;
  breakMult: number;
  color: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  [WeaponId.Dagger]: {
    id: WeaponId.Dagger, name: 'Dagger', price: 0,
    damage: 5, cooldownMs: 450, range: ATTACK_REACH, knockback: 1, breakMult: 1,
    color: 0xb8c0cc,
  },
  [WeaponId.NormalSword]: {
    id: WeaponId.NormalSword, name: 'Normal Sword', price: 10,
    damage: 6, cooldownMs: 450, range: ATTACK_REACH, knockback: 1, breakMult: 1,
    color: 0xc8d0dc,
  },
  [WeaponId.LargeSword]: {
    id: WeaponId.LargeSword, name: 'Large Sword', price: 30,
    damage: 7.5, cooldownMs: 450, range: ATTACK_REACH, knockback: 1.1, breakMult: 1,
    color: 0xd8d8e0,
  },
  [WeaponId.Cutlass]: {
    id: WeaponId.Cutlass, name: 'Cutlass', price: 60,
    damage: 9, cooldownMs: 450, range: ATTACK_REACH, knockback: 1.15, breakMult: 1,
    color: 0xe5d5a6,
  },
  [WeaponId.Axe]: {
    id: WeaponId.Axe, name: 'Axe', price: 20,
    damage: 7, cooldownMs: 600, range: 3, knockback: 1.1, breakMult: 1.6,
    color: 0xc9a06a,
  },
  [WeaponId.DoubleAxe]: {
    id: WeaponId.DoubleAxe, name: 'Double Axe', price: 60,
    damage: 11, cooldownMs: 1000, range: 3, knockback: 2.2, breakMult: 1.2,
    color: 0xd05a3a,
  },
};

export const ALL_WEAPONS: WeaponDef[] = Object.values(WEAPONS);
export const SWORD_WEAPONS = [
  WeaponId.Dagger,
  WeaponId.NormalSword,
  WeaponId.LargeSword,
  WeaponId.Cutlass,
] as const;
export const SWORD_WEAPON_MASK = SWORD_WEAPONS.reduce((mask, id) => mask | (1 << id), 0);
export const ALL_WEAPON_MASK = ALL_WEAPONS.reduce((mask, weapon) => mask | (1 << weapon.id), 0);

/** Weapons a player starts the match with. */
export const STARTING_WEAPONS = [WeaponId.Dagger] as const;

export function weaponForSwordTier(tier: number): WeaponId {
  const index = Math.max(0, Math.min(SWORD_WEAPONS.length - 1, Math.trunc(tier)));
  return SWORD_WEAPONS[index];
}

export function isSwordWeapon(id: WeaponId): boolean {
  return (SWORD_WEAPON_MASK & (1 << id)) !== 0;
}

export function isAxeWeapon(id: WeaponId): boolean {
  return id === WeaponId.Axe || id === WeaponId.DoubleAxe;
}

export function isWeapon(value: number): value is WeaponId {
  return Number.isInteger(value) && Object.prototype.hasOwnProperty.call(WEAPONS, value);
}
