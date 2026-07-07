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
};
