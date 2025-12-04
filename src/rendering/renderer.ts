import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { Camera } from './camera';
import { GameState, TileKind, getTile } from '../game/gameState';
import { BuildingStatus, getBuildingTemplate } from '../game/buildings';
import { POWER_PLANT_CONFIGS } from '../game/constants';
import type { TileTextures } from './tileAtlas';

export interface Position {
  x: number;
  y: number;
}

export class MapRenderer {
  readonly app: Application;
  private parent: HTMLElement;
  private spriteLayer: Container;
  private mapLayer: Graphics;
  private gridLayer: Graphics;
  private overlayLayer: Graphics;
  private labelLayer: Container;
  private container: Container;
  private tileLabels: Map<number, Text>;
  private palette: Record<TileKind, number>;
  private tileTextures: TileTextures;
  private tileSprites: Map<number, Sprite>;
  private tilesWithSprites: Set<number>;
  private camera: Camera;
  private tileSize: number;

  constructor(
    parent: HTMLElement,
    camera: Camera,
    tileSize: number,
    palette: Record<TileKind, number>,
    tileTextures: TileTextures = { tiles: {}, road: {}, powerPlant: {} }
  ) {
    this.app = new Application();
    this.parent = parent;
    this.camera = camera;
    this.tileSize = tileSize;
    this.palette = palette;
    this.tileTextures = tileTextures;
    this.spriteLayer = new Container();
    this.mapLayer = new Graphics();
    this.gridLayer = new Graphics();
    this.overlayLayer = new Graphics();
    this.labelLayer = new Container();
    this.container = new Container();
    this.container.addChild(
      this.mapLayer,
      this.spriteLayer,
      this.gridLayer,
      this.overlayLayer,
      this.labelLayer
    );
    this.tileSprites = new Map();
    this.tilesWithSprites = new Set();
    this.tileLabels = new Map();
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
    const spriteSize = size - 1;
    this.mapLayer.clear();
    this.tilesWithSprites.clear();
    const buildingLookup = new Map<
      number,
      { template: ReturnType<typeof getBuildingTemplate>; origin: { x: number; y: number } }
    >();
    for (const building of state.buildings) {
      const template = getBuildingTemplate(building.templateId);
      if (template) {
        buildingLookup.set(building.id, { template, origin: building.origin });
      }
    }
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = getTile(state, x, y)!;
        const idx = y * state.width + x;
        const spriteInfo = this.getTileSprite(state, tile, x, y, buildingLookup);
        if (spriteInfo && 'texture' in spriteInfo) {
          const { texture, widthTiles, heightTiles } = spriteInfo;
          const sprite = this.getOrCreateSprite(idx, texture);
          sprite.position.set(this.camera.x + x * size, this.camera.y + y * size);
          sprite.width = spriteSize * widthTiles;
          sprite.height = spriteSize * heightTiles;
          sprite.visible = true;
          for (let dy = 0; dy < heightTiles; dy++) {
            for (let dx = 0; dx < widthTiles; dx++) {
              const coveredIdx = (y + dy) * state.width + (x + dx);
              this.tilesWithSprites.add(coveredIdx);
            }
          }
        } else {
          this.hideSprite(idx);
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
    }

    this.drawGrid(state, size);

    this.overlayLayer.clear();
    this.drawBuildingMarkers(state, size);
    this.drawTileLabels(state, size);
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
    for (const building of state.buildings) {
      const template = getBuildingTemplate(building.templateId);
      const width = template?.footprint.width ?? 1;
      const height = template?.footprint.height ?? 1;
      const cx = this.camera.x + (building.origin.x + width / 2) * size;
      const cy = this.camera.y + (building.origin.y + height / 2) * size;
      const powered = building.state.status === BuildingStatus.Active;
      const color = powered ? 0x7bffb7 : 0xff7b7b;
      this.overlayLayer.beginFill(color, 0.9);
      this.overlayLayer.drawCircle(cx, cy, radius);
      this.overlayLayer.endFill();
    }
  }

  private getOrCreateSprite(idx: number, texture: Texture): Sprite {
    const existing = this.tileSprites.get(idx);
    if (existing) {
      if (existing.texture !== texture) {
        existing.texture = texture;
      }
      return existing;
    }
    const sprite = new Sprite(texture);
    this.tileSprites.set(idx, sprite);
    this.spriteLayer.addChild(sprite);
    return sprite;
  }

  private hideSprite(idx: number) {
    const sprite = this.tileSprites.get(idx);
    if (sprite) {
      sprite.visible = false;
    }
  }

  private drawGrid(state: GameState, size: number) {
    this.gridLayer.clear();
    this.gridLayer.lineStyle(1, 0x000000, 0.8);
    const widthPx = state.width * size;
    const heightPx = state.height * size;
    for (let x = 0; x <= state.width; x++) {
      const px = this.camera.x + x * size;
      this.gridLayer.moveTo(px, this.camera.y);
      this.gridLayer.lineTo(px, this.camera.y + heightPx);
    }
    for (let y = 0; y <= state.height; y++) {
      const py = this.camera.y + y * size;
      this.gridLayer.moveTo(this.camera.x, py);
      this.gridLayer.lineTo(this.camera.x + widthPx, py);
    }
  }

