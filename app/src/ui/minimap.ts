// Minimap panel: dual-canvas base/overlay rendering, mode buttons, and camera viewport rect.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Camera } from '../rendering/camera';
import {
  GameState,
  MINIMAP_OVERLAYS,
  MinimapOverlay,
  MinimapSettings,
  MinimapSize,
  ViewStratum,
  createDefaultMinimapSettings,
  getTile
} from '../game/gameState';
import { BuildingStatus } from '../game/buildings/state';
import { isPowerCarrier, isZone } from '../game/adjacency';
import { Occupant, Terrain, hasOccupant, zoneOccupant } from '../game/protocol/occupants';
import { ECO_RANGE } from '../game/protocol/tileBuffer';
import { BuildingKind } from '../game/buildings/templates';
import { ServiceId } from '../game/services';
import { TILE_SIZE, OCCUPANT_COLOURS, TERRAIN_COLOURS } from '../rendering/sprites';
import { createBuildingLookup, type BuildingLookup } from '../rendering/tileRenderUtils';
import { computeAlertSeverity } from '../rendering/alertSeverity';

export interface MinimapOptions {
  root: HTMLElement;
  settings: MinimapSettings;
  onSettingsChange: (settings: MinimapSettings) => void;
  onJumpToTile: (tile: { x: number; y: number }) => void;
  getViewportSize: () => { width: number; height: number };
  /** Stratum lives outside `ClientState` (see `ViewStratum`), so toggling it is a plain callback rather than a settings patch. */
  onStratumToggle: () => void;
}

/**
 * A resolved `Structure` occupant's template colour for the minimap's base
 * mode — same rule `tileRenderUtils.ts`'s `structureColour` uses: only when
 * the tile carries the `Structure` bit, has a `buildingId`, and the lookup
 * resolves a template with a `colour`. `undefined` falls through to the next
 * rung (zone → trees), exactly as the deleted `legacyKind`'s structure
 * branch did on a stale/missing lookup.
 */
function structureColour(tile: NonNullable<ReturnType<typeof getTile>>, buildingLookup: BuildingLookup): number | undefined {
  if (!hasOccupant(tile.surface, Occupant.Structure) || tile.buildingId === undefined) return undefined;
  return buildingLookup.get(tile.buildingId)?.template?.colour;
}

/** Terrain/structure/zone/trees — the four rungs that outrank rail and road
 *  in the deleted `legacyKind`'s precedence, factored out because
 *  `minimapBaseColour` treats "one of these won" differently from "none of
 *  these won" (see its own doc comment). `undefined` means none matched. */
function groundOrDevelopmentColour(tile: NonNullable<ReturnType<typeof getTile>>, buildingLookup: BuildingLookup): number | undefined {
  if (tile.terrain === Terrain.Water) return TERRAIN_COLOURS[Terrain.Water];
  const structure = structureColour(tile, buildingLookup);
  if (structure !== undefined) return structure;
  const zone = zoneOccupant(tile.surface);
  if (zone !== undefined) return OCCUPANT_COLOURS[zone];
  if (hasOccupant(tile.overhead, Occupant.Trees)) return OCCUPANT_COLOURS[Occupant.Trees];
  return undefined;
}

/**
 * The minimap's base-mode pixel colour for one tile — pixel-identical to the
 * deleted `legacyKind`+`legacyFlags` composition it replaces, by case
 * analysis:
 *
 *   - `legacyFlags.powerOverlay` is unconditional whenever the `PowerLine`
 *     occupant is present, regardless of what else is on the tile, so a
 *     power line overhead always wins here too.
 *   - Otherwise, if `groundOrDevelopmentColour` finds a winner (water,
 *     structure, zone, or trees), that winner's `TileKind` could never have
 *     been `Rail` or `Road`, so `legacyFlags.railUnderlay`/`.roadUnderlay`
 *     reduce to a bare occupant check: rail present → rail colour, else road
 *     present → road colour, else the winner's own colour.
 *   - Otherwise (no winner, no power line): the tile's `legacyKind` could
 *     only have been `Rail`, `Road`, or `Land`. Rail always outranks road in
 *     `legacyKind` when both are present, so a rail+road tile (a plain level
 *     crossing) has `kind = Rail` and `roadUnderlay = true` — the crossing
 *     paints as ROAD, THE pinned pixel `e2e/visual.spec.ts`'s `d-minimap.png`
 *     asserts at zero threshold. Rail alone paints rail; road alone paints
 *     road; neither paints land.
 */
