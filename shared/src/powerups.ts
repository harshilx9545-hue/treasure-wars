/** Temporary power-ups shared between client (prediction/UI) and server (authority). */
export enum PowerUp {
  Speed = 0,
  Jump = 1,
  Strength = 2,
  Haste = 3,
  Regeneration = 4,
  Shield = 5,
}

export interface PowerUpDef {
  id: PowerUp;
  name: string;
  key: string; // hotkey code to activate
  color: number; // css/three color for the visual effect + UI timer
  durationMs: number;
  cooldownMs: number;
  /** Movement speed multiplier while active. */
  speedMult: number;
  /** Jump velocity multiplier while active. */
  jumpMult: number;
  /** Extra melee damage while active. */
  strengthBonus: number;
  /** Mining speed multiplier while active (client-side feel). */
  hasteMult: number;
  /** HP healed per second while active (server-side). */
  regenPerSec: number;
  /** Incoming damage multiplier while active (server-side). */
  damageTaken: number;
}

export const POWERUPS: Record<PowerUp, PowerUpDef> = {
  [PowerUp.Speed]: {
    id: PowerUp.Speed, name: 'Speed', key: 'KeyZ', color: 0x39c0ff,
    durationMs: 8000, cooldownMs: 16000,
    speedMult: 1.6, jumpMult: 1, strengthBonus: 0, hasteMult: 1, regenPerSec: 0, damageTaken: 1,
  },
  [PowerUp.Jump]: {
    id: PowerUp.Jump, name: 'Jump', key: 'KeyX', color: 0x9bff5c,
    durationMs: 8000, cooldownMs: 16000,
    speedMult: 1, jumpMult: 1.5, strengthBonus: 0, hasteMult: 1, regenPerSec: 0, damageTaken: 1,
  },
  [PowerUp.Strength]: {
    id: PowerUp.Strength, name: 'Strength', key: 'KeyC', color: 0xff5252,
    durationMs: 6000, cooldownMs: 18000,
    speedMult: 1, jumpMult: 1, strengthBonus: 4, hasteMult: 1, regenPerSec: 0, damageTaken: 1,
  },
  [PowerUp.Haste]: {
    id: PowerUp.Haste, name: 'Haste', key: 'KeyV', color: 0xffd23f,
    durationMs: 10000, cooldownMs: 16000,
    speedMult: 1, jumpMult: 1, strengthBonus: 0, hasteMult: 2.2, regenPerSec: 0, damageTaken: 1,
  },
  [PowerUp.Regeneration]: {
    id: PowerUp.Regeneration, name: 'Regen', key: 'KeyB', color: 0xff7bd5,
    durationMs: 6000, cooldownMs: 20000,
    speedMult: 1, jumpMult: 1, strengthBonus: 0, hasteMult: 1, regenPerSec: 4, damageTaken: 1,
  },
  [PowerUp.Shield]: {
    id: PowerUp.Shield, name: 'Shield', key: 'KeyN', color: 0xc0c0ff,
    durationMs: 6000, cooldownMs: 22000,
    speedMult: 1, jumpMult: 1, strengthBonus: 0, hasteMult: 1, regenPerSec: 0, damageTaken: 0.35,
  },
};

export const ALL_POWERUPS: PowerUpDef[] = Object.values(POWERUPS);
