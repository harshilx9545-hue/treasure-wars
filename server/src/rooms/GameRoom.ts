import { Room, Client } from 'colyseus';
import {
  VoxelWorld,
  generateMap,
  stepPlayer,
  Msg,
  BLOCKS,
  BlockType,
  bedTeam,
  isBed,
  TEAMS,
  TICK_MS,
  TICK_RATE,
  REACH,
  ATTACK_REACH,
  VOID_Y,
  TEAM_COUNT,
  RESPAWN_SECONDS,
  PLAYER_HALF_W,
  PLAYER_HEIGHT,
  PLAYER_EYE,
  KNOCKBACK_H,
  KNOCKBACK_V,
  CRIT_MULT,
  POWERUPS,
  PowerUp,
  ECONOMY,
  WEAPONS,
  WeaponId,
  STARTING_WEAPONS,
  treasurePosition,
  type SpawnPoint,
  type MoveInput,
  type PlayerPhysics,
  type PlaceMessage,
  type BreakMessage,
  type AttackMessage,
  type PowerUpMessage,
  type PurchaseMessage,
  type UseItemMessage,
  type BlockDiff,
  type StepMods,
} from '@bedwars/shared';
import { BedwarsState, PlayerState, TeamState, CoinDrop, Projectile, Tnt } from '../schema/GameState';
import { BotController, BotDifficulty } from '../bots/BotController';

const MAX_INPUTS_PER_TICK = 8;
const MAX_QUEUE = MAX_INPUTS_PER_TICK * 2;
const MAX_DIFFS = 20000;
const ISLAND_ALARM_RADIUS = 13;
const ALARM_COOLDOWN_MS = 6000;
// Fall damage: no damage for drops up to SAFE blocks, then 1 hp per extra block.
const FALL_SAFE_BLOCKS = 3.5;
const FALL_DMG_PER_BLOCK = 1;

interface ProjMeta { vx: number; vy: number; vz: number; owner: string; team: number; ttl: number; kind: number; damage?: number; gravity?: number; }

export class GameRoom extends Room<BedwarsState> {
  maxClients = 16;

  private world = new VoxelWorld();
  private spawns: SpawnPoint[] = [];
  private diffs: BlockDiff[] = [];
  private phys = new Map<string, PlayerPhysics>();
  private queues = new Map<string, MoveInput[]>();
  private respawnAt = new Map<string, number>();
  private lastAttack = new Map<string, number>();
  private powerCooldownAt = new Map<string, Map<number, number>>();
  private regenAcc = new Map<string, number>();
  // Fall damage: per-player apex height while airborne + airborne flag, sampled
  // each tick so damage can be applied on landing.
  private fallPeakY = new Map<string, number>();
  private airborne = new Map<string, boolean>();

  // Economy / entities
  private genNextAt: number[] = [];
  private projMeta = new Map<string, ProjMeta>();
  private tntExplodeAt = new Map<string, number>();
  private lastAlarmAt: number[] = [];
  private idCounter = 0;
  // Kill/assist attribution: victimId -> last attacker, and victimId -> recent attackers.
  private lastDamage = new Map<string, { by: string; at: number }>();
  private assistDamage = new Map<string, Map<string, number>>();
  /** Bots are state entries, not Colyseus clients. Their ids are reserved here. */
  private botIds = new Set<string>();
  private bots!: BotController;
  private nextBotId = 1;

