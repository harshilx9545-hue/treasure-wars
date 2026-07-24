import {
  BlockType,
  PLAYER_HALF_W,
  PLAYER_HEIGHT,
  PLAYER_EYE,
  REACH,
  TICK_MS,
  WeaponId,
  WEAPONS,
  WORLD_X,
  WORLD_Y,
  WORLD_Z,
  type MoveInput,
  type PlayerPhysics,
  type SpawnPoint,
  type VoxelWorld,
} from '@bedwars/shared';

/** Difficulty is replicated as PlayerState.botDifficulty. */
export enum BotDifficulty { Easy = 0, Medium = 1, Hard = 2 }

export interface BotPlayerView {
  x: number; y: number; z: number;
  vx: number; vz: number;
  yaw: number;
  team: number;
  hp: number;
  alive: boolean;
  weapon: number;
  weapons: number;
  wool: number;
}

export interface BotRuntime {
  world: VoxelWorld;
  spawns: SpawnPoint[];
  treasures: Array<{ x: number; y: number; z: number }>;
  getPlayer(id: string): BotPlayerView | undefined;
  getPhysics(id: string): PlayerPhysics | undefined;
  players(): Array<[string, BotPlayerView]>;
  bedsAlive(): number;
  enqueue(id: string, input: MoveInput): void;
  equip(id: string, weapon: WeaponId): void;
  attack(id: string, target: string): void;
  breakBlock(id: string, x: number, y: number, z: number): void;
  placeBlock(id: string, x: number, y: number, z: number, block: number): boolean;
}

interface DifficultySpec {
  thinkMs: number;
  replanMs: number;
  sight: number;
  turnRate: number;
  maxNodes: number;
  attackJitter: number;
}

const DIFFICULTY: Record<BotDifficulty, DifficultySpec> = {
  [BotDifficulty.Easy]: { thinkMs: 560, replanMs: 1450, sight: 24, turnRate: 3.0, maxNodes: 750, attackJitter: 460 },
  [BotDifficulty.Medium]: { thinkMs: 330, replanMs: 950, sight: 38, turnRate: 5.2, maxNodes: 1300, attackJitter: 250 },
  [BotDifficulty.Hard]: { thinkMs: 180, replanMs: 620, sight: 56, turnRate: 8.0, maxNodes: 2200, attackJitter: 100 },
};

type GoalKind = 'combat' | 'defend' | 'treasure' | 'base' | 'wander';
interface Point { x: number; y: number; z: number; }
interface PathNode extends Point { gx: number; gz: number; }

interface Brain {
  id: string;
  difficulty: BotDifficulty;
  role: WeaponId;
  seq: number;
  yaw: number;
  nextThink: number;
  nextReplan: number;
  nextAttack: number;
  nextBreak: number;
  nextLook: number;
  forcedTarget: string | null;
  target: string | null;
  goal: GoalKind;
  goalPoint: Point | null;
  path: PathNode[];
  pathIndex: number;
  plannedX: number;
  plannedY: number;
  plannedZ: number;
  lastX: number;
  lastZ: number;
  stuckTicks: number;
  wander: Point | null;
}

const ROLE_ORDER = [
  WeaponId.Dagger,
  WeaponId.NormalSword,
  WeaponId.LargeSword,
  WeaponId.Cutlass,
  WeaponId.Axe,
  WeaponId.DoubleAxe,
];
const PATH_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const WAYPOINT_RADIUS = 0.3;
const NAVIGATION_RADIUS = PLAYER_HALF_W + 0.08;
const NAVIGATION_LOOK_AHEAD = 0.45;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sqr = (v: number) => v * v;
const dist2 = (a: Point, b: Point) => sqr(a.x - b.x) + sqr(a.z - b.z);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const aliveBed = (bits: number, team: number) => ((bits >> team) & 1) === 1;

