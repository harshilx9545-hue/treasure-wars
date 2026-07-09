export enum BlockType {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  Plank = 4,
  WoolRed = 5,
  WoolBlue = 6,
  WoolGreen = 7,
  WoolYellow = 8,
  Bedrock = 9,
  EndStone = 10,
  Wood = 11,
  Leaves = 12,
  DiamondBlock = 13,
  EmeraldBlock = 14,
  IronBlock = 15,
  GoldBlock = 16,
  BedRed = 17,
  BedBlue = 18,
  BedGreen = 19,
  BedYellow = 20,
}

export interface BlockDef {
  name: string;
  color: number;
  breakable: boolean;
  placeable: boolean;
  /** Base time in ms to mine by hand. Higher = slower. Beds are the longest. */
  hardness: number;
}

export const BLOCKS: Record<number, BlockDef> = {
  [BlockType.Grass]: { name: 'grass', color: 0x5fbf3f, breakable: true, placeable: false, hardness: 450 },
  [BlockType.Dirt]: { name: 'dirt', color: 0x8a5a32, breakable: true, placeable: false, hardness: 450 },
  [BlockType.Stone]: { name: 'stone', color: 0x9a9a9a, breakable: true, placeable: true, hardness: 1100 },
  [BlockType.Plank]: { name: 'plank', color: 0xc08a4a, breakable: true, placeable: true, hardness: 600 },
  [BlockType.WoolRed]: { name: 'wool_red', color: 0xe53935, breakable: true, placeable: true, hardness: 260 },
  [BlockType.WoolBlue]: { name: 'wool_blue', color: 0x1e88e5, breakable: true, placeable: true, hardness: 260 },
  [BlockType.WoolGreen]: { name: 'wool_green', color: 0x43a047, breakable: true, placeable: true, hardness: 260 },
  [BlockType.WoolYellow]: { name: 'wool_yellow', color: 0xfdd835, breakable: true, placeable: true, hardness: 260 },
  [BlockType.Bedrock]: { name: 'bedrock', color: 0x3a3a3a, breakable: false, placeable: false, hardness: Infinity },
  [BlockType.EndStone]: { name: 'end_stone', color: 0xdede9c, breakable: true, placeable: true, hardness: 2400 },
  [BlockType.Wood]: { name: 'wood', color: 0x6b4a2b, breakable: true, placeable: false, hardness: 700 },
  [BlockType.Leaves]: { name: 'leaves', color: 0x3e8a2e, breakable: true, placeable: false, hardness: 200 },
  [BlockType.DiamondBlock]: { name: 'diamond_block', color: 0x4fd8d8, breakable: false, placeable: false, hardness: Infinity },
  [BlockType.EmeraldBlock]: { name: 'emerald_block', color: 0x2ecc71, breakable: false, placeable: false, hardness: Infinity },
  [BlockType.IronBlock]: { name: 'iron_block', color: 0xd8d8d8, breakable: false, placeable: false, hardness: Infinity },
  [BlockType.GoldBlock]: { name: 'gold_block', color: 0xf5c542, breakable: false, placeable: false, hardness: Infinity },
  // Beds are breakable, but the server rejects breaking your own team's bed.
  // Long hardness so destroying a bed takes a deliberate mining effort.
  [BlockType.BedRed]: { name: 'bed_red', color: 0xff8a80, breakable: true, placeable: false, hardness: 3200 },
  [BlockType.BedBlue]: { name: 'bed_blue', color: 0x82b1ff, breakable: true, placeable: false, hardness: 3200 },
  [BlockType.BedGreen]: { name: 'bed_green', color: 0x9fdf9f, breakable: true, placeable: false, hardness: 3200 },
  [BlockType.BedYellow]: { name: 'bed_yellow', color: 0xffe57f, breakable: true, placeable: false, hardness: 3200 },
};

/** Team index for a bed block, or -1 if not a bed. */
export function bedTeam(b: number): number {
  switch (b) {
    case BlockType.BedRed: return 0;
    case BlockType.BedBlue: return 1;
    case BlockType.BedGreen: return 2;
    case BlockType.BedYellow: return 3;
    default: return -1;
  }
}

/** True if the block is any team bed. */
export function isBed(b: number): boolean {
  return bedTeam(b) >= 0;
}