  onCreate(options: any): void {
    this.setState(new BedwarsState());
    this.spawns = generateMap(this.world);
    for (let t = 0; t < TEAM_COUNT; t++) {
      this.state.teams.push(new TeamState());
      this.genNextAt.push(0);
      this.lastAlarmAt.push(0);
    }
    this.bots = new BotController({
      world: this.world,
      spawns: this.spawns,
      treasures: Array.from({ length: TEAM_COUNT }, (_, t) => treasurePosition(t)),
      getPlayer: (id) => this.state.players.get(id),
      getPhysics: (id) => this.phys.get(id),
      players: () => {
        const players: Array<[string, PlayerState]> = [];
        this.state.players.forEach((p, id) => players.push([id, p]));
        return players;
      },
      bedsAlive: () => this.state.bedsAlive,
      enqueue: (id, input) => {
        const q = this.queues.get(id);
        if (q && q.length < MAX_QUEUE) q.push(input);
      },
      equip: (id, weapon) => this.selectWeaponFor(id, weapon),
      block: (id, enabled) => {
        const p = this.state.players.get(id);
        if (p) p.blocking = enabled && p.weapon === WeaponId.Shield;
      },
      attack: (id, target, aimError) => this.tryAttackFor(id, target, false, aimError),
      breakBlock: (id, x, y, z) => this.tryBreakFor(id, { x, y, z }),
      placeBlock: (id, x, y, z, block) => this.tryPlaceFor(id, { x, y, z, block }),
    });

    // Lobby / matchmaking
    this.onMessage(Msg.SetName, (client, m: { name?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && typeof m?.name === 'string') p.name = m.name.slice(0, 16) || 'Player';
      this.updateMetadata();
    });
    this.onMessage(Msg.Ready, (client, m: { ready?: boolean }) => {
      if (this.state.phase !== 'lobby') return;
      const p = this.state.players.get(client.sessionId);
      if (p) p.ready = !!m?.ready;
      this.updateMetadata();
    });
    this.onMessage(Msg.StartMatch, (client) => {
      if (client.sessionId !== this.state.hostId) return;
      this.tryStartMatch();
    });

    // Gameplay
    this.onMessage(Msg.Input, (client, batch: MoveInput[]) => {
      if (!Array.isArray(batch)) return;
      const q = this.queues.get(client.sessionId);
      if (!q) return;
      for (const input of batch) {
        if (q.length >= MAX_QUEUE) break;
        if (typeof input?.dt !== 'number' || typeof input?.seq !== 'number') continue;
        q.push(input);
      }
    });
    this.onMessage(Msg.Place, (client, m: PlaceMessage) => this.tryPlace(client, m));
    this.onMessage(Msg.Break, (client, m: BreakMessage) => this.tryBreak(client, m));
    this.onMessage(Msg.Attack, (client, m: AttackMessage) => this.tryAttack(client, m));
    this.onMessage(Msg.PowerUp, (client, m: PowerUpMessage) => this.tryPowerUp(client, m));
    this.onMessage(Msg.Purchase, (client, m: PurchaseMessage) => this.tryPurchase(client, m));
    this.onMessage(Msg.UseItem, (client, m: UseItemMessage) => this.tryUseItem(client, m));
    this.onMessage(Msg.Weapon, (client, m: { weapon?: number }) => this.trySelectWeapon(client, m));
    this.onMessage(Msg.Block, (client, m: { blocking?: boolean }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.blocking = !!m?.blocking && p.weapon === WeaponId.Shield;
    });
    this.onMessage(Msg.Unstuck, (client) => this.unstuck(client));
    this.onMessage(Msg.Rematch, () => this.tryRematch());
    this.onMessage(Msg.SetDuration, (client, m: { minutes?: number }) => {
      if (this.state.phase !== 'lobby' || client.sessionId !== this.state.hostId) return;
      const min = Number(m?.minutes);
      if (min === 5 || min === 10 || min === 20) { this.state.durationMin = min; this.updateMetadata(); }
    });
    this.onMessage(Msg.SetTeamSize, (client, m: { size?: number }) => {
      if (this.state.phase !== 'lobby' || client.sessionId !== this.state.hostId) return;
      const size = Number(m?.size);
      if (size === 1 || size === 2 || size === 4) this.state.teamSize = size;
    });
    this.onMessage(Msg.SetBotCount, (client, m: { count?: number }) => {
      if (this.state.phase !== 'lobby' || client.sessionId !== this.state.hostId) return;
      const count = Number(m?.count);
      if (Number.isInteger(count) && count >= 0 && count <= 7) this.syncBots(count);
    });
    this.onMessage(Msg.Ping, (client, t: number) => client.send(Msg.Pong, t));

    this.setMetadata({ name: (options?.roomName as string) || 'Treasure Wars Lobby', phase: 'lobby', players: 0 });
    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  onJoin(client: Client, options: any): void {
    const team = this.pickTeam();
    const spawn = this.spawns[team];
    const p = new PlayerState();
    p.x = spawn.x;
    p.y = spawn.y;
    p.z = spawn.z;
    p.team = team;
    p.name = (typeof options?.name === 'string' && options.name.slice(0, 16)) || `Player-${client.sessionId.slice(0, 4)}`;
    this.state.players.set(client.sessionId, p);
    this.phys.set(client.sessionId, { x: spawn.x, y: spawn.y, z: spawn.z, vx: 0, vz: 0, vy: 0, onGround: false });
    this.queues.set(client.sessionId, []);
    this.powerCooldownAt.set(client.sessionId, new Map());
    this.regenAcc.set(client.sessionId, 0);

    if (!this.state.hostId) this.state.hostId = client.sessionId;

    this.clock.setTimeout(() => {
      client.send(Msg.WorldInit, { diffs: this.diffs });
      this.feed(`${p.name} joined ${TEAMS[team].name} team`);
    }, 100);
    this.updateMetadata();
  }

  onLeave(client: Client): void {
    const wasHost = client.sessionId === this.state.hostId;
    this.state.players.delete(client.sessionId);
    this.phys.delete(client.sessionId);
    this.queues.delete(client.sessionId);
    this.respawnAt.delete(client.sessionId);
    this.lastAttack.delete(client.sessionId);
    this.powerCooldownAt.delete(client.sessionId);
    this.regenAcc.delete(client.sessionId);
    this.fallPeakY.delete(client.sessionId);
    this.airborne.delete(client.sessionId);
    this.lastDamage.delete(client.sessionId);
    this.assistDamage.delete(client.sessionId);

    // If this was the last connected client (with no incoming seat
    // reservations), destroy the room immediately. Colyseus' auto-dispose is
    // blocked by the pending seat-reservation timer for up to ~15s after the
    // room is created, which would otherwise leave an empty "ghost" lobby
    // visible in getAvailableRooms(). disconnect() emits 'dispose' right away.
    if (this.clients.length === 0 && Object.keys(this.reservedSeats).length === 0) {
      this.disconnect().catch(() => {});
      return;
    }

    if (wasHost) this.handleHostLeft();
    this.updateMetadata();
    this.checkWin();
  }

  // --- Lobby ---

  private handleHostLeft(): void {
    // Bots are server-owned state, never hosts. Promote the earliest connected
    // human instead.
    const nextClient = this.clients.find((c) => this.state.players.has(c.sessionId));
    if (nextClient) {
      this.state.hostId = nextClient.sessionId;
      const np = this.state.players.get(this.state.hostId);
      this.broadcast(Msg.Lobby, { kind: 'host', hostId: this.state.hostId });
      if (this.state.phase === 'lobby') {
        this.feed(`${np?.name ?? 'A player'} is now the host`);
      }
    } else {
      this.state.hostId = '';
    }
  }

  private tryStartMatch(): void {
    if (this.state.phase !== 'lobby') return;
    let readyCount = 0;
    this.state.players.forEach((p) => { if (p.ready) readyCount++; });
    if (this.state.players.size < ECONOMY.minMatchPlayers || readyCount < ECONOMY.minMatchPlayers) {
      const host = this.clients.find((c) => c.sessionId === this.state.hostId);
      host?.send(Msg.Notice, { text: `Need at least ${ECONOMY.minMatchPlayers} ready players`, ok: false });
      return;
    }
    this.state.phase = 'playing';
    this.lock(); // no new joins once the match begins
    const now = Date.now();
    this.state.timeLeftMs = this.state.durationMin * 60000; // start the match clock
    this.lastDamage.clear();
    this.assistDamage.clear();
    for (let t = 0; t < TEAM_COUNT; t++) this.genNextAt[t] = now + ECONOMY.generator.levels[0].intervalMs;
    // Give everyone their free starting loadout and spawn them.
    this.state.players.forEach((p, id) => {
      p.wool = ECONOMY.starting.wool;
      p.coins = 0;
      p.coinsEarned = 0;
      p.kills = 0; p.deaths = 0; p.assists = 0;
      // Starting weapon loadout.
      let owned = 0;
      for (const w of STARTING_WEAPONS) owned |= (1 << w);
      p.weapons = owned;
      p.weapon = STARTING_WEAPONS[0] ?? WeaponId.IronSword;
      p.blocking = false;
      // Bots are given a compact tactical loadout at match start. They still
      // collect generators and share every regular combat/block validation,
      // but this lets a mixed bot squad cover each required weapon role.
      if (p.isBot) {
        p.wool = ECONOMY.starting.wool * 2;
        p.weapons = (1 << WeaponId.IronSword) | (1 << WeaponId.Axe) | (1 << WeaponId.Spear) | (1 << WeaponId.Bow) | (1 << WeaponId.Shield);
      }
      this.respawn(id);
    });
    this.feed('The match has begun! Defend your Treasure.');
    this.updateMetadata();
  }

  private updateMetadata(): void {
    let ready = 0;
    this.state.players.forEach((p) => { if (p.ready) ready++; });
    void ready;
    this.setMetadata({
      name: this.metadata?.name ?? 'Treasure Wars Lobby',
      phase: this.state.phase,
      players: this.state.players.size,
    }).catch(() => {});
  }

  /** Create/remove synchronized AI players while the host configures the lobby. */
  private syncBots(count: number): void {
    const desired = Math.max(0, Math.min(7, count | 0));
    const ids = [...this.botIds];
    while (ids.length > desired) {
      const id = ids.pop()!;
      this.botIds.delete(id);
      this.bots.remove(id);
      this.state.players.delete(id);
      this.phys.delete(id);
      this.queues.delete(id);
      this.respawnAt.delete(id);
      this.lastAttack.delete(id);
      this.powerCooldownAt.delete(id);
      this.regenAcc.delete(id);
    }
    while (this.botIds.size < desired) {
      const id = `bot:${this.nextBotId++}`;
      const team = this.pickTeam();
      const spawn = this.spawns[team]!;
      const p = new PlayerState();
      const difficulty = (this.botIds.size % 3) as BotDifficulty;
      p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
      p.team = team; p.name = `${['Easy', 'Medium', 'Hard'][difficulty]} Bot ${this.nextBotId - 1}`;
      p.ready = true; p.isBot = true; p.botDifficulty = difficulty;
      this.state.players.set(id, p);
      this.phys.set(id, { x: spawn.x, y: spawn.y, z: spawn.z, vx: 0, vy: 0, vz: 0, onGround: false });
      this.queues.set(id, []);
      this.powerCooldownAt.set(id, new Map());
      this.regenAcc.set(id, 0);
      this.botIds.add(id);
      this.bots.add(id, difficulty, this.nextBotId);
    }
    this.state.botCount = desired;
    this.updateMetadata();
  }

  private resetBotBrains(): void {
    this.bots.clear();
    this.botIds.clear();
    this.state.players.forEach((p, id) => {
      if (!p.isBot) return;
      this.botIds.add(id);
      this.bots.add(id, p.botDifficulty as BotDifficulty, Number(id.split(':')[1]) || 0);
    });
  }

  /** Anti-stuck: teleport an alive player back to their team spawn safely. */
  private unstuck(client: Client): void {
    if (this.state.phase !== 'playing') return;
    const p = this.state.players.get(client.sessionId);
    const phys = this.phys.get(client.sessionId);
    if (!p || !phys || !p.alive) return;
    const s = this.spawns[p.team];
    phys.x = s.x; phys.y = s.y; phys.z = s.z;
    phys.vx = 0; phys.vy = 0; phys.vz = 0; phys.onGround = false;
    p.x = s.x; p.y = s.y; p.z = s.z; p.vx = 0; p.vy = 0; p.vz = 0;
    this.clearFall(client.sessionId);
    const q = this.queues.get(client.sessionId);
    if (q) q.length = 0;
    client.send(Msg.Teleport, { x: s.x, y: s.y, z: s.z });
  }

  private tryRematch(): void {
    // Only meaningful once the match has ended; first click resets, rest no-op.
    if (this.state.phase !== 'ended') return;
    this.resetMatch();
  }

  /** Reset a finished match back to a fresh lobby (same room, no disconnects). */
  private resetMatch(): void {
    // Keep these objects stable: BotController owns references to the same
    // deterministic world and spawn list used by normal player simulation.
    this.world.data.fill(0);
    const freshSpawns = generateMap(this.world);
    this.spawns.splice(0, this.spawns.length, ...freshSpawns);
    this.diffs = [];

    this.state.bedsAlive = 0b1111;
    this.state.winner = -1;
    this.state.phase = 'lobby';
    this.state.timeLeftMs = 0;
    this.lastDamage.clear();
    this.assistDamage.clear();

    for (let t = 0; t < TEAM_COUNT; t++) {
      const ts = this.state.teams[t];
      if (ts) { ts.armorTier = 0; ts.genLevel = 0; ts.alarmArmed = false; }
      this.genNextAt[t] = 0;
      this.lastAlarmAt[t] = 0;
    }

    this.state.drops.clear();
    this.state.projectiles.clear();
    this.state.tnts.clear();
    this.projMeta.clear();
    this.tntExplodeAt.clear();

    this.state.players.forEach((p, id) => {
      const s = this.spawns[p.team];
      p.ready = p.isBot;
      p.alive = true; p.hp = 20;
      p.x = s.x; p.y = s.y; p.z = s.z; p.vx = 0; p.vy = 0; p.vz = 0; p.yaw = 0;
      p.coins = 0; p.coinsEarned = 0;
      p.wool = 0; p.plank = 0; p.stone = 0;
      p.pickTier = 0; p.shears = false;
      p.tnt = 0; p.pearls = 0; p.fireballs = 0; p.alarms = 0;
      p.weapons = 1 << WeaponId.IronSword; p.weapon = WeaponId.IronSword; p.blocking = false;
      p.kills = 0; p.deaths = 0; p.assists = 0;
      p.effects.clear();
      const phys = this.phys.get(id);
      if (phys) { phys.x = s.x; phys.y = s.y; phys.z = s.z; phys.vx = 0; phys.vy = 0; phys.vz = 0; phys.onGround = false; }
      const q = this.queues.get(id); if (q) q.length = 0;
      this.clearFall(id);
      this.respawnAt.delete(id);
      this.lastAttack.delete(id);
      this.powerCooldownAt.get(id)?.clear();
      this.regenAcc.set(id, 0);
    });

    this.resetBotBrains();

    this.unlock().catch(() => {});
    this.broadcast(Msg.WorldReset, {});
    this.feed('Returning to lobby — ready up for another match!');
    this.updateMetadata();
  }

  // --- Simulation ---

  private tick(): void {
    if (this.state.phase !== 'playing') return;
    const now = Date.now();

    // Match timer: when it hits 0, end the match and decide the winner on points.
    if (this.state.timeLeftMs > 0) {
      this.state.timeLeftMs = Math.max(0, this.state.timeLeftMs - TICK_MS);
      if (this.state.timeLeftMs <= 0) { this.endByTime(); return; }
    }

    // AI only decides at its difficulty-specific cadence, but feeds the exact
    // same queued MoveInput + physics controller used by every human player.
    this.bots.tick(now);

    this.state.players.forEach((p, id) => {
      const phys = this.phys.get(id);
      const q = this.queues.get(id);
      if (!phys || !q) return;
      const mods = this.modsFor(id, now);

      if (!p.alive) {
        q.length = 0;
        const at = this.respawnAt.get(id);
        if (at !== undefined && now >= at) this.respawn(id);
        return;
      }

      if (p.effects.has(String(PowerUp.Regeneration)) && p.hp < 20) {
        const regenDef = POWERUPS[PowerUp.Regeneration];
        let acc = (this.regenAcc.get(id) ?? 0) + regenDef.regenPerSec * (TICK_MS / 1000);
        while (acc >= 1 && p.hp < 20) { p.hp = Math.min(20, p.hp + 1); acc -= 1; }
        this.regenAcc.set(id, acc);
      }

      const inputs = q.splice(0, MAX_INPUTS_PER_TICK);
      for (const input of inputs) {
        stepPlayer(phys, input, this.world.isSolid, mods);
        p.yaw = input.yaw;
        p.lastSeq = input.seq >>> 0;
      }
      if (phys.y < VOID_Y) { this.die(id, -1); return; }
      this.updateFallDamage(id, phys);
      p.x = phys.x; p.y = phys.y; p.z = phys.z;
      p.vx = phys.vx; p.vz = phys.vz; p.vy = phys.vy;
    });

    this.updateGenerators(now);
    this.collectCoins();
    this.updateProjectiles();
    this.updateTnts(now);
    this.updateAlarms(now);
  }

  // --- Economy: generators + coin drops ---

  private updateGenerators(now: number): void {
    const cfg = ECONOMY.generator;
    // Which teams have at least one connected player.
    const teamHasPlayers = new Array(TEAM_COUNT).fill(false);
    this.state.players.forEach((p) => { teamHasPlayers[p.team] = true; });

    for (let t = 0; t < TEAM_COUNT; t++) {
      if (!teamHasPlayers[t]) continue;
      if (now < this.genNextAt[t]) continue;
      const level = cfg.levels[this.state.teams[t]!.genLevel] ?? cfg.levels[0]!;
      this.genNextAt[t] = now + level.intervalMs;

      // Count existing drops for this generator.
      let count = 0;
      this.state.drops.forEach((d) => { if (d.team === t) count++; });
      if (count >= cfg.maxDrops) continue;

      const g = this.spawns[t];
      const drop = new CoinDrop();
      drop.x = g.gx + (Math.random() - 0.5) * 1.2;
      drop.y = g.gy;
      drop.z = g.gz + (Math.random() - 0.5) * 1.2;
      drop.team = t;
      this.state.drops.set(`c${this.idCounter++}`, drop);
    }
  }

  private collectCoins(): void {
    const r = ECONOMY.generator.collectRadius;
    const r2 = r * r;
    const toRemove: string[] = [];
    this.state.drops.forEach((d, key) => {
      let taker: PlayerState | null = null;
      this.state.players.forEach((p) => {
        if (taker || !p.alive) return;
        const dx = p.x - d.x;
        const dy = p.y + 0.9 - d.y;
        const dz = p.z - d.z;
        if (dx * dx + dz * dz <= r2 && Math.abs(dy) < 2.2) taker = p;
      });
      if (taker) {
        (taker as PlayerState).coins += ECONOMY.generator.dropValue;
        (taker as PlayerState).coinsEarned += ECONOMY.generator.dropValue;
        toRemove.push(key);
      }
    });
    for (const k of toRemove) this.state.drops.delete(k);
  }

  // --- Shop ---

  private tryPurchase(client: Client, m: PurchaseMessage): void {
    if (this.state.phase !== 'playing') return;
    const p = this.state.players.get(client.sessionId);
    if (!p?.alive) return;
    const team = this.state.teams[p.team]!;
    const id = m?.id;
    const notice = (text: string, ok: boolean) => client.send(Msg.Notice, { text, ok });

    const charge = (cost: number): boolean => {
      if (p.coins < cost) { notice(`Not enough coins (need ${cost})`, false); return false; }
      p.coins -= cost;
      return true;
    };

    switch (id) {
      case 'block_wool': {
        const b = ECONOMY.blocks.wool; const cost = b.price * b.stack;
        if (!charge(cost)) return;
        p.wool += b.stack; notice(`+${b.stack} Wool`, true); break;
      }
      case 'block_plank': {
        const b = ECONOMY.blocks.plank; const cost = b.price * b.stack;
        if (!charge(cost)) return;
        p.plank += b.stack; notice(`+${b.stack} Planks`, true); break;
      }
      case 'block_stone': {
        const b = ECONOMY.blocks.stone; const cost = b.price * b.stack;
        if (p.coinsEarned < b.unlockCoinsEarned) { notice(`Stone unlocks after earning ${b.unlockCoinsEarned} coins`, false); return; }
        if (!charge(cost)) return;
        p.stone += b.stack; notice(`+${b.stack} Stone`, true); break;
      }
      case 'weapon_axe': this.buyWeapon(client, p, WeaponId.Axe, charge, notice); break;
      case 'weapon_pickaxe': this.buyWeapon(client, p, WeaponId.Pickaxe, charge, notice); break;
      case 'weapon_spear': this.buyWeapon(client, p, WeaponId.Spear, charge, notice); break;
      case 'weapon_bow': this.buyWeapon(client, p, WeaponId.Bow, charge, notice); break;
      case 'weapon_shield': this.buyWeapon(client, p, WeaponId.Shield, charge, notice); break;
      case 'weapon_doubleaxe': this.buyWeapon(client, p, WeaponId.DoubleAxe, charge, notice); break;
      case 'armor': {
        const next = team.armorTier + 1;
        if (next >= ECONOMY.armor.length) { notice('Max armor tier', false); return; }
        if (!charge(ECONOMY.armor[next].price)) return;
        team.armorTier = next;
        this.feed(`${TEAMS[p.team].name} team upgraded to ${ECONOMY.armor[next].name}`);
        notice(`Team armor: ${ECONOMY.armor[next].name}`, true); break;
      }
      case 'pick': {
        const next = p.pickTier + 1;
        if (next >= ECONOMY.pickaxes.length) { notice('Max pickaxe tier', false); return; }
        if (!charge(ECONOMY.pickaxes[next].price)) return;
        p.pickTier = next; notice(`Bought ${ECONOMY.pickaxes[next].name}`, true); break;
      }
      case 'shears': {
        if (p.shears) { notice('Already own Shears', false); return; }
        if (!charge(ECONOMY.shears.price)) return;
        p.shears = true; notice('Bought Shears', true); break;
      }
      case 'tnt': {
        if (!charge(ECONOMY.utility.tnt.price)) return;
        p.tnt += 1; notice('+1 TNT', true); break;
      }
      case 'pearl': {
        if (!charge(ECONOMY.utility.pearl.price)) return;
        p.pearls += 1; notice('+1 Ender Pearl', true); break;
      }
      case 'fireball': {
        if (!charge(ECONOMY.utility.fireball.price)) return;
        p.fireballs += 1; notice('+1 Fireball', true); break;
      }
      case 'alarm': {
        if (!charge(ECONOMY.utility.alarm.price)) return;
        p.alarms += 1; notice('+1 Alarm Trap', true); break;
      }
      case 'gen_upgrade': {
        const next = team.genLevel + 1;
        if (next >= ECONOMY.generator.levels.length) { notice('Generator maxed', false); return; }
        if (!charge(ECONOMY.generator.levels[next].cost)) return;
        team.genLevel = next;
        this.feed(`${TEAMS[p.team].name} team upgraded their generator (Lv ${next})`);
        notice(`Generator upgraded to Lv ${next}`, true); break;
      }
      default:
        notice('Unknown item', false);
    }
  }

  private buyWeapon(
    _client: Client, p: PlayerState, w: WeaponId,
    charge: (cost: number) => boolean, notice: (t: string, ok: boolean) => void,
  ): void {
    const def = WEAPONS[w];
    if ((p.weapons >> w) & 1) { notice(`Already own ${def.name}`, false); return; }
    if (!charge(def.price)) return;
    p.weapons |= (1 << w);
    p.weapon = w; // auto-equip the new weapon
    if (w !== WeaponId.Shield) p.blocking = false;
    notice(`Bought ${def.name}`, true);
  }

  // --- Utility items ---

  private tryUseItem(client: Client, m: UseItemMessage): void {
    if (this.state.phase !== 'playing') return;
    const p = this.state.players.get(client.sessionId);
    const phys = this.phys.get(client.sessionId);
    if (!p?.alive || !phys) return;

    switch (m?.item) {
      case 'tnt': {
        if (p.tnt <= 0) return;
        const x = Math.floor(m.x); const y = Math.floor(m.y); const z = Math.floor(m.z);
        if (!this.world.inBounds(x, y, z) || this.world.get(x, y, z) !== BlockType.Air) return;
        if (!this.inReach(client.sessionId, x, y, z)) return;
        p.tnt -= 1;
        const tnt = new Tnt();
        tnt.x = x + 0.5; tnt.y = y; tnt.z = z + 0.5; tnt.team = p.team;
        const key = `t${this.idCounter++}`;
        this.state.tnts.set(key, tnt);
        this.tntExplodeAt.set(key, Date.now() + ECONOMY.utility.tnt.fuseMs);
        break;
      }
      case 'pearl':
      case 'fireball': {
        const isPearl = m.item === 'pearl';
        if (isPearl && p.pearls <= 0) return;
        if (!isPearl && p.fireballs <= 0) return;
        const len = Math.hypot(m.dx, m.dy, m.dz) || 1;
        const dir = { x: m.dx / len, y: m.dy / len, z: m.dz / len };
        const speed = isPearl ? ECONOMY.utility.pearl.speed : ECONOMY.utility.fireball.speed;
        const proj = new Projectile();
        proj.x = phys.x + dir.x * 0.8;
        proj.y = phys.y + PLAYER_EYE + dir.y * 0.8;
        proj.z = phys.z + dir.z * 0.8;
        proj.kind = isPearl ? 0 : 1;
        proj.team = p.team;
        const key = `p${this.idCounter++}`;
        this.state.projectiles.set(key, proj);
        this.projMeta.set(key, {
          vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed,
          owner: client.sessionId, team: p.team,
          ttl: (isPearl ? ECONOMY.utility.pearl.ttlMs : ECONOMY.utility.fireball.ttlMs) / 1000,
          kind: isPearl ? 0 : 1,
        });
        if (isPearl) p.pearls -= 1; else p.fireballs -= 1;
        break;
      }
      case 'alarm': {
        if (p.alarms <= 0) return;
        p.alarms -= 1;
        this.state.teams[p.team]!.alarmArmed = true;
        client.send(Msg.Notice, { text: 'Alarm Trap armed on your island', ok: true });
        break;
      }
    }
  }

  private updateProjectiles(): void {
    const dt = 1 / TICK_RATE;
    const remove: string[] = [];
    this.state.projectiles.forEach((proj, key) => {
      const meta = this.projMeta.get(key);
      if (!meta) { remove.push(key); return; }
      meta.ttl -= dt;
      if (meta.kind === 1 || meta.kind === 2) meta.vy -= (meta.gravity ?? (meta.kind === 1 ? 12 : 11)) * dt;

      // Substep to avoid tunneling through thin walls.
      const steps = 6;
      const sdt = dt / steps;
      let landed = false;
      let hitPlayer: string | null = null;
      for (let s = 0; s < steps && !landed; s++) {
        proj.x += meta.vx * sdt;
        proj.y += meta.vy * sdt;
        proj.z += meta.vz * sdt;
        if (this.world.isSolid(Math.floor(proj.x), Math.floor(proj.y), Math.floor(proj.z))) { landed = true; break; }
        // Enemy collision for fireballs and authoritative bow arrows.
        this.state.players.forEach((pl, pid) => {
          if (hitPlayer || pid === meta.owner || !pl.alive || pl.team === meta.team) return;
          const dx = pl.x - proj.x; const dy = pl.y + 1 - proj.y; const dz = pl.z - proj.z;
          if (dx * dx + dy * dy + dz * dz < 0.8) hitPlayer = pid;
        });
        if (hitPlayer) { landed = true; }
      }

      if (landed || meta.ttl <= 0) {
        if (meta.kind === 0) {
          // Ender pearl: teleport owner to the landing spot.
          const ph = this.phys.get(meta.owner);
          const pl = this.state.players.get(meta.owner);
          if (ph && pl?.alive) {
            ph.x = proj.x; ph.y = proj.y + 0.1; ph.z = proj.z; ph.vy = 0; ph.vx = 0; ph.vz = 0;
            pl.x = ph.x; pl.y = ph.y; pl.z = ph.z; pl.vx = 0; pl.vy = 0; pl.vz = 0;
            this.clearFall(meta.owner);
            const c = this.clients.find((cc) => cc.sessionId === meta.owner);
            c?.send(Msg.Teleport, { x: ph.x, y: ph.y, z: ph.z });
          }
        } else if (meta.kind === 1) {
          const f = ECONOMY.utility.fireball;
          this.explode(proj.x, proj.y, proj.z, f.radius, f.damage, f.knockback, meta.owner, meta.team, 'fireball');
        } else if (meta.kind === 2 && hitPlayer) {
          this.applyMeleeDamage(meta.owner, hitPlayer, meta.damage ?? 6, 0.55, false);
        }
        remove.push(key);
      }
    });
    for (const k of remove) { this.state.projectiles.delete(k); this.projMeta.delete(k); }
  }

  private updateTnts(now: number): void {
    const remove: string[] = [];
    this.state.tnts.forEach((tnt, key) => {
      const at = this.tntExplodeAt.get(key);
      if (at !== undefined && now >= at) {
        const c = ECONOMY.utility.tnt;
        this.explode(tnt.x, tnt.y + 0.5, tnt.z, c.radius, c.damage, KNOCKBACK_H, '', tnt.team, 'tnt');
        remove.push(key);
      }
    });
    for (const k of remove) { this.state.tnts.delete(k); this.tntExplodeAt.delete(k); }
  }

  private explode(
    x: number, y: number, z: number, radius: number, damage: number, knockback: number,
    owner: string, ownerTeam: number, kind: 'tnt' | 'fireball',
  ): void {
    // Damage + knockback players in range.
    this.state.players.forEach((pl, pid) => {
      if (!pl.alive) return;
      const ph = this.phys.get(pid);
      if (!ph) return;
      const dx = ph.x - x; const dy = ph.y + 1 - y; const dz = ph.z - z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) return;
      const falloff = 1 - dist / radius;
      const hl = Math.hypot(dx, dz) || 1;
      ph.vx += (dx / hl) * knockback * falloff;
      ph.vz += (dz / hl) * knockback * falloff;
      ph.vy = Math.max(ph.vy, KNOCKBACK_V * falloff);
      ph.onGround = false;
      pl.vx = ph.vx; pl.vz = ph.vz; pl.vy = ph.vy;
      // Own team / self takes reduced self-damage; enemies full.
      const own = pid === owner || pl.team === ownerTeam;
      if (owner && !own) this.recordDamage(pid, owner);
      const dmg = Math.max(1, Math.round(damage * falloff * (own ? 0.4 : 1) * this.armorMult(pl.team)));
      if (dmg >= pl.hp) this.die(pid, ownerTeam, own ? '' : owner);
      else pl.hp -= dmg;
    });

    // Destroy breakable, non-bed blocks in a cube around the blast.
    const r = Math.ceil(radius);
    for (let bx = Math.floor(x - r); bx <= x + r; bx++) {
      for (let by = Math.floor(y - r); by <= y + r; by++) {
        for (let bz = Math.floor(z - r); bz <= z + r; bz++) {
          const dd = Math.hypot(bx + 0.5 - x, by + 0.5 - y, bz + 0.5 - z);
          if (dd > radius) continue;
          const b = this.world.get(bx, by, bz);
          if (b === BlockType.Air || !BLOCKS[b]?.breakable || isBed(b)) continue;
          this.applyBlock(bx, by, bz, BlockType.Air);
        }
      }
    }
    this.broadcast(Msg.Explosion, { x, y, z, radius, kind });
  }

