import { GameState, Tile, TileKind, getTile } from './gameState';

const ORTHOGONAL_DIRS: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0]
];

export function getOrthogonalNeighbourCoords(
  state: GameState,
  x: number,
  y: number
): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  for (const [dx, dy] of ORTHOGONAL_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
    coords.push([nx, ny]);
  }
  return coords;
}

export function hasRoadAccess(state: GameState, x: number, y: number): boolean {
  return getOrthogonalNeighbourCoords(state, x, y).some(([nx, ny]) => {
    const neighbour = getTile(state, nx, ny);
    return neighbour?.kind === TileKind.Road;
  });
}

export function isPowerCarrier(tile: Tile | undefined): boolean {
  if (!tile) return false;
  if (tile.powerPlantType) return true;
  if (tile.kind === TileKind.PowerLine) return true;
  if (
    tile.kind === TileKind.Residential ||
    tile.kind === TileKind.Commercial ||
    tile.kind === TileKind.Industrial
  ) {
    return true;
  }
  return false;
}
