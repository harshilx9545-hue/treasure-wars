import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') vx = 0; // horizontal velocity, synced for replay + knockback
  @type('number') vz = 0;
  @type('number') vy = 0; // needed for client-side replay after reconciliation
  @type('number') yaw = 0;
  @type('uint8') team = 0;
  @type('uint8') hp = 20;
  @type('boolean') alive = true;
  /** Server-owned AI player; replicated so all clients render it like any other player. */
  @type('boolean') isBot = false;
  /** 0 easy, 1 medium, 2 hard. This is presentation/debug data only. */
  @type('uint8') botDifficulty = 0;
  @type('uint32') lastSeq = 0; // last processed input, acks prediction
  // Combat stats
  @type('uint16') kills = 0;
  @type('uint16') deaths = 0;
  @type('uint16') assists = 0;
  // Active power-ups: type index -> epoch-ms expiry.
  @type({ map: 'number' }) effects = new MapSchema<number>();

  // Lobby
  @type('string') name = 'Player';
  @type('boolean') ready = false;

  // Economy (server-authoritative)
  @type('uint16') coins = 0;
  @type('uint32') coinsEarned = 0; // lifetime, used for unlock gating
  @type('uint16') wool = 0;
  @type('uint16') plank = 0;
  @type('uint16') stone = 0;
  @type('uint8') swordTier = 0; // legacy (unused by combat; kept for compatibility)
  @type('uint8') pickTier = 0; // index into ECONOMY.pickaxes
  @type('boolean') shears = false;
  // Weapon system
  @type('uint8') weapon = 0; // active WeaponId (0 = Iron Sword)
  @type('uint8') weapons = 1; // owned bitmask (bit 0 = Iron Sword)
  @type('boolean') blocking = false; // shield raised
  @type('uint8') tnt = 0;
  @type('uint8') pearls = 0;
  @type('uint8') fireballs = 0;
  @type('uint8') alarms = 0;
}

export class TeamState extends Schema {
  @type('uint8') armorTier = 0; // index into ECONOMY.armor
  @type('uint8') genLevel = 0; // index into ECONOMY.generator.levels
  @type('boolean') alarmArmed = false;
}

export class CoinDrop extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('uint8') team = 0; // owning generator
}

export class Projectile extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('uint8') kind = 0; // 0 = pearl, 1 = fireball, 2 = arrow
  @type('uint8') team = 0;
}

export class Tnt extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('uint8') team = 0;
}

export class BedwarsState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type([TeamState]) teams = new ArraySchema<TeamState>();
  @type({ map: CoinDrop }) drops = new MapSchema<CoinDrop>();
  @type({ map: Projectile }) projectiles = new MapSchema<Projectile>();
  @type({ map: Tnt }) tnts = new MapSchema<Tnt>();
  @type('uint8') bedsAlive = 0b1111; // bitmask by team index
  @type('int8') winner = -1; // team index, -1 while in progress
  // Lobby / match flow
  @type('string') phase = 'lobby'; // 'lobby' | 'playing' | 'ended'
  @type('string') hostId = '';
  @type('uint8') durationMin = 10; // host-selected match length (5 / 10 / 20)
  @type('uint8') teamSize = 2; // host-selected players-per-team preference (1 / 2 / 4)
  @type('uint8') botCount = 0; // host-selected server-owned bot players (0..7)
  @type('uint32') timeLeftMs = 0; // remaining match time (counts down while playing)
}
