import { Client, Room } from "colyseus.js";

const ROOM = "bedwars";

export interface RoomInfo {
  roomId: string;
  clients: number;
  maxClients: number;
  name: string;
  phase: string;
}

/**
 * Resolve the Colyseus server endpoint.
 *
 * Priority:
 * 1. ?server=wss://...
 * 2. VITE_SERVER_URL
 * 3. localhost (development)
 */
function endpoint(): string {
  const params = new URLSearchParams(window.location.search);

  const override = params.get("server");
  if (override) return override;

  const env = import.meta.env.VITE_SERVER_URL;
  if (env && env.length > 0) return env;

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:2567`;
}

export function makeClient(): Client {
  return new Client(endpoint());
}

export async function hostRoom(name: string): Promise<Room> {
  const client = makeClient();
  return client.create(ROOM, {
    name,
    roomName: `${name}'s Lobby`,
  });
}

export async function joinRoomById(id: string, name: string): Promise<Room> {
  const client = makeClient();
  return client.joinById(id, {
    name,
  });
}

export async function quickJoin(name: string): Promise<Room> {
  const client = makeClient();
  return client.joinOrCreate(ROOM, {
    name,
    roomName: `${name}'s Lobby`,
  });
}

export async function listRooms(): Promise<RoomInfo[]> {
  const client = makeClient();
  const rooms = await client.getAvailableRooms(ROOM);

  return rooms.map((r) => ({
    roomId: r.roomId,
    clients: r.clients,
    maxClients: r.maxClients,
    name: (r.metadata as any)?.name ?? "Treasure Wars Lobby",
    phase: (r.metadata as any)?.phase ?? "lobby",
  }));
}

export async function connect(): Promise<Room> {
  const client = makeClient();
  return client.joinOrCreate(ROOM);
}