  private updateAlarms(now: number): void {
    for (let t = 0; t < TEAM_COUNT; t++) {
      if (!this.state.teams[t]!.alarmArmed) continue;
      if (now - this.lastAlarmAt[t] < ALARM_COOLDOWN_MS) continue;
      const s = this.spawns[t];
      let intruder = false;
      this.state.players.forEach((pl) => {
        if (intruder || !pl.alive || pl.team === t) return;
        const dx = pl.x - s.x; const dz = pl.z - s.z;
        if (Math.hypot(dx, dz) <= ISLAND_ALARM_RADIUS) intruder = true;
      });
      if (intruder) {
        this.lastAlarmAt[t] = now;
        this.sendToTeam(t, Msg.Notice, { text: '\u26A0 ALARM: enemy on your island!', ok: false });
      }
    }
  }

  private sendToTeam(team: number, channel: string, payload: unknown): void {
    for (const c of this.clients) {
      const p = this.state.players.get(c.sessionId);
      if (p && p.team === team) c.send(channel, payload);
    }
  }

  private armorMult(team: number): number {
    const tier = this.state.teams[team]?.armorTier ?? 0;
    return 1 - (ECONOMY.armor[tier]?.reduction ?? 0);
  }

  // --- Existing combat / blocks (extended for economy) ---

