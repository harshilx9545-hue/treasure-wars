/**
 * Single source of truth for economy balance. Retune here after playtests —
 * every price, generator rate and item stat lives in this file so you never
 * have to hunt through gameplay code.
 *
 * Design targets:
 *  - First Stone purchase affordable after ~60-90s of passive income.
 *  - Team generator upgrade affordable around the 2-3 min mark.
 *  - Players start with free Wool so day-1 bed covering isn't punishing.
 */

export interface GeneratorLevel {
  cost: number; // team-wide purchase cost (0 = base level)
  intervalMs: number; // ms between coin spawns at this level
}

export interface SwordTier {
  name: string;
  price: number; // per-player replacement cost (0 = starting dagger)
  damage: number;
}

export interface ArmorTier {
  name: string;
  price: number; // team-wide, permanent for the match
  reduction: number; // fraction of incoming damage removed (0..1)
}

export interface PickTier {
  name: string;
  price: number;
  speed: number; // mining speed multiplier
}

export const ECONOMY = {
  /** Minimum ready players before the host can start. */
  minMatchPlayers: 2,

  /** Free starting loadout so early game isn't a rush to the shop. */
  starting: {
    wool: 16,
    swordTier: 0, // dagger
  },

  generator: {
    collectRadius: 1.9, // blocks; auto-pickup when a player walks this close
    maxDrops: 24, // cap live coin drops per generator
    dropValue: 1, // coins per drop
    /** Level 0 is base (~1 coin/s). Upgrades are team-wide, bought once. */
    levels: [
      { cost: 0, intervalMs: 1000 },
      { cost: 90, intervalMs: 650 }, // ~2-3 min in with base income
      { cost: 220, intervalMs: 450 },
    ] as GeneratorLevel[],
  },

  blocks: {
    // block key -> price + stack size purchased at once
    wool: { price: 4, stack: 16 },
    plank: { price: 4, stack: 16 },
    // Stone gated behind a little passive income so turn-1 isn't overwhelming.
    stone: { price: 12, stack: 8, unlockCoinsEarned: 24 },
  },

  swords: [
    { name: 'Dagger', price: 0, damage: 5 },
    { name: 'Normal Sword', price: 10, damage: 6 },
    { name: 'Large Sword', price: 30, damage: 7.5 },
    { name: 'Cutlass', price: 60, damage: 9 },
  ] as SwordTier[],

  armor: [
    { name: 'No Armor', price: 0, reduction: 0 },
    { name: 'Leather Armor', price: 20, reduction: 0.15 },
    { name: 'Chainmail Armor', price: 40, reduction: 0.3 },
    { name: 'Iron Armor', price: 80, reduction: 0.45 },
    { name: 'Diamond Armor', price: 160, reduction: 0.6 },
  ] as ArmorTier[],

  pickaxes: [
    { name: 'Hand', price: 0, speed: 1 },
    { name: 'Pickaxe I', price: 10, speed: 1.6 },
    { name: 'Pickaxe II', price: 25, speed: 2.4 },
    { name: 'Pickaxe III', price: 45, speed: 3.2 },
  ] as PickTier[],

  shears: { price: 15, name: 'Shears' },

  utility: {
    tnt: { price: 25, fuseMs: 2500, radius: 4, damage: 14, name: 'TNT' },
    pearl: { price: 20, speed: 22, ttlMs: 3000, name: 'Ender Pearl' },
    fireball: { price: 30, speed: 26, ttlMs: 4000, radius: 3.5, damage: 9, knockback: 13, name: 'Fireball' },
    alarm: { price: 15, name: 'Alarm Trap' },
  },
} as const;

/** Stable string ids used by the existing shop purchase message. */
export type ShopItemId =
  | 'block_wool'
  | 'block_plank'
  | 'block_stone'
  | 'weapon_axe'
  | 'weapon_doubleaxe'
  | 'sword'
  | 'armor' // buys next armor tier (team)
  | 'pick' // buys next pickaxe tier
  | 'shears'
  | 'tnt'
  | 'pearl'
  | 'fireball'
  | 'alarm'
  | 'gen_upgrade'; // team generator upgrade
