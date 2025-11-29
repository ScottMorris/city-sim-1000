import { BuildingStatus, listPowerPlants } from './buildings';
import { GameState, TileKind } from './gameState';
import { POWER_PLANT_CONFIGS } from './constants';

function getIndex(state: GameState, x: number, y: number) {
  return y * state.width + x;
}

export function recomputePowerNetwork(state: GameState) {
  // reset powered flags
  for (const tile of state.tiles) {
    tile.powered = false;
  }

  const queue: number[] = [];

  state.tiles.forEach((tile, idx) => {
    if (tile.powerPlantType) {
      tile.powered = true;
      queue.push(idx);
    }
  });

  while (queue.length > 0) {
    const index = queue.shift()!;
    const x = index % state.width;
    const y = Math.floor(index / state.width);
    const neighbours: Array<[number, number]> = [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y]
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
      const nIndex = getIndex(state, nx, ny);
      const neighbour = state.tiles[nIndex];
      if (
        (neighbour.kind === TileKind.PowerLine || neighbour.powerPlantType) &&
        !neighbour.powered
      ) {
        neighbour.powered = true;
        queue.push(nIndex);
      }
    }
  }

  let produced = 0;
  const plants = listPowerPlants(state);
  for (const plant of plants) {
    const templateOutput = plant.template?.power?.outputMw;
    const fallbackOutput =
      plant.type && POWER_PLANT_CONFIGS[plant.type]
        ? POWER_PLANT_CONFIGS[plant.type].outputMw
        : 0;
    const output = templateOutput ?? fallbackOutput ?? 0;
    const isActive = plant.instance
      ? plant.instance.state.status !== BuildingStatus.Inactive
      : true;
    if (isActive) {
      produced += output;
    }
  }

  state.utilities.powerProduced = produced;
  state.utilities.powerUsed = 0;
  state.utilities.power = state.utilities.powerProduced - state.utilities.powerUsed;
}