export function minimapBaseColour(tile: NonNullable<ReturnType<typeof getTile>>, buildingLookup: BuildingLookup): number {
  if (hasOccupant(tile.overhead, Occupant.PowerLine)) return OCCUPANT_COLOURS[Occupant.PowerLine]!;

  const rail = hasOccupant(tile.surface, Occupant.Rail);
  const road = hasOccupant(tile.surface, Occupant.Road);

  const winner = groundOrDevelopmentColour(tile, buildingLookup);
  if (winner !== undefined) {
    if (rail) return OCCUPANT_COLOURS[Occupant.Rail]!;
    if (road) return OCCUPANT_COLOURS[Occupant.Road]!;
    return winner;
  }

  if (rail && road) return OCCUPANT_COLOURS[Occupant.Road]!; // level crossing — the pinned pixel
  if (rail) return OCCUPANT_COLOURS[Occupant.Rail]!;
  if (road) return OCCUPANT_COLOURS[Occupant.Road]!;
  return TERRAIN_COLOURS[Terrain.Land];
}

export interface MinimapController {
  update: (state: GameState, camera: Camera, stratum: ViewStratum) => void;
  toggleOpen: () => void;
  setSize: (size: MinimapSize) => void;
  setOverlay: (overlay: MinimapOverlay) => void;
  markDirty: () => void;
  syncSettings: (settings: MinimapSettings) => void;
}

const SIZE_PRESETS: Record<MinimapSize, number> = {
  small: 200,
  medium: 220
};
const MIN_PANEL_WIDTH = 220;
const PANEL_PADDING = 10 * 2; // matches .minimap-panel padding
const OVERLAY_COPY: Record<MinimapOverlay, { subtitle: string; hint: string }> = {
  base: { subtitle: 'Base view', hint: 'Terrain, zones, transport, and power lines.' },
  power: { subtitle: 'Power overlay', hint: 'Green = powered, red = unpowered; teal = generation/lines.' },
  water: { subtitle: 'Water overlay', hint: 'Water tiles, pumps, towers, and pipes pop in blue for now.' },
  alerts: { subtitle: 'Alerts overlay', hint: 'Heatmap for abandoned, unpowered, or unhappy zones.' },
  education: {
    subtitle: 'Education overlay',
    hint: 'Schools in purple; served zones glow green, underserved zones amber.'
  },
  wilderness: {
    subtitle: 'Wilderness overlay',
    hint: 'Heatmap of the eco field: lush green for thriving nature, grey for urban pressure.'
  }
};

interface LayoutInfo {
  sizePx: number;
  step: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  dpr: number;
}