  private modsFor(id: string, now: number): StepMods & { strengthBonus: number; damageTaken: number; hasteMult: number } {
    const p = this.state.players.get(id);
    const out = { speedMult: 1, jumpMult: 1, strengthBonus: 0, damageTaken: 1, hasteMult: 1 };
    if (!p) return out;
    p.effects.forEach((expiry, key) => {
      if (expiry <= now) { p.effects.delete(key); return; }
      const def = POWERUPS[Number(key) as PowerUp];
      if (!def) return;
      out.speedMult *= def.speedMult;
      out.jumpMult *= def.jumpMult;
      out.strengthBonus += def.strengthBonus;
      out.hasteMult *= def.hasteMult;
      out.damageTaken *= def.damageTaken;
    });
    // Shield: raising it slows movement.
    if (p.blocking && p.weapon === WeaponId.Shield) out.speedMult *= 0.55;
    return out;
  }

  /** Record that `attackerId` damaged `victimId` (for kill/assist attribution). */
  private recordDamage(victimId: string, attackerId: string): void {
    if (!attackerId || attackerId === victimId) return;
    const now = Date.now();
    this.lastDamage.set(victimId, { by: attackerId, at: now });
    let am = this.assistDamage.get(victimId);
    if (!am) { am = new Map(); this.assistDamage.set(victimId, am); }
    am.set(attackerId, now);
    this.bots.onDamaged(victimId, attackerId);
  }

