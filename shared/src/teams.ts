import { BlockType } from './blocks';

export enum TeamId {
  Red = 0,
  Blue = 1,
  Green = 2,
  Yellow = 3,
}

export const TEAM_COUNT = 4;

export interface TeamDef {
  id: TeamId;
  name: string;
  color: number;
  wool: BlockType;
  bed: BlockType;
}

export const TEAMS: TeamDef[] = [
  { id: TeamId.Red, name: 'Red', color: 0xe53935, wool: BlockType.WoolRed, bed: BlockType.BedRed },
  { id: TeamId.Blue, name: 'Blue', color: 0x1e88e5, wool: BlockType.WoolBlue, bed: BlockType.BedBlue },
  { id: TeamId.Green, name: 'Green', color: 0x43a047, wool: BlockType.WoolGreen, bed: BlockType.BedGreen },
  { id: TeamId.Yellow, name: 'Yellow', color: 0xfdd835, wool: BlockType.WoolYellow, bed: BlockType.BedYellow },
];
