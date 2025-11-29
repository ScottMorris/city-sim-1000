import { Application, Container, Graphics } from 'pixi.js';
import { Camera } from './camera';
import { GameState, TileKind, getTile } from '../game/gameState';
import { getBuildingTemplate } from '../game/buildings';

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
        const color = this.getTileColor(tile);
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
    this.drawBuildingMarkers(state, size);
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

  private drawBuildingMarkers(state: GameState, size: number) {
    const radius = Math.max(2, size * 0.12);
    this.overlayLayer.beginFill(0xffffff, 0.8);
    for (const building of state.buildings) {
      const template = getBuildingTemplate(building.templateId);
      const width = template?.footprint.width ?? 1;
      const height = template?.footprint.height ?? 1;
      const cx = this.camera.x + (building.origin.x + width / 2) * size;
      const cy = this.camera.y + (building.origin.y + height / 2) * size;
      this.overlayLayer.drawCircle(cx, cy, radius);
    }
    this.overlayLayer.endFill();
  }

  private getTileColor(tile: ReturnType<typeof getTile>) {
    if (!tile) return 0x000000;
    const base = this.palette[tile.kind];
    const isPowerTile = tile.kind === TileKind.PowerLine || !!tile.powerPlantType;
    if (!isPowerTile) return base;
    const factor = tile.powered ? 1.35 : 0.7;
    return scaleColor(base, factor);
  }
}

function scaleColor(color: number, factor: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 0xff) * factor));
  const g = Math.max(0, Math.min(255, ((color >> 8) & 0xff) * factor));
  const b = Math.max(0, Math.min(255, (color & 0xff) * factor));
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}
