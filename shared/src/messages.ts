import type { MoveInput } from './physics';

/** Wire message channels (short strings to keep frames small). */
export const Msg = {
  Input: 'i', // client -> server: MoveInput[] batched at 20Hz
  Place: 'p', // client -> server: PlaceMessage
  Break: 'b', // client -> server: BreakMessage
  Attack: 'at', // client -> server: AttackMessage
  PowerUp: 'up', // client -> server: PowerUpMessage (activation request)
  BlockDiff: 'd', // server -> all: BlockDiff
  WorldInit: 'w', // server -> joining client: WorldInit (diff log only)
  Ping: 'pg', // client -> server: number (client timestamp)
  Pong: 'po', // server -> client: number (echoed timestamp)
  Feed: 'f', // server -> all: FeedMessage (kill feed / events)
  Hit: 'ht', // server -> all: HitEvent (combat feedback)
  BedDestroyed: 'bd', // server -> all: BedDestroyedEvent
  // Lobby / matchmaking
  SetName: 'nm', // client -> server: { name }
  Ready: 'rd', // client -> server: { ready }
  StartMatch: 'sm', // client -> server (host only): {}
  Lobby: 'lb', // server -> all: LobbyEvent (host changes, messages)
  // Economy / shop
  Purchase: 'buy', // client -> server: PurchaseMessage
  UseItem: 'use', // client -> server: UseItemMessage
  Notice: 'no', // server -> client: NoticeMessage (purchase result / alerts)
  Explosion: 'ex', // server -> all: ExplosionEvent (TNT / fireball fx)
  Teleport: 'tp', // server -> one: TeleportEvent (ender pearl landed)
  // Weapons
  Weapon: 'wp', // client -> server: { weapon } select active weapon
  Block: 'bl', // client -> server: { blocking } shield raise/lower
  Shoot: 'so', // client -> server: ShootMessage (bow)
  // Match flow
  Unstuck: 'un', // client -> server: safe respawn at team spawn (anti-stuck)
  Rematch: 'rm', // client -> server: reset a finished match back to the lobby
  WorldReset: 'wr', // server -> all: rebuild the base world for a rematch
  SetDuration: 'dur', // client(host) -> server: { minutes } chosen match length
  SetTeamSize: 'tsz', // client(host) -> server: { size } players-per-team preference
} as const;

export type InputBatch = MoveInput[];

export interface PlaceMessage {
  x: number;
  y: number;
  z: number;
  block: number;
}

export interface BreakMessage {
  x: number;
  y: number;
  z: number;
}

export interface AttackMessage {
  target: string; // sessionId of the victim
  crit: boolean;
}

export interface PowerUpMessage {
  type: number; // PowerUp enum value
}

export interface BlockDiff {
  x: number;
  y: number;
  z: number;
  b: number;
}

export interface WorldInit {
  diffs: BlockDiff[];
}

export interface FeedMessage {
  text: string;
}

export interface HitEvent {
  target: string; // victim sessionId
  by: string; // attacker sessionId
  x: number;
  y: number;
  z: number;
  crit: boolean;
  fatal: boolean;
}

export interface BedDestroyedEvent {
  team: number;
  by: number; // attacker team
  x: number;
  y: number;
  z: number;
}

export interface LobbyEvent {
  kind: 'host' | 'message' | 'closing';
  hostId?: string;
  text?: string;
}

export interface PurchaseMessage {
  id: string; // ShopItemId
}

export interface UseItemMessage {
  item: 'tnt' | 'pearl' | 'fireball' | 'alarm';
  // Aim / placement context computed on the client, validated on the server.
  x: number;
  y: number;
  z: number;
  dx: number; // normalized aim direction (for projectiles)
  dy: number;
  dz: number;
}

export interface NoticeMessage {
  text: string;
  ok: boolean;
}

export interface ExplosionEvent {
  x: number;
  y: number;
  z: number;
  radius: number;
  kind: 'tnt' | 'fireball';
}

export interface TeleportEvent {
  x: number;
  y: number;
  z: number;
}

export interface ShootMessage {
  dx: number;
  dy: number;
  dz: number;
  charge: number; // 0..1 draw strength
}