/** Tiny binary heap: path plans are capped and never run inside a render loop. */
class MinHeap<T> {
  private data: Array<{ value: T; score: number }> = [];
  get length(): number { return this.data.length; }
  push(value: T, score: number): void {
    const item = { value, score }; this.data.push(item);
    let i = this.data.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.data[p]!.score <= score) break; this.data[i] = this.data[p]!; i = p; }
    this.data[i] = item;
  }
  pop(): T | undefined {
    const first = this.data[0]; const last = this.data.pop();
    if (!first) return undefined;
    if (last && this.data.length) {
      let i = 0;
      while (true) {
        let child = i * 2 + 1;
        if (child >= this.data.length) break;
        if (child + 1 < this.data.length && this.data[child + 1]!.score < this.data[child]!.score) child++;
        if (this.data[child]!.score >= last.score) break;
        this.data[i] = this.data[child]!; i = child;
      }
      this.data[i] = last;
    }
    return first.value;
  }
}

/**
 * Server-side bot brains. They emit ordinary MoveInput records and invoke the
 * room's already-authoritative actions, so clients receive bots through the
 * same PlayerState/remote-player path as human players.
 */
export class BotController {
  private brains = new Map<string, Brain>();
  private playerSnapshot: Array<[string, BotPlayerView]> = [];

  constructor(private readonly runtime: BotRuntime) {
    console.info('[bedwars] AI navigation status:', {
      collisionAware: true,
      wallMargin: NAVIGATION_RADIUS - PLAYER_HALF_W,
      diagonalCornerCutting: false,
      blockedRouteRepathing: true,
    });
  }

  add(id: string, difficulty: BotDifficulty, seed: number): void {
    const p = this.runtime.getPlayer(id);
    this.brains.set(id, {
      id, difficulty, role: ROLE_ORDER[seed % ROLE_ORDER.length]!, seq: 1,
      yaw: p?.yaw ?? 0, nextThink: 0, nextReplan: 0, nextAttack: 0, nextBreak: 0, nextLook: 0,
      forcedTarget: null, target: null, goal: 'wander', goalPoint: null,
      path: [], pathIndex: 0, plannedX: Number.NaN, plannedY: Number.NaN, plannedZ: Number.NaN,
      lastX: p?.x ?? 0, lastZ: p?.z ?? 0, stuckTicks: 0, wander: null,
    });
  }

  remove(id: string): void { this.brains.delete(id); }
  clear(): void { this.brains.clear(); }
  has(id: string): boolean { return this.brains.has(id); }

  /** Called by combat attribution: an attacked bot immediately defends itself. */
  onDamaged(id: string, attackerId: string): void {
    const brain = this.brains.get(id);
    if (brain) { brain.forcedTarget = attackerId; brain.nextThink = 0; }
  }

  tick(now: number): void {
    // One immutable-in-practice snapshot per server tick replaces a separate
    // state-array allocation for every bot decision.
    this.playerSnapshot = this.runtime.players();
    for (const brain of this.brains.values()) {
      const p = this.runtime.getPlayer(brain.id);
      const phys = this.runtime.getPhysics(brain.id);
      if (!p || !phys || !p.alive) continue;
      const spec = DIFFICULTY[brain.difficulty];

      if (now >= brain.nextThink) {
        brain.nextThink = now + spec.thinkMs;
        this.decide(brain, p, phys, now, spec, this.playerSnapshot);
      }
      this.move(brain, p, phys, now, spec);
    }
  }

