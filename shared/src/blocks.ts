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
}

export const BLOCKS: Record<number, BlockDef> = {
  [BlockType.Grass]: { name: 'grass', color: 0x5fbf3f, breakable: true, placeable: false },
  [BlockType.Dirt]: { name: 'dirt', color: 0x8a5a32, breakable: true, placeable: false },
  [BlockType.Stone]: { name: 'stone', color: 0x9a9a9a, breakable: true, placeable: true },
  [BlockType.Plank]: { name: 'plank', color: 0xc08a4a, breakable: true, placeable: true },
  [BlockType.WoolRed]: { name: 'wool_red', color: 0xe53935, breakable: true, placeable: true },
  [BlockType.WoolBlue]: { name: 'wool_blue', color: 0x1e88e5, breakable: true, placeable: true },
  [BlockType.WoolGreen]: { name: 'wool_green', color: 0x43a047, breakable: true, placeable: true },
  [BlockType.WoolYellow]: { name: 'wool_yellow', color: 0xfdd835, breakable: true, placeable: true },
  [BlockType.Bedrock]: { name: 'bedrock', color: 0x3a3a3a, breakable: false, placeable: false },
  [BlockType.EndStone]: { name: 'end_stone', color: 0xdede9c, breakable: true, placeable: true },
  [BlockType.Wood]: { name: 'wood', color: 0x6b4a2b, breakable: true, placeable: false },
  [BlockType.Leaves]: { name: 'leaves', color: 0x3e8a2e, breakable: true, placeable: false },
  [BlockType.DiamondBlock]: { name: 'diamond_block', color: 0x4fd8d8, breakable: false, placeable: false },
  [BlockType.EmeraldBlock]: { name: 'emerald_block', color: 0x2ecc71, breakable: false, placeable: false },
  [BlockType.IronBlock]: { name: 'iron_block', color: 0xd8d8d8, breakable: false, placeable: false },
  [BlockType.GoldBlock]: { name: 'gold_block', color: 0xf5c542, breakable: false, placeable: false },
  // Beds are breakable, but the server rejects breaking your own team's bed.
  [BlockType.BedRed]: { name: 'bed_red', color: 0xff8a80, breakable: true, placeable: false },
  [BlockType.BedBlue]: { name: 'bed_blue', color: 0x82b1ff, breakable: true, placeable: false },
  [BlockType.BedGreen]: { name: 'bed_green', color: 0x9fdf9f, breakable: true, placeable: false },
  [BlockType.BedYellow]: { name: 'bed_yellow', color: 0xffe57f, breakable: true, placeable: false },
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
