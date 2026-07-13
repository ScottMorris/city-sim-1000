// Map renderer — PixiJS WebGL tile grid, overlays, and building indicators.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { Camera } from './camera';
import { GameState, MinimapMode, TileKind, getTile } from '../game/gameState';
import { BuildingStatus } from '../game/buildings/state';
import { getBuildingTemplate } from '../game/buildings/templates';
import { computeEducationReach } from '../game/education';
import type { TileTextures } from './tileAtlas';
import { createBuildingLookup, getTileColour, resolveTileSprite } from './tileRenderUtils';
import { GridDrawer } from './gridDrawer';
import { isPowerCarrier, isZone, isWaterCarrier } from '../game/adjacency';
import { Tool } from '../game/toolTypes';
import { ServiceId } from '../game/services';
import { getToolCost } from '../game/tools';

const GRID_LINE_WIDTH = 1;
const GRID_LINE_COLOUR = 0x123a63;
const FOOTPRINT_CONFLICT_COLOUR = 0xff7b7b;
const FOOTPRINT_WARNING_COLOUR = 0xffcc70;
const FOOTPRINT_PREVIEW_COLOUR = 0xffffff;
const WATER_OVERLAY_COLOUR = 0x4cc3ff;

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
  private indicatorLayer: Container;
  private labelLayer: Container;
  private container: Container;
  private tileLabels: Map<number, Text>;
  private labelPool: Text[] = [];
  private palette: Record<TileKind, number>;
  private tileTextures: TileTextures;
  private tileSprites: Map<number, Sprite>;
  private indicatorSprites: Map<number, Sprite>;
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
      schools: {},
      indicators: {}
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
    this.indicatorLayer = new Container();
    this.labelLayer = new Container();
    this.container = new Container();
    this.container.addChild(
      this.mapLayer,
      this.spriteLayer,
      this.gridLayer,
      this.overlayLayer,
      this.indicatorLayer,
      this.labelLayer
    );
    this.gridDrawer = new GridDrawer(this.gridLayer);
    this.tileSprites = new Map();
    this.indicatorSprites = new Map();
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
    const isUnderground = overlayMode === 'underground';
    const surfaceAlpha = isUnderground ? 0.25 : 1.0;

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
              .fill({ color: 0x000000, alpha: 0.8 * surfaceAlpha });
          }
          const sprite = this.getOrCreateSprite(idx, texture);
          sprite.position.set(
            this.camera.x + x * size + borderWidth,
            this.camera.y + y * size + borderWidth
          );
          sprite.width = spriteSize * widthTiles - borderWidth * 2;
          sprite.height = spriteSize * heightTiles - borderWidth * 2;
          sprite.visible = true;
          sprite.alpha = surfaceAlpha;
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
            .fill({ color, alpha: 0.95 * surfaceAlpha });
        }

        if (isUnderground && tile.underground) {
          // Draw underground layer (pipes)
          // Simple visual for now: grey pipe, blue if watered (handled by overlay)
          const px = this.camera.x + x * size + size * 0.25;
          const py = this.camera.y + y * size + size * 0.25;
          const pSize = size * 0.5;
          this.mapLayer.rect(px, py, pSize, pSize).fill({ color: 0x555555, alpha: 1.0 });

          // Connectors (simple logic for visualization)
          const pipeWidth = size * 0.2;
          const center = size / 2;
          const offset = pipeWidth / 2;
          const cx = this.camera.x + x * size + center;
          const cy = this.camera.y + y * size + center;

          const hasNeighbour = (dx: number, dy: number) => {
            const t = getTile(state, x + dx, y + dy);
            return t?.underground === TileKind.WaterPipe
              || t?.kind === TileKind.WaterPump
              || t?.kind === TileKind.WaterTower;
          };

          this.mapLayer.rect(cx - offset, cy - offset, pipeWidth, pipeWidth).fill({ color: 0x555555 });
          if (hasNeighbour(0, -1)) this.mapLayer.rect(cx - offset, this.camera.y + y * size, pipeWidth, center).fill({ color: 0x555555 });
          if (hasNeighbour(0, 1)) this.mapLayer.rect(cx - offset, cy, pipeWidth, center).fill({ color: 0x555555 });
          if (hasNeighbour(-1, 0)) this.mapLayer.rect(this.camera.x + x * size, cy - offset, center, pipeWidth).fill({ color: 0x555555 });
          if (hasNeighbour(1, 0)) this.mapLayer.rect(cx, cy - offset, center, pipeWidth).fill({ color: 0x555555 });
        }
      }
    }

    if (isUnderground) {
      this.drawWaterAttachmentPoints(state, size, buildingLookup);
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
    this.drawBuildingIndicators(state, size, buildingLookup);
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

  private drawWaterAttachmentPoints(
    state: GameState,
    size: number,
    buildingLookup: ReturnType<typeof createBuildingLookup>['buildingLookup']
  ) {
    const radius = size * 0.09;
    const inset = size * 0.16;
    for (const entry of buildingLookup.values()) {
      const template = entry.template;
      if (!template) continue;
      if (template.tileKind !== TileKind.WaterPump && template.tileKind !== TileKind.WaterTower) continue;
      const { width, height } = template.footprint;
      const { x: originX, y: originY } = entry.origin;

      for (let dx = 0; dx < width; dx++) {
        const x = originX + dx;
        const topY = originY;
        const bottomY = originY + height - 1;
        const px = this.camera.x + x * size;
        const pyTop = this.camera.y + topY * size;
        const pyBottom = this.camera.y + bottomY * size;
        const midX = px + size / 2;
        this.mapLayer.circle(midX, pyTop + inset, radius).fill({ color: WATER_OVERLAY_COLOUR, alpha: 0.9 });
        this.mapLayer.circle(midX, pyBottom + size - inset, radius).fill({ color: WATER_OVERLAY_COLOUR, alpha: 0.9 });
      }

      for (let dy = 0; dy < height; dy++) {
        const y = originY + dy;
        const leftX = originX;
        const rightX = originX + width - 1;
        const py = this.camera.y + y * size;
        const pxLeft = this.camera.x + leftX * size;
        const pxRight = this.camera.x + rightX * size;
        const midY = py + size / 2;
        this.mapLayer.circle(pxLeft + inset, midY, radius).fill({ color: WATER_OVERLAY_COLOUR, alpha: 0.9 });
        this.mapLayer.circle(pxRight + size - inset, midY, radius).fill({ color: WATER_OVERLAY_COLOUR, alpha: 0.9 });
      }
    }
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

      if (overlayMode === 'water' || overlayMode === 'underground') {
        if (tile.kind === TileKind.Water) return { color: 0x2f7be5, alpha: 0.32 };
        if (tile.underground === TileKind.WaterPipe) {
          return { color: tile.watered ? WATER_OVERLAY_COLOUR : 0x888888, alpha: 0.6 };
        }
        if (tile.kind === TileKind.WaterPipe) return { color: WATER_OVERLAY_COLOUR, alpha: 0.38 }; // Legacy check

        if (tile.kind === TileKind.WaterPump || tile.kind === TileKind.WaterTower) {
          return { color: tile.powered ? 0x7ad5ff : 0xffcc70, alpha: 0.4 };
        }
        // Show watered status on buildings/zones
        if (tile.watered) return { color: WATER_OVERLAY_COLOUR, alpha: 0.2 };
        return null;
      }

      if (overlayMode === 'alerts') {
        const zone = isZone(tile);
        const buildingStatus = tile.buildingId !== undefined ? buildingStatuses.get(tile.buildingId) : undefined;
        let severity = 0;
        if (tile.abandoned) severity = 2;
        if (buildingStatus === BuildingStatus.InactiveNoPower) severity = Math.max(severity, 2);
        if (buildingStatus === BuildingStatus.InactiveNoWater) severity = Math.max(severity, 2);
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

      if (overlayMode === 'wilderness') {
        if (tile.kind === TileKind.Water) return null;
        // 0–1 with 0.5 neutral (see tileBuffer decodeEco); tint strength
        // scales with distance from neutral — lush green up, urban grey down.
        const delta = (tile.wilderness ?? 0.5) - 0.5;
        if (delta > 0.02) return { color: 0x5ee6a0, alpha: Math.min(0.12 + delta * 0.7, 0.45) };
        if (delta < -0.02) return { color: 0x9aa0a8, alpha: Math.min(0.15 + -delta * 0.8, 0.5) };
        return null;
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

  private drawBuildingIndicators(
    state: GameState,
    size: number,
    buildingLookup: Map<number, { template: ReturnType<typeof getBuildingTemplate>; origin: { x: number; y: number } }>
  ) {
    // Determine which service types have infrastructure on the map so we only
    // show "no service" indicators when the player has actually built that service.
    let hasWaterInfra = false;
    for (const tile of state.tiles) {
      if (tile.kind === TileKind.WaterPump || tile.kind === TileKind.WaterTower) {
        hasWaterInfra = true;
        break;
      }
    }

    // Target display size = half a tile; sprite texture is 128×128.
    const iconPx = 128;
    const iconScale = (size * 0.5) / iconPx;
    const iconSize = size * 0.5;

    const seen = new Set<number>();
    for (const building of state.buildings) {
      const { status } = building.state;
      if (status === BuildingStatus.Active) continue;

      let texture: import('pixi.js').Texture | undefined;
      if (status === BuildingStatus.InactiveNoPower) {
        texture = this.tileTextures.indicators.noPower;
      } else if (status === BuildingStatus.InactiveNoWater && hasWaterInfra) {
        texture = this.tileTextures.indicators.noWater;
      }
      if (!texture) continue;

      const lookup = buildingLookup.get(building.id);
      const template = lookup?.template ?? getBuildingTemplate(building.templateId);
      const origin = lookup?.origin ?? building.origin;
      const width = template?.footprint.width ?? 1;
      const height = template?.footprint.height ?? 1;
      // Centre on the building footprint (same position the old dot used).
      const cx = this.camera.x + (origin.x + width / 2) * size - iconSize / 2;
      const cy = this.camera.y + (origin.y + height / 2) * size - iconSize / 2;

      let sprite = this.indicatorSprites.get(building.id);
      if (!sprite || sprite.texture !== texture) {
        if (!sprite) {
          sprite = new Sprite(texture);
          this.indicatorLayer.addChild(sprite);
          this.indicatorSprites.set(building.id, sprite);
        } else {
          sprite.texture = texture;
        }
      }
      sprite.x = cx;
      sprite.y = cy;
      sprite.scale.set(iconScale);
      sprite.visible = true;
      seen.add(building.id);
    }

    // Hide sprites for buildings that no longer need an indicator.
    // Destroy sprites for buildings that no longer exist (demolished).
    for (const [id, sprite] of this.indicatorSprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.indicatorSprites.delete(id);
      }
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
