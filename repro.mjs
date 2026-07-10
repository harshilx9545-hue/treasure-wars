import { Client } from 'colyseus.js';

const URL = 'ws://localhost:2599';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function count(label) {
  const c = new Client(URL);
  const list = await c.getAvailableRooms('bedwars');
  console.log(`[${label}] rooms=${list.length}`, list.map((r) => ({ id: r.roomId, clients: r.clients })));
  return list.length;
}

// 1. Create lobby (host) and abruptly disconnect quickly (< seat-reservation window).
const host = new Client(URL);
const room = await host.create('bedwars', { name: 'Ghost' });
console.log('created room', room.roomId);
await sleep(400);
await count('after-join');

console.log('--- abruptly closing host socket (tab close) at ~1s after create ---');
const ws = room.connection?.transport?.ws ?? room.connection?.ws;
if (ws && ws.close) { ws.close(); console.log('closed ws directly'); }
else { console.log('fallback room.leave(false)'); await room.leave(false); }

let elapsed = 0, ghost = false;
for (const step of [1000, 1000, 2000]) {
  await sleep(step); elapsed += step;
  const n = await count(`+${elapsed}ms`);
  if (elapsed <= 2000 && n > 0) ghost = true;
  if (elapsed >= 2000) {
    console.log(n === 0 ? `PASS: lobby gone within ${elapsed}ms` : `FAIL: ghost lobby still present at ${elapsed}ms`);
  }
}
process.exit(0);
