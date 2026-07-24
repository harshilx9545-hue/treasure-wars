import { Client, Room } from "colyseus.js";

const ROOM = "bedwars";

export interface RoomInfo {
  roomId: string;
  clients: number;
  maxClients: number;
  name: string;
  phase: string;
}

type EndpointSource = "local" | "query" | "vite" | "same-origin";

interface EndpointResolution {
  url: string;
  source: EndpointSource;
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;

  const private172 = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(host);
  return private172 !== null && Number(private172[1]) >= 16 && Number(private172[1]) <= 31;
}

/**
 * Resolve the Colyseus server endpoint.
 *
 * A client opened from a local host must never use a URL baked into a
 * production build. This also makes a locally served production build connect
 * to the local Colyseus process, rather than to the deployed service.
 */
function resolveEndpoint(): EndpointResolution {
  const { hostname, protocol } = window.location;

  if (isLocalHost(hostname)) {
    const host = hostname === "::1" ? "[::1]" : hostname;
    return { url: `ws://${host}:2567`, source: "local" };
  }

  const override = new URLSearchParams(window.location.search).get("server")?.trim();
  if (override) return { url: override, source: "query" };

  const configured = import.meta.env.VITE_SERVER_URL?.trim();
  if (configured) return { url: configured, source: "vite" };

  const socketProtocol = protocol === "https:" ? "wss" : "ws";
  return { url: `${socketProtocol}://${hostname}:2567`, source: "same-origin" };
}

export function makeClient(): Client {
  const endpoint = resolveEndpoint();
  console.info("[bedwars] Connecting to Colyseus", {
    endpoint: endpoint.url,
    source: endpoint.source,
    room: ROOM,
  });
  return new Client(endpoint.url);
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