  private getTileSprite(
    state: GameState,
    tile: ReturnType<typeof getTile>,
    x: number,
    y: number,
    buildingLookup: Map<number, { template: ReturnType<typeof getBuildingTemplate>; origin: { x: number; y: number } }>
  ):
    | { texture: Texture; widthTiles: number; heightTiles: number }
    | { skip: true }
    | undefined {
    if (!tile) return undefined;
    if (tile.kind === TileKind.HydroPlant && tile.powerPlantType) {
      const footprint =
        (tile.buildingId && buildingLookup.get(tile.buildingId)?.template?.footprint) ??
        POWER_PLANT_CONFIGS[tile.powerPlantType]?.footprint;
      const origin =
        (tile.buildingId && buildingLookup.get(tile.buildingId)?.origin) ??
        (footprint ? { x, y } : undefined);
      if (footprint && origin) {
        const { width, height } = footprint;
        if (x === origin.x && y === origin.y) {
          const powerTexture = this.tileTextures.powerPlant[tile.powerPlantType];
          if (powerTexture) {
            return { texture: powerTexture, widthTiles: width, heightTiles: height };
          }
        } else if (x >= origin.x && x < origin.x + width && y >= origin.y && y < origin.y + height) {
          return { skip: true };
        }
      }
      const fallbackTexture = this.tileTextures.powerPlant[tile.powerPlantType];
      if (fallbackTexture) return { texture: fallbackTexture, widthTiles: 1, heightTiles: 1 };
    }
    if (tile.kind === TileKind.Road) {
      const roadTexture = this.pickRoadTexture(state, x, y);
      if (roadTexture) return { texture: roadTexture, widthTiles: 1, heightTiles: 1 };
    }
    const baseTexture = this.tileTextures.tiles[tile.kind];
    if (baseTexture) return { texture: baseTexture, widthTiles: 1, heightTiles: 1 };
    return undefined;
  }

  private pickRoadTexture(state: GameState, x: number, y: number): Texture | undefined {
    const connectsToRoad = (tx: number, ty: number) => {
      const neighbour = getTile(state, tx, ty);
      return neighbour?.kind === TileKind.Road || neighbour?.roadUnderlay === true;
    };

    const north = y > 0 && connectsToRoad(x, y - 1);
    const south = y < state.height - 1 && connectsToRoad(x, y + 1);
    const east = x < state.width - 1 && connectsToRoad(x + 1, y);
    const west = x > 0 && connectsToRoad(x - 1, y);

    const roadTextures = this.tileTextures.road;

    const neighbours = [north, east, south, west].filter(Boolean).length;

    // Only render sprites for straights/endcaps; leave corners/crossings as grey to flag missing art.
    if (neighbours === 2 && north && south && !east && !west) {
      return roadTextures.north ?? roadTextures.south;
    }
    if (neighbours === 2 && east && west && !north && !south) {
      return roadTextures.east ?? roadTextures.west;
    }
    if (neighbours === 1) {
      if (north) return roadTextures.north;
      if (east) return roadTextures.east;
      if (south) return roadTextures.south;
      if (west) return roadTextures.west;
    }

    return undefined;
  }

  private drawTileLabels(state: GameState, size: number) {
    const fontSize = Math.max(8, Math.min(14, size * 0.35));
    for (const [, text] of this.tileLabels) {
      text.visible = false;
    }

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = getTile(state, x, y);
        if (!tile) continue;
        let label = '';
        const idx = y * state.width + x;
        if (this.tilesWithSprites.has(idx)) continue;
        if (tile.kind === TileKind.PowerLine || tile.powerOverlay) label += 'P';
        if (tile.kind === TileKind.Road || tile.roadUnderlay) label += 'R';
        if (tile.kind === TileKind.Rail || tile.railUnderlay) label += 'L';
        if (!label) continue;
        let text = this.tileLabels.get(idx);
        if (!text) {
          text = new Text({
            text: label,
            style: {
              fontSize,
              fill: 0xffffff,
              fontFamily: 'monospace'
            }
          });
          text.alpha = 0.8;
          text.anchor.set(0.5);
          this.tileLabels.set(idx, text);
          this.labelLayer.addChild(text);
        } else {
          if (text.text !== label) {
            text.text = label;
          }
          if (text.style.fontSize !== fontSize) {
            text.style.fontSize = fontSize;
          }
        }
        text.visible = true;
        text.position.set(
          this.camera.x + x * size + size / 2,
          this.camera.y + y * size + size / 2
        );
      }
    }

    for (const [idx, text] of this.tileLabels) {
      if (!text.visible) {
        this.labelLayer.removeChild(text);
        text.destroy();
        this.tileLabels.delete(idx);
      }
    }
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
