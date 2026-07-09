import { Client, Room } from 'colyseus.js';

const ROOM = 'bedwars';

export interface RoomInfo {
  roomId: string;
  clients: number;
  maxClients: number;
  name: string;
  phase: string;
}

/** Resolve the Colyseus endpoint (override with ?server=wss://host). */
function endpoint(): string {
  const params = new URLSearchParams(location.search);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return params.get('server') ?? `${proto}://${location.hostname}:2567`;
}

export function makeClient(): Client {
  return new Client(endpoint());
}

/** Host: create a brand-new room and return it (roomId is the shareable code). */
export async function hostRoom(name: string): Promise<Room> {
  const client = makeClient();
  return client.create(ROOM, { name, roomName: `${name}'s Lobby` });
}

/** Join a specific room by its shareable code. */
export async function joinRoomById(id: string, name: string): Promise<Room> {
  const client = makeClient();
  return client.joinById(id, { name });
}

/** Quick-play: join any open lobby, or create one if none exist. */
export async function quickJoin(name: string): Promise<Room> {
  const client = makeClient();
  return client.joinOrCreate(ROOM, { name, roomName: `${name}'s Lobby` });
}

/** Browse open lobbies via Colyseus matchmaking. */
export async function listRooms(): Promise<RoomInfo[]> {
  const client = makeClient();
  const rooms = await client.getAvailableRooms(ROOM);
  return rooms.map((r) => ({
    roomId: r.roomId,
    clients: r.clients,
    maxClients: r.maxClients,
    name: (r.metadata as any)?.name ?? 'Treasure Wars Lobby',
    phase: (r.metadata as any)?.phase ?? 'lobby',
  }));
}

/** Legacy direct connect (kept for offline fallback callers). */
export async function connect(): Promise<Room> {
  const client = makeClient();
  return client.joinOrCreate(ROOM);
}
