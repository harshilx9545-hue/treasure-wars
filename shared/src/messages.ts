import type { MoveInput } from './physics';

/** Wire message channels (short strings to keep frames small). */
export const Msg = {
  Input: 'i', // client -> server: MoveInput[] batched at 20Hz
  Place: 'p', // client -> server: PlaceMessage
  Break: 'b', // client -> server: BreakMessage
  BlockDiff: 'd', // server -> all: BlockDiff
  WorldInit: 'w', // server -> joining client: WorldInit (diff log only)
  Ping: 'pg', // client -> server: number (client timestamp)
  Pong: 'po', // server -> client: number (echoed timestamp)
  Feed: 'f', // server -> all: FeedMessage (kill feed / events)
} as const;

export type InputBatch = MoveInput[];

export interface PlaceMessage {
  x: number;
  y: number;
  z: number;
  block: number;
}

export interface BreakMessage {
  x: number;
  y: number;
  z: number;
}

export interface BlockDiff {
  x: number;
  y: number;
  z: number;
  b: number;
}

export interface WorldInit {
  diffs: BlockDiff[];
}

export interface FeedMessage {
  text: string;
}
