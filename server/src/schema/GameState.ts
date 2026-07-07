import { Schema, MapSchema, type } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') vy = 0; // needed for client-side replay after reconciliation
  @type('number') yaw = 0;
  @type('uint8') team = 0;
  @type('uint8') hp = 20;
  @type('boolean') alive = true;
  @type('uint32') lastSeq = 0; // last processed input, acks prediction
}

export class BedwarsState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type('uint8') bedsAlive = 0b1111; // bitmask by team index
  @type('int8') winner = -1; // team index, -1 while in progress
}
