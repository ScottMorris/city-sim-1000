import { Graphics } from 'pixi.js';
import type { GameState } from '../game/gameState';

const GRID_LINE_WIDTH = 1;
const GRID_LINE_COLOUR = 0x123a63;

export class GridDrawer {
  private graphics: Graphics;

  constructor(graphics: Graphics) {
    this.graphics = graphics;
  }

  draw(state: GameState, size: number, multiTileCoverage: Int32Array, camera: { x: number; y: number }) {
    this.graphics.clear();
    const lineWidth = Math.min(2, Math.max(GRID_LINE_WIDTH, Math.round(size * 0.05)));
    this.graphics.setStrokeStyle({ width: lineWidth, color: GRID_LINE_COLOUR, alpha: 0.82 });
    const sameBuilding = (x1: number, y1: number, x2: number, y2: number) => {
      if (
        x1 < 0 ||
        x1 >= state.width ||
        x2 < 0 ||
        x2 >= state.width ||
        y1 < 0 ||
        y1 >= state.height ||
        y2 < 0 ||
        y2 >= state.height
      ) {
        return false;
      }
      const idx1 = y1 * state.width + x1;
      const idx2 = y2 * state.width + x2;
      const buildingId = multiTileCoverage[idx1];
      return buildingId !== 0 && buildingId === multiTileCoverage[idx2];
    };

    for (let x = 0; x <= state.width; x++) {
      let y = 0;
      while (y < state.height) {
        if (x > 0 && x < state.width && sameBuilding(x - 1, y, x, y)) {
          y++;
          continue;
        }
        const startY = y;
        y++;
        while (y < state.height && !(x > 0 && x < state.width && sameBuilding(x - 1, y, x, y))) {
          y++;
        }
        const px = camera.x + x * size;
        this.graphics.moveTo(px, camera.y + startY * size);
        this.graphics.lineTo(px, camera.y + y * size);
      }
    }

    for (let y = 0; y <= state.height; y++) {
      let x = 0;
      while (x < state.width) {
        if (y > 0 && y < state.height && sameBuilding(x, y - 1, x, y)) {
          x++;
          continue;
        }
        const startX = x;
        x++;
        while (x < state.width && !(y > 0 && y < state.height && sameBuilding(x, y - 1, x, y))) {
          x++;
        }
        const py = camera.y + y * size;
        this.graphics.moveTo(camera.x + startX * size, py);
        this.graphics.lineTo(camera.x + x * size, py);
      }
    }
    this.graphics.stroke();
  }
}
