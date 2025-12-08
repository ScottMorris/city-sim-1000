import { BuildingStatus } from '../buildings/state';
import { getBuildingTemplate } from '../buildings/templates';
import { GameState, TileKind } from '../gameState';
import { getOrthogonalNeighbourCoords, isWaterCarrier } from '../adjacency';

function getIndex(state: GameState, x: number, y: number) {
  return y * state.width + x;
}

export function recomputeWaterNetwork(state: GameState) {
  // Reset watered flags
  for (const tile of state.tiles) {
    tile.watered = false;
  }

  const queue: number[] = [];
  let produced = 0;

  // Identify sources
  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template || !template.waterOutput) continue;

    // Check if active (e.g. pumps need power)
    // Towers (no power needed) will be active if not damaged
    if (building.state.status !== BuildingStatus.Active) continue;

    produced += template.waterOutput;

    // Add all tiles of this building to the queue
    const { width, height } = template.footprint;
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const x = building.origin.x + dx;
        const y = building.origin.y + dy;
        const idx = getIndex(state, x, y);
        if (idx >= 0 && idx < state.tiles.length) {
          state.tiles[idx].watered = true;
          queue.push(idx);
        }
      }
    }
  }

  // BFS
  while (queue.length > 0) {
    const index = queue.shift()!;
    const x = index % state.width;
    const y = Math.floor(index / state.width);
    for (const [nx, ny] of getOrthogonalNeighbourCoords(state, x, y)) {
      const nIndex = getIndex(state, nx, ny);
      const neighbour = state.tiles[nIndex];
      if (!isWaterCarrier(neighbour) || neighbour.watered) continue;
      neighbour.watered = true;
      queue.push(nIndex);
    }
  }

  // Calculate usage
  let used = 0;
  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template || !template.waterUse) continue;
    if (building.state.status === BuildingStatus.Active) {
      used += template.waterUse;
    }
  }

  state.utilities.waterProduced = produced;
  state.utilities.waterUsed = used;
  state.utilities.water = produced - used;
}