export function initMinimap(options: MinimapOptions): MinimapController {
  const colorCache = new Map<number, string>();
  const colorToCss = (color: number) => {
    const cached = colorCache.get(color);
    if (cached) return cached;
    const css = toCss(color);
    colorCache.set(color, css);
    return css;
  };
  let settings = mergeSettings(options.settings);
  let latestState: GameState | null = null;
  let layout: LayoutInfo | null = null;
  let lastTick = -1;
  let lastRedraw = 0;
  let lastMapWidth = 0;
  let lastMapHeight = 0;
  let dirty = true;
  let isDragging = false;

  const container = document.createElement('div');
  container.className = 'minimap-panel';

  const header = document.createElement('div');
  header.className = 'minimap-header';

  let stratum: ViewStratum = 'surface';

  const titleBlock = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'minimap-title';
  title.textContent = 'Minimap';
  const subtitle = document.createElement('div');
  subtitle.className = 'minimap-subtitle';
  subtitle.textContent = subtitleText();
  titleBlock.append(title, subtitle);

  const baseModeBtn = document.createElement('button');
  baseModeBtn.className = 'chip-button';
  baseModeBtn.textContent = 'Base';
  baseModeBtn.addEventListener('click', () => setOverlay('base'));
  const powerModeBtn = document.createElement('button');
  powerModeBtn.className = 'chip-button';
  powerModeBtn.textContent = 'Power';
  powerModeBtn.addEventListener('click', () => setOverlay('power'));
  const waterModeBtn = document.createElement('button');
  waterModeBtn.className = 'chip-button';
  waterModeBtn.textContent = 'Water';
  waterModeBtn.addEventListener('click', () => setOverlay('water'));
  const alertsModeBtn = document.createElement('button');
  alertsModeBtn.className = 'chip-button';
  alertsModeBtn.textContent = 'Alerts';
  alertsModeBtn.addEventListener('click', () => setOverlay('alerts'));
  const educationModeBtn = document.createElement('button');
  educationModeBtn.className = 'chip-button';
  educationModeBtn.textContent = 'Education';
  educationModeBtn.addEventListener('click', () => setOverlay('education'));
  const wildernessModeBtn = document.createElement('button');
  wildernessModeBtn.className = 'chip-button';
  wildernessModeBtn.textContent = 'Wilderness';
  wildernessModeBtn.addEventListener('click', () => setOverlay('wilderness'));

  const sizeBtn = document.createElement('button');
  sizeBtn.className = 'chip-button';
  sizeBtn.addEventListener('click', () => {
    const next = settings.size === 'small' ? 'medium' : 'small';
    setSize(next);
  });

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'chip-button';
  toggleBtn.addEventListener('click', () => toggleOpen());

  const headerControls = document.createElement('div');
  headerControls.className = 'minimap-header-controls';
  headerControls.append(toggleBtn);

  header.append(titleBlock, headerControls);

  const body = document.createElement('div');
  body.className = 'minimap-body';

  // The edit stratum is a different axis from the overlay chips below (see
  // `docs/features/view-layers.md`) — its own row keeps it from reading as a
  // seventh overlay choice.
  const stratumRow = document.createElement('div');
  stratumRow.className = 'minimap-stratum-row';
  const stratumBtn = document.createElement('button');
  stratumBtn.className = 'chip-button minimap-stratum-button';
  stratumBtn.addEventListener('click', () => options.onStratumToggle());
  stratumRow.append(stratumBtn);

  const actions = document.createElement('div');
  actions.className = 'minimap-actions';
  [baseModeBtn, powerModeBtn, waterModeBtn, alertsModeBtn, educationModeBtn, wildernessModeBtn, sizeBtn].forEach((btn) => {
    if (btn === sizeBtn) {
      btn.classList.add('minimap-span');
    }
    actions.append(btn);
  });

  const canvasWrapper = document.createElement('div');
  canvasWrapper.className = 'minimap-canvas-wrapper';
  const baseCanvas = document.createElement('canvas');
  baseCanvas.className = 'minimap-canvas';
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'minimap-overlay-canvas';
  canvasWrapper.append(baseCanvas, overlayCanvas);
  body.append(stratumRow, actions, canvasWrapper);

  const legendDetails = document.createElement('details');
  legendDetails.className = 'minimap-legend';

  const legendSummary = document.createElement('summary');
  legendSummary.className = 'minimap-legend-summary';
  legendSummary.textContent = 'Legend details';

  const hint = document.createElement('div');
  hint.className = 'minimap-hint';
  hint.textContent = OVERLAY_COPY[settings.overlay].hint;
  legendDetails.append(legendSummary, hint);
  body.append(legendDetails);

  container.append(header, body);
  options.root.append(container);

  const baseCtx = baseCanvas.getContext('2d') as CanvasRenderingContext2D;
  const overlayCtx = overlayCanvas.getContext('2d') as CanvasRenderingContext2D;
  if (!baseCtx || !overlayCtx) {
    throw new Error('Minimap canvas context missing');
  }

  baseCanvas.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    isDragging = true;
    jumpToEvent(e);
  });
  baseCanvas.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    e.stopPropagation();
    jumpToEvent(e);
  });
  window.addEventListener('pointerup', () => {
    isDragging = false;
  });

  function mergeSettings(next: Partial<MinimapSettings> | MinimapSettings): MinimapSettings {
    const merged = {
      ...createDefaultMinimapSettings(),
      ...(next ?? {})
    };
    const safeOverlay = MINIMAP_OVERLAYS.includes(merged.overlay) ? merged.overlay : 'base';
    return { ...merged, overlay: safeOverlay };
  }

  function subtitleText(): string {
    const base = OVERLAY_COPY[settings.overlay].subtitle;
    return stratum === 'underground' ? `${base} · Underground` : base;
  }

  function setOverlay(overlay: MinimapOverlay) {
    settings = { ...settings, overlay };
    dirty = true;
    syncUi();
    options.onSettingsChange(settings);
  }

  function setSize(size: MinimapSize) {
    settings = { ...settings, size };
    layoutCanvases();
    dirty = true;
    syncUi();
    options.onSettingsChange(settings);
  }

  function toggleOpen() {
    settings = { ...settings, open: !settings.open };
    syncUi();
    options.onSettingsChange(settings);
  }

  function syncSettings(next: MinimapSettings) {
    settings = mergeSettings(next);
    layoutCanvases();
    dirty = true;
    syncUi();
  }

  function syncUi() {
    container.classList.toggle('minimap-collapsed', !settings.open);
    baseModeBtn.classList.toggle('active', settings.overlay === 'base');
    powerModeBtn.classList.toggle('active', settings.overlay === 'power');
    waterModeBtn.classList.toggle('active', settings.overlay === 'water');
    alertsModeBtn.classList.toggle('active', settings.overlay === 'alerts');
    educationModeBtn.classList.toggle('active', settings.overlay === 'education');
    wildernessModeBtn.classList.toggle('active', settings.overlay === 'wilderness');
    stratumBtn.textContent = stratum === 'underground' ? 'View: Underground' : 'View: Surface';
    stratumBtn.classList.toggle('active', stratum === 'underground');
    sizeBtn.textContent = settings.size === 'small' ? 'Size: Small' : 'Size: Medium';
    toggleBtn.textContent = settings.open ? 'Hide' : 'Show';
    body.style.display = settings.open ? 'block' : 'none';
    subtitle.textContent = subtitleText();
    hint.textContent = OVERLAY_COPY[settings.overlay].hint;
    const widthPx = Math.max(SIZE_PRESETS[settings.size] + PANEL_PADDING + 12, MIN_PANEL_WIDTH);
    container.style.width = `${widthPx}px`;
  }

  function layoutCanvases() {
    const sizePx = SIZE_PRESETS[settings.size];
    const dpr = window.devicePixelRatio || 1;
    [baseCanvas, overlayCanvas].forEach((canvas) => {
      canvas.width = sizePx * dpr;
      canvas.height = sizePx * dpr;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    });
    baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvasWrapper.style.width = '100%';
    canvasWrapper.style.height = 'auto';
    layout = {
      sizePx,
      step: layout?.step ?? 1,
      scale: layout?.scale ?? 1,
      offsetX: layout?.offsetX ?? 0,
      offsetY: layout?.offsetY ?? 0,
      dpr
    };
  }

  function markDirty() {
    dirty = true;
  }

  function createBuildingStatusLookup(state: GameState) {
    const lookup = new Map<number, BuildingStatus>();
    for (const building of state.buildings) {
      lookup.set(building.id, building.state.status);
    }
    return lookup;
  }

  function pickModeColor(
    tile: ReturnType<typeof getTile>,
    buildingStatuses: Map<number, BuildingStatus>,
    buildingLookup: BuildingLookup
  ) {
    if (!tile) return '#000';
    const templateKind = tile.buildingId !== undefined ? buildingLookup.get(tile.buildingId)?.template?.kind : undefined;

    if (settings.overlay === 'power') {
      if (tile.powerPlantType) return '#81e8ff';
      if (hasOccupant(tile.overhead, Occupant.PowerLine)) {
        return tile.powered ? '#7bf0ff' : '#ff99c2';
      }
      const carrier = isPowerCarrier(tile);
      if (carrier && tile.powered) return 'rgba(123, 255, 183, 0.9)';
      if (carrier && !tile.powered) return 'rgba(255, 123, 123, 0.9)';
      return 'rgba(20, 32, 50, 0.9)';
    }

    if (settings.overlay === 'water') {
      if (tile.terrain === Terrain.Water) return '#1f68d6';
      if (templateKind === BuildingKind.WaterPump || templateKind === BuildingKind.WaterTower) {
        return tile.powered ? '#7ad5ff' : '#ffcc70';
      }
      return tile.powered ? 'rgba(76, 195, 255, 0.25)' : 'rgba(16, 26, 42, 0.92)';
    }

    if (settings.overlay === 'alerts') {
      const zone = isZone(tile);
      const buildingStatus = tile.buildingId !== undefined ? buildingStatuses.get(tile.buildingId) : undefined;
      const severity = computeAlertSeverity(tile, buildingStatus, zone);

      if (severity === 0) {
        if (zone) return 'rgba(123, 255, 183, 0.35)';
        return 'rgba(16, 26, 42, 0.92)';
      }
      if (severity === 1) return 'rgba(255, 204, 112, 0.95)';
      return 'rgba(255, 123, 123, 0.95)';
    }
    if (settings.overlay === 'education') {
      if (templateKind === BuildingKind.ElementarySchool || templateKind === BuildingKind.HighSchool) {
        return '#8f7bff';
      }
      if (isZone(tile)) {
        const served =
          tile.services.served[ServiceId.EducationElementary] ||
          tile.services.served[ServiceId.EducationHigh];
        return served ? 'rgba(123, 255, 183, 0.75)' : 'rgba(255, 204, 112, 0.95)';
      }
      return 'rgba(16, 26, 42, 0.9)';
    }

    if (settings.overlay === 'wilderness') {
      if (tile.terrain === Terrain.Water) return '#1f68d6';
      // `tile.wilderness` is the eco value in [-ECO_RANGE, +ECO_RANGE] (0 = neutral,
      // see tileBuffer decodeEco); rescale to the same ±0.5 display delta this
      // overlay used before the field carried eco units.
      const delta = (tile.wilderness ?? 0) / (2 * ECO_RANGE);
      if (delta > 0.02) return `rgba(94, 230, 160, ${Math.min(0.3 + delta * 1.4, 0.95).toFixed(2)})`;
      if (delta < -0.02) return `rgba(154, 160, 168, ${Math.min(0.3 + -delta * 1.4, 0.95).toFixed(2)})`;
      return 'rgba(16, 26, 42, 0.9)';
    }

    // `overlay === 'base'` beyond this point: the "base look" itself still
    // depends on the stratum axis — underground has its own base rendering
    // (pipes as objects), independent of any overlay tint.
    if (stratum === 'underground') {
      if (hasOccupant(tile.underground, Occupant.Pipe)) return '#4cc3ff';
      if (tile.terrain === Terrain.Water) return '#1f68d6';
      if (tile.watered) return 'rgba(76, 195, 255, 0.55)';
      // Fade others
      return 'rgba(16, 26, 42, 0.95)';
    }

    // Base/default mode — see `minimapBaseColour`'s doc comment for the
    // precedence this pins (order matters, and is pinned at zero threshold
    // by `e2e/visual.spec.ts`'s `d-minimap.png`).
    return colorToCss(minimapBaseColour(tile, buildingLookup));
  }

  function drawMap(state: GameState) {
    if (!layout) layoutCanvases();
    const frame = layout!;
    const buildingStatuses = createBuildingStatusLookup(state);
    const { buildingLookup } = createBuildingLookup(state);
    baseCtx.clearRect(0, 0, frame.sizePx, frame.sizePx);
    const targetPixels = Math.max(60, frame.sizePx - 12);
    const step = Math.max(1, Math.ceil(Math.max(state.width, state.height) / targetPixels));
    const drawWidth = Math.ceil(state.width / step);
    const drawHeight = Math.ceil(state.height / step);
    const scale = Math.min((frame.sizePx - 8) / drawWidth, (frame.sizePx - 8) / drawHeight);
    const offsetX = (frame.sizePx - drawWidth * scale) / 2;
    const offsetY = (frame.sizePx - drawHeight * scale) / 2;

    for (let sy = 0; sy < drawHeight; sy++) {
      for (let sx = 0; sx < drawWidth; sx++) {
        const tileX = Math.min(state.width - 1, sx * step);
        const tileY = Math.min(state.height - 1, sy * step);
        const tile = getTile(state, tileX, tileY);
        baseCtx.fillStyle = pickModeColor(tile, buildingStatuses, buildingLookup);
        baseCtx.fillRect(offsetX + sx * scale, offsetY + sy * scale, scale, scale);
      }
    }

    layout = { ...frame, step, scale, offsetX, offsetY };
    lastRedraw = performance.now();
    dirty = false;
  }

  function drawViewport(camera: Camera, state: GameState) {
    if (!layout || !settings.open) return;
    const frame = layout;
    overlayCtx.clearRect(0, 0, frame.sizePx, frame.sizePx);
    const viewport = options.getViewportSize();
    if (!viewport.width || !viewport.height) return;
    const tileSizeOnScreen = TILE_SIZE * camera.scale;
    const viewX = clamp(-camera.x / tileSizeOnScreen, 0, state.width);
    const viewY = clamp(-camera.y / tileSizeOnScreen, 0, state.height);
    const viewW = clamp(viewport.width / tileSizeOnScreen, 0, state.width);
    const viewH = clamp(viewport.height / tileSizeOnScreen, 0, state.height);
    const clampedW = clamp(viewW, 0, Math.max(0, state.width - viewX));
    const clampedH = clamp(viewH, 0, Math.max(0, state.height - viewY));

    const rectX = frame.offsetX + (viewX / frame.step) * frame.scale;
    const rectY = frame.offsetY + (viewY / frame.step) * frame.scale;
    const rectW = (clampedW / frame.step) * frame.scale;
    const rectH = (clampedH / frame.step) * frame.scale;

    overlayCtx.fillStyle = 'rgba(123, 255, 183, 0.08)';
    overlayCtx.fillRect(rectX, rectY, rectW, rectH);
    overlayCtx.strokeStyle = 'rgba(123, 255, 183, 0.9)';
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(rectX, rectY, rectW, rectH);
  }

  function jumpToEvent(e: PointerEvent) {
    if (!layout || !latestState) return;
    const rect = baseCanvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const mapWidthPx = (latestState.width / layout.step) * layout.scale;
    const mapHeightPx = (latestState.height / layout.step) * layout.scale;
    if (
      px < layout.offsetX ||
      py < layout.offsetY ||
      px > layout.offsetX + mapWidthPx ||
      py > layout.offsetY + mapHeightPx
    )
      return;
    const mapX = Math.floor((px - layout.offsetX) / layout.scale);
    const mapY = Math.floor((py - layout.offsetY) / layout.scale);
    const tileX = clamp(mapX * layout.step, 0, latestState.width - 1);
    const tileY = clamp(mapY * layout.step, 0, latestState.height - 1);
    options.onJumpToTile({ x: tileX, y: tileY });
  }

  function update(state: GameState, camera: Camera, nextStratum: ViewStratum) {
    latestState = state;
    if (nextStratum !== stratum) {
      stratum = nextStratum;
      dirty = true;
      syncUi();
    }
    const sizeChanged = state.width !== lastMapWidth || state.height !== lastMapHeight;
    if (sizeChanged) {
      lastMapWidth = state.width;
      lastMapHeight = state.height;
      dirty = true;
    }
    if (!layout) layoutCanvases();
    if (!settings.open) {
      overlayCtx.clearRect(0, 0, layout!.sizePx, layout!.sizePx);
      dirty = true;
      return;
    }
    const now = performance.now();
    const tickChanged = state.tick !== lastTick;
    if (tickChanged) {
      lastTick = state.tick;
    }
    const shouldRedraw = dirty || tickChanged;
    if (shouldRedraw && now - lastRedraw > 80) {
      drawMap(state);
    }
    drawViewport(camera, state);
  }

  syncUi();
  layoutCanvases();

  return {
    update,
    toggleOpen,
    setOverlay,
    setSize,
    markDirty,
    syncSettings
  };
}

function toCss(color: number) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}
