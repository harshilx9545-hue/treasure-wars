import http from 'http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './rooms/GameRoom';

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define('bedwars', GameRoom);

const port = Number(process.env.PORT ?? 2567);
server.listen(port, () => console.log(`[bedwars] server listening on :${port}`));
