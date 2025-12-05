import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { Camera } from './camera';
import { GameState, TileKind, getTile } from '../game/gameState';
import { BuildingStatus, getBuildingTemplate } from '../game/buildings';
import { POWER_PLANT_CONFIGS } from '../game/constants';
import type { TileTextures } from './tileAtlas';
import { isPowerCarrier } from '../game/adjacency';

const GRID_LINE_WIDTH = 1;
const GRID_LINE_COLOUR = 0x123a63;

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
    tileTextures: TileTextures = { tiles: {}, road: {}, powerPlant: {}, powerLine: {} }
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
    const spriteSize = size;
    this.mapLayer.clear();
    this.tilesWithSprites.clear();
    const buildingLookup = new Map<
      number,
      { template: ReturnType<typeof getBuildingTemplate>; origin: { x: number; y: number } }
    >();
    const multiTileCoverage = new Int32Array(state.width * state.height);
    for (const building of state.buildings) {
      const template = getBuildingTemplate(building.templateId);
      if (template) {
        buildingLookup.set(building.id, { template, origin: building.origin });
        const { width, height } = template.footprint;
        if (width > 1 || height > 1) {
          for (let dy = 0; dy < height; dy++) {
            for (let dx = 0; dx < width; dx++) {
              const tx = building.origin.x + dx;
              const ty = building.origin.y + dy;
              if (tx >= 0 && tx < state.width && ty >= 0 && ty < state.height) {
                const idx = ty * state.width + tx;
                multiTileCoverage[idx] = building.id;
              }
            }
          }
        }
      }
    }
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = getTile(state, x, y)!;
        const idx = y * state.width + x;
        const spriteInfo = this.getTileSprite(state, tile, x, y, buildingLookup);
        if (spriteInfo && 'texture' in spriteInfo) {
          const { texture, widthTiles, heightTiles, borderWidth = 0 } = spriteInfo;
          if (borderWidth > 0) {
            this.mapLayer.beginFill(0x000000, 0.8);
            this.mapLayer.drawRect(
              this.camera.x + x * size,
              this.camera.y + y * size,
              spriteSize * widthTiles,
              spriteSize * heightTiles
            );
            this.mapLayer.endFill();
          }
          const sprite = this.getOrCreateSprite(idx, texture);
          sprite.position.set(
            this.camera.x + x * size + borderWidth,
            this.camera.y + y * size + borderWidth
          );
          sprite.width = spriteSize * widthTiles - borderWidth * 2;
          sprite.height = spriteSize * heightTiles - borderWidth * 2;
          sprite.visible = true;
          for (let dy = 0; dy < heightTiles; dy++) {
            for (let dx = 0; dx < widthTiles; dx++) {
              const coveredIdx = (y + dy) * state.width + (x + dx);
              this.tilesWithSprites.add(coveredIdx);
            }
          }
        } else if (spriteInfo?.skip) {
          this.hideSprite(idx);
          this.tilesWithSprites.add(idx);
        } else {
          this.hideSprite(idx);
          const color = this.getTileColor(tile);
          this.mapLayer.beginFill(color, 0.95);
          this.mapLayer.drawRect(
            this.camera.x + x * size,
            this.camera.y + y * size,
            size,
            size
          );
          this.mapLayer.endFill();
        }
      }
    }

    this.drawGrid(state, size, multiTileCoverage);

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

  private drawGrid(state: GameState, size: number, multiTileCoverage: Int32Array) {
    this.gridLayer.clear();
    // Keep lines crisp at any zoom: scale a little, but clamp so they never get chunky.
    const lineWidth = Math.min(2, Math.max(GRID_LINE_WIDTH, Math.round(size * 0.05)));
    this.gridLayer.setStrokeStyle({ width: lineWidth, color: GRID_LINE_COLOUR, alpha: 0.82 });
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
      )
        return false;
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
        const px = this.camera.x + x * size;
        this.gridLayer.moveTo(px, this.camera.y + startY * size);
        this.gridLayer.lineTo(px, this.camera.y + y * size);
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
        const py = this.camera.y + y * size;
        this.gridLayer.moveTo(this.camera.x + startX * size, py);
        this.gridLayer.lineTo(this.camera.x + x * size, py);
      }
    }
    this.gridLayer.stroke();
  }

  private getTileSprite(
    state: GameState,
    tile: ReturnType<typeof getTile>,
    x: number,
    y: number,
    buildingLookup: Map<number, { template: ReturnType<typeof getBuildingTemplate>; origin: { x: number; y: number } }>
  ):
    | { texture: Texture; widthTiles: number; heightTiles: number; borderWidth?: number }
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
            return {
              texture: powerTexture,
              widthTiles: width,
              heightTiles: height,
              borderWidth: GRID_LINE_WIDTH
            };
          }
        } else if (x >= origin.x && x < origin.x + width && y >= origin.y && y < origin.y + height) {
          return { skip: true };
        }
      }
      const fallbackTexture = this.tileTextures.powerPlant[tile.powerPlantType];
      if (fallbackTexture)
        return { texture: fallbackTexture, widthTiles: 1, heightTiles: 1, borderWidth: GRID_LINE_WIDTH };
    }
    if (tile.kind === TileKind.Road) {
      const roadTexture = this.pickRoadTexture(state, x, y);
      if (roadTexture) return { texture: roadTexture, widthTiles: 1, heightTiles: 1 };
    }
    if (tile.kind === TileKind.PowerLine) {
      const powerTexture = this.pickPowerLineTexture(state, x, y);
      if (powerTexture) return { texture: powerTexture, widthTiles: 1, heightTiles: 1 };
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

  private pickPowerLineTexture(state: GameState, x: number, y: number): Texture | undefined {
    const connectsToPower = (tx: number, ty: number) => {
      const neighbour = getTile(state, tx, ty);
      return isPowerCarrier(neighbour);
    };

    const north = y > 0 && connectsToPower(x, y - 1);
    const south = y < state.height - 1 && connectsToPower(x, y + 1);
    const east = x < state.width - 1 && connectsToPower(x + 1, y);
    const west = x > 0 && connectsToPower(x - 1, y);

    const powerTextures = this.tileTextures.powerLine;
    const neighbours = [north, east, south, west].filter(Boolean).length;

    if (neighbours === 2 && north && south && !east && !west) {
      return powerTextures.north ?? powerTextures.south;
    }
    if (neighbours === 2 && east && west && !north && !south) {
      return powerTextures.east ?? powerTextures.west;
    }
    if (neighbours === 1) {
      if (north || south) return powerTextures.north ?? powerTextures.south;
      if (east || west) return powerTextures.east ?? powerTextures.west;
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