  private decide(brain: Brain, p: BotPlayerView, phys: PlayerPhysics, now: number, spec: DifficultySpec, players: Array<[string, BotPlayerView]>): void {
    const ownTreasure = this.runtime.treasures[p.team] ?? this.runtime.spawns[p.team]!;
    const enemyNearBase = this.nearestEnemy(p, ownTreasure, 25, players);
    const forced = brain.forcedTarget ? this.runtime.getPlayer(brain.forcedTarget) : undefined;
    const nearby = this.nearestEnemy(p, p, spec.sight, players);
    const teammateInTrouble = this.teammateThreat(p, players, spec.sight);

    brain.target = null;
    brain.goalPoint = null;
    if (forced?.alive && forced.team !== p.team) {
      brain.target = brain.forcedTarget; brain.goal = 'combat'; brain.goalPoint = forced;
    } else if (enemyNearBase) {
      brain.target = enemyNearBase[0]; brain.goal = 'defend'; brain.goalPoint = enemyNearBase[1];
    } else if (teammateInTrouble) {
      brain.target = teammateInTrouble; brain.goal = 'defend'; brain.goalPoint = this.runtime.getPlayer(teammateInTrouble) ?? ownTreasure;
    } else if (nearby) {
      brain.target = nearby[0]; brain.goal = 'combat'; brain.goalPoint = nearby[1];
    } else if (p.hp <= (brain.difficulty === BotDifficulty.Easy ? 9 : 6) || (p.hp < 15 && Math.random() < 0.18)) {
      brain.goal = 'base'; brain.goalPoint = this.runtime.spawns[p.team]!;
    } else {
      const treasure = this.bestEnemyTreasure(p);
      if (treasure) {
        brain.goal = 'treasure'; brain.goalPoint = treasure;
      } else {
        brain.goal = 'wander';
        if (!brain.wander || dist2(p, brain.wander) < 16 || Math.random() < 0.22) brain.wander = this.randomWander(p.team);
        brain.goalPoint = brain.wander;
      }
    }
    if (brain.forcedTarget && brain.target !== brain.forcedTarget) brain.forcedTarget = null;

    // Weapon policy remains role-based; the axe is preferred for treasure
    // objectives, while every role uses the same authoritative melee path.
    const target = brain.target ? this.runtime.getPlayer(brain.target) : undefined;
    let desired = brain.role;
    if (brain.goal === 'treasure' && this.owns(p, WeaponId.Axe)) desired = WeaponId.Axe;
    if (!this.owns(p, desired)) desired = WeaponId.Dagger;
    if (p.weapon !== desired) this.runtime.equip(brain.id, desired);

    const goalMoved = !!brain.goalPoint && (
      sqr(brain.goalPoint.x - brain.plannedX) + sqr(brain.goalPoint.y - brain.plannedY) + sqr(brain.goalPoint.z - brain.plannedZ) > 2.25
    );
    if (brain.goalPoint && (now >= brain.nextReplan || brain.path.length === 0 || goalMoved)) {
      brain.nextReplan = now + spec.replanMs;
      brain.path = this.plan(p, brain.goalPoint, spec.maxNodes);
      brain.pathIndex = Math.min(1, Math.max(0, brain.path.length - 1));
      brain.plannedX = brain.goalPoint.x;
      brain.plannedY = brain.goalPoint.y;
      brain.plannedZ = brain.goalPoint.z;
    }

    if (target) this.tryCombat(brain, p, target, now, spec);
    if (brain.goal === 'treasure') this.tryTreasure(brain, p, now, spec);
    // If a gap is detected while chasing an objective, drop a wool bridge
    // segment. Existing planks/wool are naturally preferred by A* first.
    if ((brain.goal === 'treasure' || brain.goal === 'defend') && brain.path.length === 0) this.tryBridge(brain, p, phys);
  }

