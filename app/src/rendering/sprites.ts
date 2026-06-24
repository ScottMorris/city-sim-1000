import { TileKind } from '../game/gameState';

export const TILE_SIZE = 28;

export const palette: Record<TileKind, number> = {
  [TileKind.Land]: 0x345c3d,
  [TileKind.Water]: 0x234c7f,
  [TileKind.Tree]: 0x3c7a4b,
  [TileKind.Road]: 0x7f8894,
  [TileKind.Rail]: 0x8c6b3e,
  [TileKind.Residential]: 0xb3e675,
  [TileKind.Commercial]: 0x5bc0eb,
  [TileKind.Industrial]: 0xf08c42,
  [TileKind.PowerLine]: 0xe9d985,
  [TileKind.HydroPlant]: 0x50d1ff,
  [TileKind.WaterPump]: 0x4ac6b7,
  [TileKind.WaterTower]: 0x94d1ff,
  [TileKind.WaterPipe]: 0x73c3c9,
  [TileKind.ElementarySchool]: 0x6aa7ff,
  [TileKind.HighSchool]: 0x8f7bff,
  [TileKind.Park]: 0x2fa05a
};
