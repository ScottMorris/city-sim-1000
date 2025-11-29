import { Application, Graphics } from 'pixi.js';
import { GameState, TileKind, getTile } from '../game/gameState';
import { Camera } from './camera';

export interface Position {
  x: number;
  y: number;
}

export interface Renderer {
  draw(state: GameState, hovered: Position | null, selected: Position | null): void;
  getCanvas(): HTMLCanvasElement;
}

export async function createRenderer(
  app: Application,
  wrapper: HTMLElement,
  camera: Camera,
  tileSize: number,
  palette: Record<TileKind, number>
): Promise<Renderer> {
  const mapLayer = new Graphics();
  const overlayLayer = new Graphics();

  await app.init({
    background: '#0b1424',
    resizeTo: wrapper,
    antialias: true
  });

  wrapper.appendChild(app.canvas);
  app.stage.addChild(mapLayer);
  app.stage.addChild(overlayLayer);

  const draw = (state: GameState, hovered: Position | null, selected: Position | null) => {
    mapLayer.clear();
    const size = tileSize * camera.scale;
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = getTile(state, x, y)!;
        const color = palette[tile.kind];
        mapLayer.beginFill(color, 0.95);
        mapLayer.drawRect(camera.x + x * size, camera.y + y * size, size - 1, size - 1);
        mapLayer.endFill();
      }
    }
    overlayLayer.clear();
    if (hovered) {
      overlayLayer.lineStyle(2, 0xffffff);
      overlayLayer.drawRect(camera.x + hovered.x * size, camera.y + hovered.y * size, size, size);
    }
    if (selected) {
      overlayLayer.lineStyle(2, 0x7bffb7);
      overlayLayer.drawRect(camera.x + selected.x * size, camera.y + selected.y * size, size, size);
    }
  };

  return {
    draw,
    getCanvas: () => app.canvas
  };
}
