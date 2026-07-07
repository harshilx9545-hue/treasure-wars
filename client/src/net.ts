import { Client, Room } from 'colyseus.js';

/**
 * Connect to the Colyseus server. Defaults to the current host on :2567;
 * override with ?server=wss://host for deployed environments.
 */
export async function connect(): Promise<Room> {
  const params = new URLSearchParams(location.search);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const endpoint = params.get('server') ?? `${proto}://${location.hostname}:2567`;
  const client = new Client(endpoint);
  return client.joinOrCreate('bedwars');
}