  /** Credit a kill (+ assists) on death; falls back to the last damager (void/knockback kills). */
  private creditKill(victimId: string, byId: string): void {
    const now = Date.now();
    const victim = this.state.players.get(victimId);
    if (victim) victim.deaths += 1;
    let killerId = byId;
    if (!killerId) { const ld = this.lastDamage.get(victimId); if (ld && now - ld.at < 8000) killerId = ld.by; }
    if (killerId && killerId !== victimId) {
      const killer = this.state.players.get(killerId);
      if (killer && (!victim || killer.team !== victim.team)) killer.kills += 1;
    }
    const am = this.assistDamage.get(victimId);
    if (am) {
      am.forEach((t, aid) => {
        if (now - t > 10000 || aid === killerId || aid === victimId) return;
        const a = this.state.players.get(aid);
        if (a && victim && a.team !== victim.team) a.assists += 1;
      });
      am.clear();
    }
    this.lastDamage.delete(victimId);
  }

  private die(id: string, byTeam: number, byId = ''): void {
    const p = this.state.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.effects.clear();
    this.creditKill(id, byId);
    // Drop half of carried coins on death (economy sink).
    p.coins = Math.floor(p.coins / 2);
    const bedAlive = ((this.state.bedsAlive >> p.team) & 1) === 1;
    const cause = byTeam >= 0 ? `by ${TEAMS[byTeam].name}` : 'in the void';
    if (bedAlive) {
      this.respawnAt.set(id, Date.now() + RESPAWN_SECONDS * 1000);
      this.feed(`${p.name} was slain ${cause}`);
    } else {
      this.respawnAt.delete(id);
      this.feed(`${p.name} was ELIMINATED ${cause}`);
      this.checkWin();
    }
  }