  private move(brain: Brain, p: BotPlayerView, phys: PlayerPhysics, now: number, spec: DifficultySpec): void {
    let waypoint: Point | null = null;
    while (brain.pathIndex < brain.path.length) {
      const n = brain.path[brain.pathIndex]!;
      // Do not skip a corner before the bot reaches its safe cell center.
      // Early waypoint skipping was allowing diagonal motion to scrape and
      // repeatedly push into fort walls.
      if (Math.hypot(n.x - p.x, n.z - p.z) < WAYPOINT_RADIUS) brain.pathIndex++;
      else { waypoint = n; break; }
    }

    let moveX = 0; let moveZ = 0; let jump = false;
    if (waypoint) {
      const dx = waypoint.x - p.x; const dz = waypoint.z - p.z;
      const len = Math.hypot(dx, dz);
      const needsJump = this.needsJump(p, phys, dx, dz);
      if (!this.canAdvance(p, dx, dz, needsJump)) {
        // Never fall back to steering directly at an unreachable objective.
        // Clear the route immediately so the next server tick runs A* again.
        brain.path = [];
        brain.pathIndex = 0;
        brain.nextReplan = 0;
        brain.nextThink = 0;
      } else {
        const desiredYaw = Math.atan2(-dx, -dz);
        const delta = wrap(desiredYaw - brain.yaw);
        brain.yaw += clamp(delta, -spec.turnRate * (TICK_MS / 1000), spec.turnRate * (TICK_MS / 1000));
        const sin = Math.sin(brain.yaw); const cos = Math.cos(brain.yaw);
        if (len > 0.25) {
          // Convert desired world direction into the controller's local axes.
          moveX = clamp((dx / len) * cos - (dz / len) * sin, -1, 1);
          moveZ = clamp(-(dx / len) * sin - (dz / len) * cos, -1, 1);
        }
        jump = needsJump;
      }
    } else if (now >= brain.nextLook) {
      brain.nextLook = now + 450 + Math.random() * 850;
      brain.yaw += (Math.random() - 0.5) * 1.4; // natural idle scanning
    }

    const moved = Math.hypot(p.x - brain.lastX, p.z - brain.lastZ);
    brain.stuckTicks = (Math.abs(moveX) + Math.abs(moveZ) > 0.25 && moved < 0.045) ? brain.stuckTicks + 1 : 0;
    if (brain.stuckTicks > 8) {
      // A dynamic blockage or an edge collision has stopped this route. Stop
      // issuing movement into the wall and replan on the next authoritative
      // tick instead of using a blind jump as the recovery mechanism.
      brain.path = [];
      brain.pathIndex = 0;
      brain.nextReplan = 0;
      brain.nextThink = 0;
      moveX = 0;
      moveZ = 0;
      jump = false;
      brain.stuckTicks = 0;
    }
    brain.lastX = p.x; brain.lastZ = p.z;

    this.runtime.enqueue(brain.id, {
      seq: brain.seq++, dt: TICK_MS / 1000, moveX, moveZ, jump,
      sprint: brain.goal !== 'wander' && brain.goal !== 'base', yaw: brain.yaw,
    });
  }

  private tryCombat(brain: Brain, p: BotPlayerView, target: BotPlayerView, now: number, spec: DifficultySpec): void {
    const weapon = WEAPONS[p.weapon as WeaponId] ?? WEAPONS[WeaponId.Dagger];
    const d = Math.hypot(target.x - p.x, target.y - p.y, target.z - p.z);
    if (d > weapon.range + PLAYER_HALF_W || now < brain.nextAttack) return;
    const base = weapon.cooldownMs + spec.attackJitter;
    brain.nextAttack = now + base * (0.75 + Math.random() * 0.55);
    this.runtime.attack(brain.id, brain.target!);
  }

  private tryTreasure(brain: Brain, p: BotPlayerView, now: number, spec: DifficultySpec): void {
    const goal = brain.goalPoint;
    if (!goal || Math.hypot(goal.x - p.x, goal.y - p.y, goal.z - p.z) > REACH + 0.8 || now < brain.nextBreak) return;
    brain.nextBreak = now + (brain.difficulty === BotDifficulty.Easy ? 1300 : brain.difficulty === BotDifficulty.Medium ? 850 : 560) + Math.random() * spec.attackJitter;
    this.runtime.breakBlock(brain.id, Math.floor(goal.x), Math.floor(goal.y), Math.floor(goal.z));
  }

