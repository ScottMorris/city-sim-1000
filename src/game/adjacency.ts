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

export function isZone(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return (
    tile.kind === TileKind.Residential ||
    tile.kind === TileKind.Commercial ||
    tile.kind === TileKind.Industrial
  );
}

export function isFrontierZone(state: GameState, x: number, y: number): boolean {
  const tile = getTile(state, x, y);
  if (!isZone(tile)) return false;
  return getOrthogonalNeighbourCoords(state, x, y).some(([nx, ny]) => {
    const neighbour = getTile(state, nx, ny);
    return !isZone(neighbour);
  });
}

export function isPowerCarrier(tile: Tile | undefined): boolean {
  if (!tile) return false;
  if (tile.powerPlantType) return true;
  if (tile.kind === TileKind.PowerLine) return true;
  if (tile.kind === TileKind.Road || tile.kind === TileKind.Rail) return true;
  if (isZone(tile)) {
    return true;
  }
  return false;
}

/**
 * Returns true if a zone tile can reach a road by walking orthogonally through other zone tiles.
 */
export function zoneHasRoadPath(state: GameState, startX: number, startY: number): boolean {
  const start = getTile(state, startX, startY);
  if (!isZone(start)) return false;
  if (hasRoadAccess(state, startX, startY)) return true;
  const visited = new Set<number>();
  const queue: Array<[number, number]> = [[startX, startY]];
  const toIndex = (x: number, y: number) => y * state.width + x;
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [nx, ny] of getOrthogonalNeighbourCoords(state, x, y)) {
      const idx = toIndex(nx, ny);
      if (visited.has(idx)) continue;
      visited.add(idx);
      const neighbour = getTile(state, nx, ny);
      if (!isZone(neighbour)) continue;
      if (hasRoadAccess(state, nx, ny)) return true;
      queue.push([nx, ny]);
    }
  }
  return false;
}