  private respawn(id: string): void {
    const p = this.state.players.get(id);
    const phys = this.phys.get(id);
    if (!p || !phys) return;
    const s = this.spawns[p.team];
    phys.x = s.x; phys.y = s.y; phys.z = s.z;
    phys.vx = 0; phys.vz = 0; phys.vy = 0; phys.onGround = false;
    p.x = s.x; p.y = s.y; p.z = s.z;
    p.vx = 0; p.vz = 0; p.vy = 0;
    p.hp = 20; p.alive = true;
    this.respawnAt.delete(id);
    this.fallPeakY.delete(id);
    this.airborne.delete(id);
  }

  /** Reset fall tracking after any teleport/reset so the drop isn't punished. */
  private clearFall(id: string): void {
    this.fallPeakY.delete(id);
    this.airborne.delete(id);
  }

  /**
   * Server-authoritative fall damage. Tracks the apex height while a player is
   * airborne and, on landing, applies 1 hp per block fallen beyond a safe
   * threshold. Ignores upward knockback launches only for the safe margin; a
   * long fall after a knockback still hurts. Never triggers in the void (that
   * path is handled by the VOID_Y death check before this runs).
   */
  private updateFallDamage(id: string, phys: PlayerPhysics): void {
    const wasAirborne = this.airborne.get(id) ?? false;
    if (!phys.onGround) {
      // Rising or falling: remember the highest point reached this arc.
      const peak = this.fallPeakY.get(id);
      if (!wasAirborne || peak === undefined) this.fallPeakY.set(id, phys.y);
      else if (phys.y > peak) this.fallPeakY.set(id, phys.y);
      this.airborne.set(id, true);
      return;
    }
    // Just landed.
    if (wasAirborne) {
      const peak = this.fallPeakY.get(id) ?? phys.y;
      const dropped = peak - phys.y;
      const over = dropped - FALL_SAFE_BLOCKS;
      if (over > 0) {
        const p = this.state.players.get(id);
        if (p && p.alive) {
          const dmg = Math.max(1, Math.round(over * FALL_DMG_PER_BLOCK));
          if (dmg >= p.hp) this.die(id, -1);
          else p.hp -= dmg; // hp drop syncs via state; client auto-flashes damage
        }
      }
    }
    this.airborne.set(id, false);
    this.fallPeakY.delete(id);
  }