  private tryBridge(brain: Brain, p: BotPlayerView, phys: PlayerPhysics): void {
    if (p.wool <= 0 || !brain.goalPoint) return;
    const dx = brain.goalPoint.x - p.x; const dz = brain.goalPoint.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const x = Math.floor(p.x + (dx / len) * 1.2);
    const z = Math.floor(p.z + (dz / len) * 1.2);
    const y = Math.floor(phys.y - 0.05);
    if (this.runtime.world.get(x, y, z) === BlockType.Air) this.runtime.placeBlock(brain.id, x, y, z, BlockType.WoolRed + p.team);
  }

  private bestEnemyTreasure(p: BotPlayerView): Point | null {
    let best: Point | null = null; let bestD = Infinity;
    const bits = this.runtime.bedsAlive();
    for (let t = 0; t < this.runtime.treasures.length; t++) {
      if (t === p.team || !aliveBed(bits, t)) continue;
      const v = this.runtime.treasures[t]!; const d = dist2(p, v);
      if (d < bestD) { best = v; bestD = d; }
    }
    return best;
  }

  private nearestEnemy(p: BotPlayerView, origin: Point, range: number, players: Array<[string, BotPlayerView]>): [string, BotPlayerView] | null {
    let out: [string, BotPlayerView] | null = null; let best = range * range;
    for (const [id, other] of players) {
      if (!other.alive || other.team === p.team) continue;
      const d = dist2(origin, other);
      if (d <= best) { out = [id, other]; best = d; }
    }
    return out;
  }

  private teammateThreat(p: BotPlayerView, players: Array<[string, BotPlayerView]>, range: number): string | null {
    for (const [allyId, ally] of players) {
      if (!ally.alive || ally.team !== p.team || ally.hp > 10 || dist2(p, ally) > range * range) continue;
      const foe = this.nearestEnemy(p, ally, 10, players);
      if (foe) return foe[0];
      void allyId;
    }
    return null;
  }

  private randomWander(team: number): Point {
    const s = this.runtime.spawns[team]!;
    const a = Math.random() * Math.PI * 2; const r = 4 + Math.random() * 14;
    return { x: s.x + Math.cos(a) * r, y: s.y, z: s.z + Math.sin(a) * r };
  }

  private owns(p: BotPlayerView, weapon: WeaponId): boolean { return ((p.weapons >> weapon) & 1) === 1; }

  private needsJump(p: BotPlayerView, phys: PlayerPhysics, dx: number, dz: number): boolean {
    if (!phys.onGround) return false;
    const len = Math.hypot(dx, dz); if (len < 0.1) return false;
    const x = Math.floor(p.x + (dx / len) * 0.7);
    const z = Math.floor(p.z + (dz / len) * 0.7);
    const y = Math.floor(p.y);
    return this.runtime.world.isSolid(x, y, z) && !this.runtime.world.isSolid(x, y + 1, z);
  }

