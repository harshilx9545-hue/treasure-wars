import { Room, Client } from 'colyseus';
import {
  VoxelWorld,
  generateMap,
  stepPlayer,
  Msg,
  BLOCKS,
  BlockType,
  TICK_MS,
  REACH,
  VOID_Y,
  TEAM_COUNT,
  PLAYER_HALF_W,
  PLAYER_HEIGHT,
  type SpawnPoint,
  type MoveInput,
  type PlayerPhysics,
  type PlaceMessage,
  type BreakMessage,
  type BlockDiff,
} from '@bedwars/shared';
import { BedwarsState, PlayerState } from '../schema/GameState';

const MAX_INPUTS_PER_TICK = 8; // ~60fps client inputs per 50ms tick, with headroom
const MAX_QUEUE = MAX_INPUTS_PER_TICK * 2;
const MAX_DIFFS = 20000; // cap the join-sync diff log

export class GameRoom extends Room<BedwarsState> {
  maxClients = 16;

  private world = new VoxelWorld();
  private spawns: SpawnPoint[] = [];
  private diffs: BlockDiff[] = [];
  private phys = new Map<string, PlayerPhysics>();
  private queues = new Map<string, MoveInput[]>();

  onCreate(): void {
    this.setState(new BedwarsState());
    this.spawns = generateMap(this.world);

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

    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  onJoin(client: Client): void {
    const team = this.pickTeam();
    const spawn = this.spawns[team];
    const p = new PlayerState();
    p.x = spawn.x;
    p.y = spawn.y;
    p.z = spawn.z;
    p.team = team;
    this.state.players.set(client.sessionId, p);
    this.phys.set(client.sessionId, { x: spawn.x, y: spawn.y, z: spawn.z, vy: 0, onGround: false });
    this.queues.set(client.sessionId, []);
    // Client generates the base map deterministically; only send the diff log.
    client.send(Msg.WorldInit, { diffs: this.diffs });
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    this.phys.delete(client.sessionId);
    this.queues.delete(client.sessionId);
  }

  private tick(): void {
    this.state.players.forEach((p, id) => {
      const phys = this.phys.get(id);
      const q = this.queues.get(id);
      if (!phys || !q) return;
      const inputs = q.splice(0, MAX_INPUTS_PER_TICK);
      for (const input of inputs) {
        stepPlayer(phys, input, this.world.isSolid); // dt clamped inside
        p.yaw = input.yaw;
        p.lastSeq = input.seq >>> 0;
      }
      if (phys.y < VOID_Y) this.respawn(id);
      p.x = phys.x;
      p.y = phys.y;
      p.z = phys.z;
      p.vy = phys.vy;
    });
  }

  private respawn(id: string): void {
    const p = this.state.players.get(id);
    const phys = this.phys.get(id);
    if (!p || !phys) return;
    const s = this.spawns[p.team];
    phys.x = s.x;
    phys.y = s.y;
    phys.z = s.z;
    phys.vy = 0;
    phys.onGround = false;
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
    // Small tolerance over client reach to absorb movement latency.
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

  private tryPlace(client: Client, m: PlaceMessage): void {
    const { x, y, z, block } = m ?? {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    const def = BLOCKS[block];
    if (!def?.placeable) return;
    if (!this.world.inBounds(x, y, z)) return;
    if (this.world.get(x, y, z) !== BlockType.Air) return;
    if (!this.inReach(client.sessionId, x, y, z)) return;
    if (this.intersectsAnyPlayer(x, y, z)) return;
    this.applyBlock(x, y, z, block);
  }

  private tryBreak(client: Client, m: BreakMessage): void {
    const { x, y, z } = m ?? {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    const b = this.world.get(x, y, z);
    if (b === BlockType.Air || !BLOCKS[b]?.breakable) return;
    if (!this.inReach(client.sessionId, x, y, z)) return;
    this.applyBlock(x, y, z, BlockType.Air);
  }

  private applyBlock(x: number, y: number, z: number, b: number): void {
    this.world.set(x, y, z, b);
    if (this.diffs.length < MAX_DIFFS) this.diffs.push({ x, y, z, b });
    this.broadcast(Msg.BlockDiff, { x, y, z, b });
  }
}