  /** Timer expired: rank teams by treasure alive, then kills, then survivors. */
  private endByTime(): void {
    if (this.state.phase !== 'playing') return;
    const stats: Array<{ t: number; bed: number; kills: number; alive: number }> = [];
    for (let t = 0; t < TEAM_COUNT; t++) {
      let present = false; let kills = 0; let alive = 0;
      this.state.players.forEach((p) => {
        if (p.team !== t) return;
        present = true; kills += p.kills; if (p.alive) alive++;
      });
      if (present) stats.push({ t, bed: (this.state.bedsAlive >> t) & 1, kills, alive });
    }
    stats.sort((a, b) => b.bed - a.bed || b.kills - a.kills || b.alive - a.alive);
    this.state.winner = stats.length ? stats[0].t : -1;
    this.state.phase = 'ended';
    this.feed(this.state.winner >= 0 ? `Time! ${TEAMS[this.state.winner].name} team wins on points!` : 'Time! Match over.');
  }

  private checkWin(): void {
    if (this.state.phase !== 'playing' || this.state.winner >= 0) return;
    const teamsPresent = new Set<number>();
    const teamsInGame = new Set<number>();
    this.state.players.forEach((p) => {
      teamsPresent.add(p.team);
      const bedAlive = ((this.state.bedsAlive >> p.team) & 1) === 1;
      if (p.alive || bedAlive) teamsInGame.add(p.team);
    });
    if (teamsPresent.size >= 2 && teamsInGame.size === 1) {
      const winner = teamsInGame.values().next().value as number;
      this.state.winner = winner;
      this.state.phase = 'ended';
      this.feed(`${TEAMS[winner].name} team WINS!`);
    }
  }

  private pickTeam(): number {
    const counts = new Array(TEAM_COUNT).fill(0);
    this.state.players.forEach((p) => counts[p.team]++);
    let best = 0;
    for (let t = 1; t < TEAM_COUNT; t++) if (counts[t] < counts[best]) best = t;
    return best;
  }

  private inReach(id: string, x: number, y: number, z: number): boolean {
    const phys = this.phys.get(id);
    if (!phys) return false;
    const dx = x + 0.5 - phys.x;
    const dy = y + 0.5 - (phys.y + 1.6);
    const dz = z + 0.5 - phys.z;
    return dx * dx + dy * dy + dz * dz <= (REACH + 1.5) ** 2;
  }

  private intersectsAnyPlayer(x: number, y: number, z: number): boolean {
    for (const phys of this.phys.values()) {
      if (
        x + 1 > phys.x - PLAYER_HALF_W && x < phys.x + PLAYER_HALF_W &&
        y + 1 > phys.y && y < phys.y + PLAYER_HEIGHT &&
        z + 1 > phys.z - PLAYER_HALF_W && z < phys.z + PLAYER_HALF_W
      ) {
        return true;
      }
    }
    return false;
  }

  /** Map a placeable block type to the player's inventory field. */
  private invFieldFor(p: PlayerState, block: number): 'wool' | 'plank' | 'stone' | null {
    if (block === TEAMS[p.team].wool) return 'wool';
    if (block === BlockType.Plank) return 'plank';
    if (block === BlockType.Stone) return 'stone';
    return null;
  }

  private tryPlace(client: Client, m: PlaceMessage): void {
    this.tryPlaceFor(client.sessionId, m, (text, ok) => client.send(Msg.Notice, { text, ok }));
  }

  private tryPlaceFor(id: string, m: PlaceMessage, notice?: (text: string, ok: boolean) => void): boolean {
    if (this.state.phase !== 'playing') return false;
    const { x, y, z, block } = m ?? {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
    const p = this.state.players.get(id);
    if (!p?.alive) return false;
    const def = BLOCKS[block];
    if (!def?.placeable) return false;
    // Must own the block in inventory.
    const field = this.invFieldFor(p, block);
    if (!field || p[field] <= 0) { notice?.('Out of that block', false); return false; }
    if (!this.world.inBounds(x, y, z)) return false;
    if (this.world.get(x, y, z) !== BlockType.Air) return false;
    if (!this.inReach(id, x, y, z)) return false;
    if (this.intersectsAnyPlayer(x, y, z)) return false;
    p[field] -= 1;
    this.applyBlock(x, y, z, block);
    return true;
  }

  private tryBreak(client: Client, m: BreakMessage): void {
    this.tryBreakFor(client.sessionId, m);
  }

  private tryBreakFor(id: string, m: BreakMessage): boolean {
    if (this.state.phase !== 'playing') return false;
    const { x, y, z } = m ?? {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
    const p = this.state.players.get(id);
    if (!p?.alive) return false;
    const b = this.world.get(x, y, z);
    if (b === BlockType.Air || !BLOCKS[b]?.breakable) return false;
    if (!this.inReach(id, x, y, z)) return false;

    const bt = bedTeam(b);
    if (bt >= 0) {
      if (p.team === bt) return false;
      this.applyBlock(x, y, z, BlockType.Air);
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (this.world.get(x + ox, y, z + oz) === b) this.applyBlock(x + ox, y, z + oz, BlockType.Air);
      }
      this.state.bedsAlive &= ~(1 << bt);
      this.broadcast(Msg.BedDestroyed, { team: bt, by: p.team, x, y, z });
      this.feed(`${TEAMS[bt].name} Treasure was destroyed by ${p.name}! They can no longer respawn.`);
      this.checkWin();
      return true;
    }
    this.applyBlock(x, y, z, BlockType.Air);
    return true;
  }

  private tryAttack(client: Client, m: AttackMessage): void {
    this.tryAttackFor(client.sessionId, m?.target, !!m?.crit);
  }

  private tryAttackFor(id: string, targetId: unknown, crit: boolean, aimError = 0): boolean {
    if (this.state.phase !== 'playing') return false;
    const attacker = this.state.players.get(id);
    if (!attacker?.alive) return false;
    if (typeof targetId !== 'string') return false;
    const victim = this.state.players.get(targetId);
    if (!victim?.alive || targetId === id) return false;
    if (victim.team === attacker.team) return false;

    // Active weapon governs damage / cooldown / range / knockback.
    const weapon = WEAPONS[attacker.weapon as WeaponId] ?? WEAPONS[WeaponId.IronSword];
    if (weapon.shield || attacker.blocking) return false; // can't attack while shielding

    const now = Date.now();
    const last = this.lastAttack.get(id) ?? 0;
    if (now - last < weapon.cooldownMs) return false;

    const ap = this.phys.get(id);
    const vp = this.phys.get(targetId);
    if (!ap || !vp) return false;

    const dx = vp.x - ap.x;
    const dy = vp.y + PLAYER_EYE * 0.5 - (ap.y + PLAYER_EYE);
    const dz = vp.z - ap.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > weapon.range + 0.8) return false;

    this.lastAttack.set(id, now);
    if (weapon.ranged) this.fireArrow(id, targetId, weapon, aimError);
    else this.applyMeleeDamage(id, targetId, weapon.damage, weapon.knockback, crit);
    return true;
  }