  /** Test an inflated player AABB, preserving an 0.08-block wall margin. */
  private hasNavigationClearance(x: number, y: number, z: number): boolean {
    const world = this.runtime.world;
    const x0 = Math.floor(x - NAVIGATION_RADIUS);
    const x1 = Math.floor(x + NAVIGATION_RADIUS);
    const z0 = Math.floor(z - NAVIGATION_RADIUS);
    const z1 = Math.floor(z + NAVIGATION_RADIUS);
    const y0 = Math.floor(y);
    const y1 = Math.floor(y + PLAYER_HEIGHT - 1e-4);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        for (let gz = z0; gz <= z1; gz++) {
          if (world.isSolid(gx, gy, gz)) return false;
        }
      }
    }
    return true;
  }

  /** Probe the body volume ahead before emitting a movement input. */
  private canAdvance(p: BotPlayerView, dx: number, dz: number, jumping: boolean): boolean {
    const length = Math.hypot(dx, dz);
    if (length < 0.05) return true;
    const nx = dx / length;
    const nz = dz / length;
    for (const distance of [NAVIGATION_LOOK_AHEAD * 0.5, NAVIGATION_LOOK_AHEAD]) {
      const x = p.x + nx * distance;
      const z = p.z + nz * distance;
      if (this.hasNavigationClearance(x, p.y, z)) continue;
      // A single voxel ledge is valid only when the bot already committed to
      // a jump and its raised body volume has a clear landing path.
      if (jumping && this.hasNavigationClearance(x, p.y + 0.8, z)) continue;
      return false;
    }
    return true;
  }

  /** A* over walkable surfaces. A cell requires ground plus two clear head cells, so air/water gaps are rejected. */
  private plan(from: Point, to: Point, maxNodes: number): PathNode[] {
    const start = this.walkCell(Math.floor(from.x), Math.floor(from.z), from.y);
    const goal = this.nearestWalkCell(Math.floor(to.x), Math.floor(to.z), to.y);
    if (!start || !goal) return [];
    // Always use the collision-checked grid path. A straight-line shortcut can
    // graze a wall corner between sampled cells even when both endpoints are
    // valid, which is exactly the case that made bots push into geometry.
    const open = new MinHeap<PathNode>();
    const came = new Map<number, number>();
    const nodes = new Map<number, PathNode>();
    const g = new Map<number, number>();
    const sk = start.gz * WORLD_X + start.gx;
    const goalKey = goal.gz * WORLD_X + goal.gx;
    nodes.set(sk, start); g.set(sk, 0); open.push(start, Math.hypot(goal.gx - start.gx, goal.gz - start.gz));
    let visited = 0; let found = -1;
    while (open.length && visited++ < maxNodes) {
      const cur = open.pop()!; const ck = cur.gz * WORLD_X + cur.gx;
      if (ck === goalKey) { found = ck; break; }
      const cg = g.get(ck) ?? Infinity;
      for (const [dx, dz] of PATH_DIRS) {
        const next = this.walkCell(cur.gx + dx, cur.gz + dz, cur.y);
        if (!next || Math.abs(next.y - cur.y) > 1.05) continue;
        // No diagonal corner-cutting through a wall.
        if (dx && dz && (!this.walkCell(cur.gx + dx, cur.gz, cur.y) || !this.walkCell(cur.gx, cur.gz + dz, cur.y))) continue;
        const nk = next.gz * WORLD_X + next.gx; const ng = cg + (dx && dz ? 1.414 : 1) + Math.abs(next.y - cur.y) * 0.35;
        if (ng >= (g.get(nk) ?? Infinity)) continue;
        g.set(nk, ng); came.set(nk, ck); nodes.set(nk, next);
        open.push(next, ng + Math.hypot(goal.gx - next.gx, goal.gz - next.gz));
      }
    }
    if (found < 0) return [];
    const out: PathNode[] = [];
    for (let at = found; at >= 0;) { const n = nodes.get(at); if (!n) break; out.push(n); at = came.get(at) ?? -1; }
    return out.reverse();
  }

  private nearestWalkCell(x: number, z: number, y: number): PathNode | null {
    for (let r = 0; r <= 4; r++) for (let ox = -r; ox <= r; ox++) for (let oz = -r; oz <= r; oz++) {
      if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
      const c = this.walkCell(x + ox, z + oz, y); if (c) return c;
    }
    return null;
  }

  private walkCell(x: number, z: number, nearY: number): PathNode | null {
    if (x < 1 || z < 1 || x >= WORLD_X - 1 || z >= WORLD_Z - 1) return null;
    const w = this.runtime.world;
    const guess = clamp(Math.floor(nearY), 1, WORLD_Y - 3);
    // Bias toward the current level, then fall back through the map. This keeps
    // paths on fort floors instead of selecting a buried soil layer.
    for (let y = guess + 2; y >= 1; y--) {
      if (
        w.isSolid(x, y - 1, z)
        && !w.isSolid(x, y, z)
        && !w.isSolid(x, y + 1, z)
        && this.hasNavigationClearance(x + 0.5, y, z + 0.5)
      ) return { x: x + 0.5, y, z: z + 0.5, gx: x, gz: z };
    }
    return null;
  }
}
