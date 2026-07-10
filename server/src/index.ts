import http from 'http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './rooms/GameRoom';

const app = express();
app.get('/', (_req, res) => res.json({ ok: true, service: 'bedwars' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define('bedwars', GameRoom);

const port = Number(process.env.PORT ?? 2567);
// Must use gameServer.listen() (not server.listen()) so Colyseus runs
// matchMaker.accept(): registers the process, enables seat reservation and
// getAvailableRooms(), and wires graceful shutdown. server.listen() skips it.
gameServer
  .listen(port)
  .then(() => console.log(`[bedwars] server listening on :${port}`))
  .catch((err) => {
    console.error('[bedwars] failed to start', err);
    process.exit(1);
  });