  /** Shared melee resolution (weapons + explosions can reuse the knockback/armor path). */
  private applyMeleeDamage(attackerId: string, targetId: string, baseDamage: number, knockbackMult: number, crit: boolean): void {
    const attacker = this.state.players.get(attackerId);
    const victim = this.state.players.get(targetId);
    const ap = this.phys.get(attackerId);
    const vp = this.phys.get(targetId);
    if (!attacker || !victim || !ap || !vp) return;
    const now = Date.now();
    this.recordDamage(targetId, attackerId);
    const mods = this.modsFor(attackerId, now);
    const vmods = this.modsFor(targetId, now);

    let dmg = (baseDamage + mods.strengthBonus) * (crit ? CRIT_MULT : 1);
    dmg *= this.armorMult(victim.team); // team armor reduction
    dmg *= vmods.damageTaken; // shield power-up
    // Shield weapon actively blocking: heavy damage + knockback reduction.
    const blocking = victim.blocking && victim.weapon === WeaponId.Shield;
    if (blocking) dmg *= 0.25;
    dmg = Math.max(1, Math.round(dmg));

    const dx = vp.x - ap.x;
    const dz = vp.z - ap.z;
    const hlen = Math.hypot(dx, dz) || 1;
    const push = KNOCKBACK_H * knockbackMult * (crit ? 1.25 : 1) * (blocking ? 0.4 : 1);
    vp.vx += (dx / hlen) * push;
    vp.vz += (dz / hlen) * push;
    vp.vy = KNOCKBACK_V * (crit ? 1.2 : 1) * (blocking ? 0.5 : 1);
    vp.onGround = false;
    victim.vx = vp.vx; victim.vz = vp.vz; victim.vy = vp.vy;

    const fatal = dmg >= victim.hp;
    if (fatal) this.die(targetId, attacker.team, attackerId);
    else victim.hp -= dmg;

    this.broadcast(Msg.Hit, { target: targetId, by: attackerId, x: vp.x, y: vp.y + 1, z: vp.z, crit, fatal });
  }

  /** Spawn a server-authoritative arrow. Bots pass an aim error by difficulty; human shots use zero error. */
  private fireArrow(attackerId: string, targetId: string, weapon: typeof WEAPONS[WeaponId.Bow], aimError: number): void {
    const ap = this.phys.get(attackerId);
    const vp = this.phys.get(targetId);
    const attacker = this.state.players.get(attackerId);
    if (!ap || !vp || !attacker || !weapon.ranged) return;
    const cfg = weapon.ranged;
    const horizontal = Math.hypot(vp.x - ap.x, vp.z - ap.z);
    const t = Math.max(0.08, horizontal / cfg.speed);
    const errorX = (Math.random() - 0.5) * aimError;
    const errorY = (Math.random() - 0.5) * aimError * 0.35;
    const errorZ = (Math.random() - 0.5) * aimError;
    const tx = vp.x + vp.vx * t + errorX;
    const tz = vp.z + vp.vz * t + errorZ;
    const oy = ap.y + PLAYER_EYE;
    const ty = vp.y + PLAYER_EYE * 0.55 + vp.vy * t + errorY;
    const dx = tx - ap.x; const dz = tz - ap.z;
    const h = Math.hypot(dx, dz) || 1;
    const proj = new Projectile();
    proj.x = ap.x + (dx / h) * 0.7;
    proj.y = oy;
    proj.z = ap.z + (dz / h) * 0.7;
    proj.kind = 2; proj.team = attacker.team;
    const key = `p${this.idCounter++}`;
    this.state.projectiles.set(key, proj);
    this.projMeta.set(key, {
      vx: (dx / h) * cfg.speed,
      vy: (ty - oy + 0.5 * cfg.gravity * t * t) / t,
      vz: (dz / h) * cfg.speed,
      owner: attackerId, team: attacker.team, ttl: cfg.projectileLifetimeMs / 1000,
      kind: 2, damage: weapon.damage, gravity: cfg.gravity,
    });
  }

  private trySelectWeapon(client: Client, m: { weapon?: number }): void {
    this.selectWeaponFor(client.sessionId, m?.weapon as WeaponId);
  }

  private selectWeaponFor(id: string, w: WeaponId): void {
    const p = this.state.players.get(id);
    if (!p) return;
    if (!(w in WEAPONS)) return;
    if (!((p.weapons >> w) & 1)) return; // must own it
    p.weapon = w;
    if (w !== WeaponId.Shield) p.blocking = false;
  }

  private tryPowerUp(client: Client, m: PowerUpMessage): void {
    if (this.state.phase !== 'playing') return;
    const p = this.state.players.get(client.sessionId);
    if (!p?.alive) return;
    const type = m?.type as PowerUp;
    const def = POWERUPS[type];
    if (!def) return;
    const now = Date.now();
    const cds = this.powerCooldownAt.get(client.sessionId);
    if (!cds) return;
    if (p.effects.has(String(type))) return;
    const readyAt = cds.get(type) ?? 0;
    if (now < readyAt) return;
    p.effects.set(String(type), now + def.durationMs);
    cds.set(type, now + def.durationMs + def.cooldownMs);
    if (type === PowerUp.Regeneration) this.regenAcc.set(client.sessionId, 0);
  }

  private applyBlock(x: number, y: number, z: number, b: number): void {
    this.world.set(x, y, z, b);
    if (this.diffs.length < MAX_DIFFS) this.diffs.push({ x, y, z, b });
    this.broadcast(Msg.BlockDiff, { x, y, z, b });
  }

  private feed(text: string): void {
    this.broadcast(Msg.Feed, { text });
  }
}
