import { Camera } from '../rendering/camera';
import {
  GameState,
  MinimapMode,
  MinimapSettings,
  MinimapSize,
  TileKind,
  createDefaultMinimapSettings,
  getTile
} from '../game/gameState';
import { TILE_SIZE, palette as tilePalette } from '../rendering/sprites';

export interface MinimapOptions {
  root: HTMLElement;
  settings: MinimapSettings;
  onSettingsChange: (settings: MinimapSettings) => void;
  onJumpToTile: (tile: { x: number; y: number }) => void;
  getViewportSize: () => { width: number; height: number };
  palette?: Record<TileKind, number>;
}

export interface MinimapController {
  update: (state: GameState, camera: Camera) => void;
  toggleOpen: () => void;
  setSize: (size: MinimapSize) => void;
  setMode: (mode: MinimapMode) => void;
  markDirty: () => void;
  syncSettings: (settings: MinimapSettings) => void;
}

const SIZE_PRESETS: Record<MinimapSize, number> = {
  small: 160,
  medium: 220
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
  const palette = options.palette ?? tilePalette;
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

  const titleBlock = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'minimap-title';
  title.textContent = 'Minimap';
  const subtitle = document.createElement('div');
  subtitle.className = 'minimap-subtitle';
  subtitle.textContent = 'Base view';
  titleBlock.append(title, subtitle);

  const baseModeBtn = document.createElement('button');
  baseModeBtn.className = 'chip-button';
  baseModeBtn.textContent = 'Base';
  baseModeBtn.addEventListener('click', () => setMode('base'));
  const powerModeBtn = createDisabledModeButton('Power');
  const waterModeBtn = createDisabledModeButton('Water');
  const alertsModeBtn = createDisabledModeButton('Alerts');

  const sizeBtn = document.createElement('button');
  sizeBtn.className = 'chip-button';
  sizeBtn.addEventListener('click', () => {
    const next = settings.size === 'small' ? 'medium' : 'small';
    setSize(next);
  });

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'chip-button';
  toggleBtn.addEventListener('click', () => toggleOpen());

  header.append(titleBlock);

  const body = document.createElement('div');
  body.className = 'minimap-body';

  const actions = document.createElement('div');
  actions.className = 'minimap-actions';
  [baseModeBtn, powerModeBtn, waterModeBtn, alertsModeBtn, sizeBtn, toggleBtn].forEach((btn) => {
    if (btn === sizeBtn || btn === toggleBtn) {
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
  body.append(actions, canvasWrapper);

  const hint = document.createElement('div');
  hint.className = 'minimap-hint';
  hint.textContent = 'Overlays coming soon.';
  body.append(hint);

  container.append(header, body);
  options.root.append(container);

  const baseCtx = baseCanvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');
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
    return {
      ...createDefaultMinimapSettings(),
      ...(next ?? {})
    };
  }

  function setMode(mode: MinimapMode) {
    if (mode !== 'base') return;
    settings = { ...settings, mode };
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
    baseModeBtn.classList.toggle('active', settings.mode === 'base');
    sizeBtn.textContent = settings.size === 'small' ? 'Size: Small' : 'Size: Medium';
    toggleBtn.textContent = settings.open ? 'Hide' : 'Show';
    body.style.display = settings.open ? 'block' : 'none';
    container.style.width = `${SIZE_PRESETS[settings.size] + 16}px`;
  }

  function layoutCanvases() {
    const sizePx = SIZE_PRESETS[settings.size];
    const dpr = window.devicePixelRatio || 1;
    [baseCanvas, overlayCanvas].forEach((canvas) => {
      canvas.width = sizePx * dpr;
      canvas.height = sizePx * dpr;
      canvas.style.width = `${sizePx}px`;
      canvas.style.height = `${sizePx}px`;
    });
    baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvasWrapper.style.width = `${sizePx}px`;
    canvasWrapper.style.height = `${sizePx}px`;
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

  function pickColor(tile: ReturnType<typeof getTile>) {
    if (!tile) return '#000';
    if (tile.powerOverlay) return colorToCss(palette[TileKind.PowerLine]);
    if (tile.railUnderlay) return colorToCss(palette[TileKind.Rail]);
    if (tile.roadUnderlay) return colorToCss(palette[TileKind.Road]);
    return colorToCss(palette[tile.kind]);
  }

  function drawBase(state: GameState) {
    if (!layout) layoutCanvases();
    const frame = layout!;
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
        baseCtx.fillStyle = pickColor(tile);
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

  function update(state: GameState, camera: Camera) {
    latestState = state;
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
      drawBase(state);
    }
    drawViewport(camera, state);
  }

  syncUi();
  layoutCanvases();

  return {
    update,
    toggleOpen,
    setMode,
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

function createDisabledModeButton(label: string) {
  const btn = document.createElement('button');
  btn.className = 'chip-button';
  btn.textContent = label;
  btn.disabled = true;
  btn.title = 'Overlay coming soon';
  return btn;
}
