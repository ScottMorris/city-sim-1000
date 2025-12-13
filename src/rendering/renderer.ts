import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { Camera } from './camera';
import { GameState, MinimapMode, TileKind, getTile } from '../game/gameState';
import { BuildingStatus, getBuildingTemplate } from '../game/buildings';
import { computeEducationReach } from '../game/education';
import type { TileTextures } from './tileAtlas';
import { createBuildingLookup, getTileColour, resolveTileSprite } from './tileRenderUtils';
import { GridDrawer } from './gridDrawer';
import { isPowerCarrier, isZone } from '../game/adjacency';
import { Tool } from '../game/toolTypes';
import { ServiceId } from '../game/services';
import { getToolCost } from '../game/tools';

const GRID_LINE_WIDTH = 1;
const GRID_LINE_COLOUR = 0x123a63;
const FOOTPRINT_CONFLICT_COLOUR = 0xff7b7b;
const FOOTPRINT_WARNING_COLOUR = 0xffcc70;
const FOOTPRINT_PREVIEW_COLOUR = 0xffffff;

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
  private labelPool: Text[] = [];
  private palette: Record<TileKind, number>;
  private tileTextures: TileTextures;
  private tileSprites: Map<number, Sprite>;
  private tilesWithSprites: Set<number>;
  private camera: Camera;
  private tileSize: number;
  private gridDrawer: GridDrawer;

  constructor(
    parent: HTMLElement,
    camera: Camera,
    tileSize: number,
    palette: Record<TileKind, number>,
    tileTextures: TileTextures = {
      tiles: {},
      road: {},
      powerPlant: {},
      powerLine: {},
      residentialHouses: [],
      commercialBuildings: [],
      commercialGeminiBuildings: [],
      industrialBuildings: [],
      schools: {}
    }
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
    this.gridDrawer = new GridDrawer(this.gridLayer);
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

  render(
    state: GameState,
    hovered: Position | null,
    selected: Position | null,
    overlayMode: MinimapMode = 'base',
    pointerActive = false,
    activeTool: Tool = Tool.Inspect
  ) {
    const size = this.tileSize * this.camera.scale;
    const spriteSize = size;
    const hoverTemplate = getBuildingTemplate(activeTool);
    const hoverFootprint = hoverTemplate?.footprint ?? this.getToolFootprint(activeTool);
    this.mapLayer.clear();
    this.tilesWithSprites.clear();
    const { buildingLookup, multiTileCoverage } = createBuildingLookup(state);
    const buildingStatuses = new Map<number, BuildingStatus>();
    for (const building of state.buildings) {
      buildingStatuses.set(building.id, building.state.status);
    }
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = getTile(state, x, y)!;
        const idx = y * state.width + x;
        const spriteInfo = resolveTileSprite(state, tile, x, y, this.tileTextures, buildingLookup);
        if (spriteInfo && 'texture' in spriteInfo) {
          const { texture, widthTiles, heightTiles, borderWidth = 0 } = spriteInfo;
          if (borderWidth > 0) {
            this.mapLayer
              .rect(
                this.camera.x + x * size,
                this.camera.y + y * size,
                spriteSize * widthTiles,
                spriteSize * heightTiles
              )
              .fill({ color: 0x000000, alpha: 0.8 });
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
          const color = getTileColour(tile, this.palette);
          this.mapLayer
            .rect(
              this.camera.x + x * size,
              this.camera.y + y * size,
              size,
              size
            )
            .fill({ color, alpha: 0.95 });
        }
      }
    }

    this.gridDrawer.draw(state, size, multiTileCoverage, this.camera);

    this.overlayLayer.clear();
    this.drawOverlayTints(state, size, overlayMode, buildingStatuses);
    const educationPreview = this.pickEducationPreview(state, hovered, selected, activeTool, buildingLookup);
    if (educationPreview) {
      this.drawEducationPreview(
        state,
        educationPreview.origin,
        educationPreview.templateId,
        size,
        educationPreview.existing
      );
    }
    this.drawBuildingMarkers(state, size, buildingLookup);
    this.drawTileLabels(state, size);
    if (hovered) {
      const shouldValidatePlacement = hoverFootprint.width > 1 || hoverFootprint.height > 1;
      const fitsFootprint = shouldValidatePlacement
        ? this.footprintFits(state, hovered, hoverFootprint)
        : true;
      const toolCost = getToolCost(activeTool);
      const lacksFunds = Boolean(hoverTemplate && toolCost > 0 && state.money < toolCost);
      const hoverOutline = !fitsFootprint
        ? FOOTPRINT_CONFLICT_COLOUR
        : lacksFunds || pointerActive
          ? FOOTPRINT_WARNING_COLOUR
          : FOOTPRINT_PREVIEW_COLOUR;
      this.overlayLayer
        .rect(
          this.camera.x + hovered.x * size,
          this.camera.y + hovered.y * size,
          size * hoverFootprint.width,
          size * hoverFootprint.height
        )
        .fill({ color: hoverOutline, alpha: 0.16 })
        .stroke({ width: 2, color: hoverOutline });
    }
    if (selected) {
      this.overlayLayer
        .rect(
          this.camera.x + selected.x * size,
          this.camera.y + selected.y * size,
          size,
          size
        )
        .stroke({ width: 2, color: 0x7bffb7 });
    }
  }

  private getToolFootprint(tool: Tool) {
    const template = getBuildingTemplate(tool);
    return template?.footprint ?? { width: 1, height: 1 };
  }

  private footprintFits(state: GameState, origin: Position, footprint: { width: number; height: number }) {
    if (origin.x + footprint.width > state.width || origin.y + footprint.height > state.height) {
      return false;
    }
    for (let dy = 0; dy < footprint.height; dy++) {
      for (let dx = 0; dx < footprint.width; dx++) {
        const tile = getTile(state, origin.x + dx, origin.y + dy);
        if (!tile || tile.buildingId !== undefined || tile.powerPlantType) return false;
      }
    }
    return true;
  }

  getCanvas() {
    return this.app.canvas;
  }

  private drawOverlayTints(
    state: GameState,
    size: number,
    overlayMode: MinimapMode,
    buildingStatuses: Map<number, BuildingStatus>
  ) {
    if (overlayMode === 'base') return;

    const pickTint = (tile: ReturnType<typeof getTile>) => {
      if (!tile) return null;

      if (overlayMode === 'power') {
        if (tile.powerPlantType) return { color: 0x81e8ff, alpha: 0.35 };
        if (tile.kind === TileKind.PowerLine || tile.powerOverlay) {
          return { color: tile.powered ? 0x7bf0ff : 0xff99c2, alpha: 0.35 };
        }
        const carrier = isPowerCarrier(tile);
        if (carrier && tile.powered) return { color: 0x7bffb7, alpha: 0.26 };
        if (carrier && !tile.powered) return { color: 0xff7b7b, alpha: 0.32 };
        return null;
      }

      if (overlayMode === 'water') {
        if (tile.kind === TileKind.Water) return { color: 0x2f7be5, alpha: 0.32 };
        if (tile.kind === TileKind.WaterPipe) return { color: 0x4cc3ff, alpha: 0.38 };
        if (tile.kind === TileKind.WaterPump || tile.kind === TileKind.WaterTower) {
          return { color: tile.powered ? 0x7ad5ff : 0xffcc70, alpha: 0.4 };
        }
        if (tile.powered) return { color: 0x5aa2ff, alpha: 0.12 };
        return null;
      }

      if (overlayMode === 'alerts') {
        const zone = isZone(tile);
        const buildingStatus = tile.buildingId !== undefined ? buildingStatuses.get(tile.buildingId) : undefined;
        let severity = 0;
        if (tile.abandoned) severity = 2;
        if (buildingStatus === BuildingStatus.InactiveNoPower) severity = Math.max(severity, 2);
        if (buildingStatus === BuildingStatus.InactiveDamaged) severity = Math.max(severity, 1);
        if (zone && !tile.powered) severity = Math.max(severity, 2);
        if (zone && tile.happiness < 0.55) severity = Math.max(severity, 1);

        if (severity === 0) {
          if (zone) return { color: 0x7bffb7, alpha: 0.16 };
          return null;
        }
        if (severity === 1) return { color: 0xffcc70, alpha: 0.28 };
        return { color: 0xff7b7b, alpha: 0.33 };
      }

      if (overlayMode === 'education') {
        if (tile.kind === TileKind.ElementarySchool || tile.kind === TileKind.HighSchool) {
          return { color: 0x8f7bff, alpha: 0.4 };
        }
        if (isZone(tile)) {
          const served =
            tile.services.served[ServiceId.EducationElementary] ||
            tile.services.served[ServiceId.EducationHigh];
          return served
            ? { color: 0x7bffb7, alpha: 0.2 }
            : { color: 0xffcc70, alpha: 0.28 };
        }
        return null;
      }

      return null;
    };

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = getTile(state, x, y);
        const tint = pickTint(tile);
        if (!tint) continue;
        this.overlayLayer
          .rect(
            this.camera.x + x * size,
            this.camera.y + y * size,
            size,
            size
          )
          .fill({ color: tint.color, alpha: tint.alpha });
      }
    }
  }

  private pickEducationPreview(
    state: GameState,
    hovered: Position | null,
    selected: Position | null,
    activeTool: Tool,
    buildingLookup: Map<number, { template: ReturnType<typeof getBuildingTemplate>; origin: { x: number; y: number } }>
  ):
    | {
        origin: Position;
        templateId: string;
        existing: boolean;
      }
    | null {
    if (activeTool === Tool.ElementarySchool || activeTool === Tool.HighSchool) {
      if (hovered) return { origin: hovered, templateId: activeTool, existing: false };
    }
    if (!selected) return null;
    const tile = getTile(state, selected.x, selected.y);
    if (!tile || tile.buildingId === undefined) return null;
    const lookup = buildingLookup.get(tile.buildingId);
    const template = lookup?.template ?? getBuildingTemplate(tile.kind);
    if (!template?.service) return null;
    if (
      template.service.id !== ServiceId.EducationElementary &&
      template.service.id !== ServiceId.EducationHigh
    )
      return null;
    const origin = lookup?.origin ?? selected;
    return { origin, templateId: template.id, existing: true };
  }

  private drawEducationPreview(
    state: GameState,
    origin: Position,
    templateId: string,
    size: number,
    skipFitCheck = false
  ) {
    const footprint = this.getToolFootprint(templateId as Tool);
    if (!skipFitCheck && !this.footprintFits(state, origin, footprint)) return;
    const reach = computeEducationReach(state, origin, templateId);
    if (!reach.size) return;
    const color =
      templateId === TileKind.HighSchool || templateId === Tool.HighSchool
        ? 0x8f7bff
        : 0x6aa7ff;

    for (const idx of reach) {
      const x = idx % state.width;
      const y = Math.floor(idx / state.width);
      this.overlayLayer
        .rect(
          this.camera.x + x * size,
          this.camera.y + y * size,
          size,
          size
        )
        .fill({ color, alpha: 0.2 });
    }

    this.overlayLayer
      .rect(
        this.camera.x + origin.x * size,
        this.camera.y + origin.y * size,
        size * footprint.width,
        size * footprint.height
      )
      .stroke({ width: 2, color, alpha: 0.9 });
  }

  private drawBuildingMarkers(
    state: GameState,
    size: number,
    buildingLookup: Map<number, { template: ReturnType<typeof getBuildingTemplate>; origin: { x: number; y: number } }>
  ) {
    const radius = Math.max(2, size * 0.12);
    for (const building of state.buildings) {
      const lookup = buildingLookup.get(building.id);
      const template = lookup?.template ?? getBuildingTemplate(building.templateId);
      const origin = lookup?.origin ?? building.origin;
      const width = template?.footprint.width ?? 1;
      const height = template?.footprint.height ?? 1;
      let hasSpriteCoverage = false;
      for (let dy = 0; dy < height && !hasSpriteCoverage; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const tx = origin.x + dx;
          const ty = origin.y + dy;
          if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
          const idx = ty * state.width + tx;
          if (this.tilesWithSprites.has(idx)) {
            hasSpriteCoverage = true;
            break;
          }
        }
      }
      const powered = building.state.status === BuildingStatus.Active;
      if (powered && hasSpriteCoverage) continue;
      const cx = this.camera.x + (origin.x + width / 2) * size;
      const cy = this.camera.y + (origin.y + height / 2) * size;
      const color = powered ? 0x7bffb7 : 0xff7b7b;
      this.overlayLayer.circle(cx, cy, radius).fill({ color, alpha: 0.9 });
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
          text = this.labelPool.pop() ?? new Text();
          text.text = label;
          text.style = { fontSize, fill: 0xffffff, fontFamily: 'monospace' };
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
        this.labelPool.push(text);
        this.tileLabels.delete(idx);
      }
    }
  }
}
