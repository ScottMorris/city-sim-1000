import { Application, Container, Graphics } from 'pixi.js';
import { Camera } from './camera';
import { GameState, TileKind, getTile } from '../game/gameState';

export interface Position {
  x: number;
  y: number;
}

export class MapRenderer {
  readonly app: Application;
  private parent: HTMLElement;
  private mapLayer: Graphics;
  private overlayLayer: Graphics;
  private container: Container;
  private palette: Record<TileKind, number>;
  private camera: Camera;
  private tileSize: number;

  constructor(parent: HTMLElement, camera: Camera, tileSize: number, palette: Record<TileKind, number>) {
    this.app = new Application();
    this.parent = parent;
    this.camera = camera;
    this.tileSize = tileSize;
    this.palette = palette;
    this.mapLayer = new Graphics();
    this.overlayLayer = new Graphics();
    this.container = new Container();
    this.container.addChild(this.mapLayer, this.overlayLayer);
  }

  async init(resizeTo: HTMLElement) {
    await this.app.init({
      background: '#0b1424',
      resizeTo,
      antialias: true
    });
    this.parent.appendChild(this.app.canvas);
    this.app.stage.addChild(this.container);
  }

  render(state: GameState, hovered: Position | null, selected: Position | null) {
    const size = this.tileSize * this.camera.scale;
    this.mapLayer.clear();
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = getTile(state, x, y)!;
        const color = this.palette[tile.kind];
        this.mapLayer.beginFill(color, 0.95);
        this.mapLayer.drawRect(
          this.camera.x + x * size,
          this.camera.y + y * size,
          size - 1,
          size - 1
        );
        this.mapLayer.endFill();
      }
    }

    this.overlayLayer.clear();
    if (hovered) {
      this.overlayLayer.lineStyle(2, 0xffffff);
      this.overlayLayer.drawRect(
        this.camera.x + hovered.x * size,
        this.camera.y + hovered.y * size,
        size,
        size
      );
    }
    if (selected) {
      this.overlayLayer.lineStyle(2, 0x7bffb7);
      this.overlayLayer.drawRect(
        this.camera.x + selected.x * size,
        this.camera.y + selected.y * size,
        size,
        size
      );
    }
  }

  getCanvas() {
    return this.app.canvas;
  }
}
