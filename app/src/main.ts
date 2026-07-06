// Entry point and composition root: HUD DOM, input wiring, game loop, and SimBridge selection.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import './style.css';
import { Application } from 'pixi.js';
import {
  createDefaultAccessibilitySettings,
  createDefaultAudioSettings,
  createDefaultCosmeticSettings,
  createDefaultInputSettings,
  createDefaultMinimapSettings,
  createDefaultNarrativeSettings,
  createDefaultUiSettings,
  createInitialState,
  GameState,
  getTile
} from './game/gameState';
import { Tool } from './game/toolTypes';
import { WasmSimBridge } from './game/wasmSimBridge';
import { TauriSimBridge } from './game/tauriSimBridge';
import { LocalSimBridge } from './game/localSimBridge';
import type { SimBridge } from './game/simBridge';
import { applyToolCmd } from './game/protocol/commands';
import type { FromSim } from './game/protocol/events';
import { loadFromBrowser } from './game/persistence';
import { initMcpBridge } from './game/mcpBridge';
import { createCamera, centerCamera, screenToTile, zoomAt } from './rendering/camera';
import { MapRenderer, Position } from './rendering/renderer';
import { palette, TILE_SIZE } from './rendering/sprites';
import { loadPaletteTexture, loadTileTextures } from './rendering/tileAtlas';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { createHud } from './ui/hud';
import { bindPersistenceControls, showManualModal, showToast } from './ui/dialogs';
import { initDebugOverlay } from './ui/debugOverlay';
import { initHotkeys, defaultHotkeys, type HotkeyAction, type HotkeyController } from './ui/hotkeys';
import { initDeviceMode } from './ui/deviceMode';
import { initToolbar, updateToolbar } from './ui/toolbar';
import { createNotificationCenter } from './ui/notifications';
import { initMinimap } from './ui/minimap';
import { initBudgetModal } from './ui/budgetModal';
import { initSettingsModal } from './ui/settingsModal';
import { initBylawsModal } from './ui/bylawsModal';
import { initNewsTicker } from './ui/newsTicker';
import type { RadioWidget } from './ui/radio';
import { initLoadingScreen } from './ui/loadingScreen';
import { DEFAULT_BYLAWS } from './game/bylaws';
import { buildCitySnapshot } from './game/narrative/snapshot';
import { NarrativeManager } from './game/narrative/narrativeManager';
import { getCalendarPosition } from './game/time';

const appRoot = document.querySelector<HTMLDivElement>('#app');

if (!appRoot) {
  throw new Error('App root missing');
}

appRoot.innerHTML = `
  <div class="topbar">
    <div class="logo">🏙️ <span>City Sim 1000</span></div>
    <div class="ribbon">
      <div class="ribbon-chip" title="City treasury, monthly net, and utility balances">
        <div class="ribbon-line">
          <span id="money" class="ribbon-strong">$0</span>
          <span id="budget-net" class="budget-net">+$0 / month</span>
        </div>
        <div class="ribbon-line">
          <span id="power">⚡ 0 MW</span>
          <span id="water">💧 0 m³</span>
        </div>
      </div>
      <div class="ribbon-chip ribbon-rci" title="Zone demand — Residential / Commercial / Industrial">
        <span class="rci-row"><span class="rci-label">R</span><span class="rci-track"><span id="res-bar" class="rci-fill" style="background:#7bffb7;width:30%"></span></span></span>
        <span class="rci-row"><span class="rci-label">C</span><span class="rci-track"><span id="com-bar" class="rci-fill" style="background:#5bc0eb;width:30%"></span></span></span>
        <span class="rci-row"><span class="rci-label">I</span><span class="rci-track"><span id="ind-bar" class="rci-fill" style="background:#f08c42;width:30%"></span></span></span>
      </div>
      <div class="ribbon-chip" title="Calendar">
        <div class="ribbon-line"><span id="month">Month 1</span></div>
        <div class="ribbon-line"><span id="day" class="ribbon-dim">Day 1/30</span></div>
      </div>
      <div class="ribbon-chip" title="Population and jobs">
        <div class="ribbon-line"><span id="population">👥 0</span></div>
        <div class="ribbon-line"><span id="jobs">💼 0</span></div>
      </div>
    </div>
    <div class="ribbon-controls">
      <div class="ribbon-chip ribbon-btn-group" role="group" aria-label="Simulation speed">
        <button id="speed-slow" class="ribbon-btn" title="Slow (hotkey 1)" aria-label="Slow speed">▶</button>
        <button id="speed-fast" class="ribbon-btn" title="Fast (hotkey 2)" aria-label="Fast speed">⏩</button>
        <button id="speed-ludicrous" class="ribbon-btn" title="Ludicrous (hotkey 3)" aria-label="Ludicrous speed">⚡</button>
      </div>
      <details class="ribbon-menu">
        <summary class="ribbon-btn" title="Saves — save, load, download, upload" aria-label="Saves menu">💾</summary>
        <div class="ribbon-menu-panel">
          <button id="save-btn" class="secondary">Save</button>
          <button id="load-btn" class="secondary">Load</button>
          <button id="download-btn" class="primary">Download</button>
          <button id="upload-btn" class="secondary">Upload</button>
          <input type="file" id="file-input" accept="application/json" style="display:none" />
        </div>
      </details>
      <button id="manual-btn" class="ribbon-btn" title="Open the in-game manual" aria-label="Open manual">📖</button>
      <details class="ribbon-menu">
        <summary class="ribbon-btn" title="Debug — overlay, state snapshot, penalties, sim engine" aria-label="Debug menu">🛠️</summary>
        <div class="ribbon-menu-panel">
          <button id="debug-overlay-btn" class="secondary">Show overlay</button>
          <button id="debug-copy-btn" class="secondary">Copy state</button>
          <button id="pending-penalty-btn" class="secondary">Penalties: On</button>
          <button id="sim-bridge-btn" class="secondary">Sim: WASM</button>
        </div>
      </details>
    </div>
  </div>
  <div class="news-ticker news-ticker-hidden" id="news-ticker">
    <span class="news-ticker-label">News</span>
    <span class="news-ticker-text"></span>
  </div>
  <div id="viewport">
    <div class="toolbar" id="toolbar"></div>
    <div class="canvas-wrapper" id="canvas-wrapper"></div>
  </div>
  <footer>
    <span class="footer-copy">Offline ready • WebGL powered • Inspired by pixel skylines</span>
    <a class="footer-link" href="https://github.com/ScottMorris/city-sim-1000" target="_blank" rel="noopener">
      View on GitHub
    </a>
  </footer>
`;

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) {
    throw new Error(`UI element missing: ${selector}`);
  }
  return el;
}

const toolbar = requireElement<HTMLDivElement>('#toolbar');
const viewport = requireElement<HTMLDivElement>('#viewport');
const wrapper = requireElement<HTMLDivElement>('#canvas-wrapper');
const moneyEl = requireElement<HTMLDivElement>('#money');
const budgetNetEl = requireElement<HTMLDivElement>('#budget-net');
const powerEl = requireElement<HTMLDivElement>('#power');
const waterEl = requireElement<HTMLDivElement>('#water');
const resBar = requireElement<HTMLDivElement>('#res-bar');
const comBar = requireElement<HTMLDivElement>('#com-bar');
const indBar = requireElement<HTMLDivElement>('#ind-bar');
const popEl = requireElement<HTMLDivElement>('#population');
const jobsEl = requireElement<HTMLDivElement>('#jobs');
const monthEl = requireElement<HTMLDivElement>('#month');
const dayEl = requireElement<HTMLDivElement>('#day');
const speedSlowBtn = requireElement<HTMLButtonElement>('#speed-slow');
const speedFastBtn = requireElement<HTMLButtonElement>('#speed-fast');
const speedLudicrousBtn = requireElement<HTMLButtonElement>('#speed-ludicrous');
const saveBtn = requireElement<HTMLButtonElement>('#save-btn');
const loadBtn = requireElement<HTMLButtonElement>('#load-btn');
const downloadBtn = requireElement<HTMLButtonElement>('#download-btn');
const uploadBtn = requireElement<HTMLButtonElement>('#upload-btn');
const fileInput = requireElement<HTMLInputElement>('#file-input');
const manualBtn = requireElement<HTMLButtonElement>('#manual-btn');
const debugOverlayBtn = requireElement<HTMLButtonElement>('#debug-overlay-btn');
const debugCopyBtn = requireElement<HTMLButtonElement>('#debug-copy-btn');
const pendingPenaltyBtn = requireElement<HTMLButtonElement>('#pending-penalty-btn');
const simBridgeBtn = requireElement<HTMLButtonElement>('#sim-bridge-btn');
const newsTickerEl = requireElement<HTMLDivElement>('#news-ticker');

// Ribbon dropdowns (<details>): only one open at a time, close on outside
// click or Escape, and close the saves menu after an action is chosen.
const ribbonMenus = [...document.querySelectorAll<HTMLDetailsElement>('details.ribbon-menu')];
for (const menu of ribbonMenus) {
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    for (const other of ribbonMenus) {
      if (other !== menu) other.open = false;
    }
  });
}
document.addEventListener('pointerdown', (e) => {
  for (const menu of ribbonMenus) {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const menu of ribbonMenus) menu.open = false;
  }
});
// Save/Load/Download/Upload are one-shot actions — collapse after use. The
// debug menu stays open because its buttons are stateful toggles.
const savesMenu = ribbonMenus.find((m) => m.querySelector('#save-btn'));
savesMenu?.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    savesMenu.open = false;
  });
});

const syncToolbarHeights = () => {
  const rect = toolbar.getBoundingClientRect();
  const styles = getComputedStyle(toolbar);
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const paddingBottom = parseFloat(styles.paddingBottom) || 0;
  const borderTop = parseFloat(styles.borderTopWidth) || 0;
  const borderBottom = parseFloat(styles.borderBottomWidth) || 0;
  const primaryRow = toolbar.querySelector<HTMLElement>('.toolbar-row');
  const primaryHeight = primaryRow?.getBoundingClientRect().height ?? 0;
  const baseHeight = Math.max(primaryHeight + paddingTop + paddingBottom + borderTop + borderBottom, 72);
  const visibleHeight = Math.max(rect.height || 0, baseHeight);
  viewport.style.setProperty('--toolbar-base-height', `${baseHeight}px`);
  viewport.style.setProperty('--toolbar-visible-height', `${visibleHeight}px`);
};

function ensureSettingsShape(settings?: GameState['settings']): GameState['settings'] {
  const minimapDefaults = createDefaultMinimapSettings();
  const minimapSettings = {
    ...minimapDefaults,
    ...(settings?.minimap ?? {})
  };
  if (!['base', 'power', 'water', 'alerts', 'education', 'underground'].includes(minimapSettings.mode)) {
    minimapSettings.mode = 'base';
  }
  const inputDefaults = createDefaultInputSettings();
  const accessibilityDefaults = createDefaultAccessibilitySettings();
  const audioDefaults = createDefaultAudioSettings();
  const cosmeticDefaults = createDefaultCosmeticSettings();
  const narrativeDefaults = createDefaultNarrativeSettings();
  const uiDefaults = createDefaultUiSettings();
  const uiSettings = { ...uiDefaults, ...(settings?.ui ?? {}) };
  if (!['auto', 'desktop', 'mobile'].includes(uiSettings.mode)) {
    uiSettings.mode = 'auto';
  }
  return {
    pendingPenaltyEnabled: settings?.pendingPenaltyEnabled ?? true,
    minimap: minimapSettings,
    input: { ...inputDefaults, ...(settings?.input ?? {}) },
    accessibility: { ...accessibilityDefaults, ...(settings?.accessibility ?? {}) },
    audio: { ...audioDefaults, ...(settings?.audio ?? {}) },
    hotkeys: { ...defaultHotkeys, ...(settings?.hotkeys ?? {}) },
    cosmetics: { ...cosmeticDefaults, ...(settings?.cosmetics ?? {}) },
    narrative: { ...narrativeDefaults, ...(settings?.narrative ?? {}) },
    ui: uiSettings
  };
}

const app = new Application();
const camera = createCamera();
let hovered: Position | null = null;
let selected: Position | null = null;
let isPanning = false;
let isPainting = false;
let pointerActive = false;
let panStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };
let lastPainted: Position | null = null;
// Live touch pointers keyed by pointerId, so a two-finger gesture can compute
// a midpoint from both fingers' latest positions rather than just whichever
// finger's pointermove happened to fire last.
const activeTouchPointers = new Map<number, { x: number; y: number }>();
let isPinching = false;
let lastPinchMidpoint: { x: number; y: number } | null = null;
let lastPinchDistance: number | null = null;
// A single touch's down position and whether it's moved past tap slop yet —
// keeps a slightly-trembling tap from registering as a one-tile drag-paint.
const TOUCH_TAP_SLOP_PX = 10;
let touchDownPos: { x: number; y: number } | null = null;
let touchSlopExceeded = false;
let activeTool: Tool = Tool.Inspect;
let selectedTool: Tool = Tool.Inspect;
let temporaryTool: Tool | null = null;
let state: GameState = loadFromBrowser() ?? createInitialState();
state.settings = ensureSettingsShape(state.settings);
// Dev override, same pattern as `?bridge=`: forces `desktop`/`mobile` for
// this load. Unlike the bridge param, this mutates `state.settings` (the
// persisted shape), so — same as any other in-session settings change — an
// explicit Save while the override is active will persist it too.
const uiParam = new URLSearchParams(window.location.search).get('ui');
if (uiParam === 'desktop' || uiParam === 'mobile') {
  state.settings.ui.mode = uiParam;
}
const notifications = createNotificationCenter();
const narrativeManager = new NarrativeManager({
  enabled: state.settings.narrative.enabled,
  tickerEnabled: state.settings.narrative.tickerEnabled
});
const bridgeParam = new URLSearchParams(window.location.search).get('bridge');
// Auto-detect Tauri shell when no explicit param is set.
const inTauri = '__TAURI_INTERNALS__' in window;
const isTauri = bridgeParam === 'tauri' || (inTauri && bridgeParam !== 'wasm' && bridgeParam !== 'ts');
const isTs    = bridgeParam === 'ts';
let activeBridgeKind: 'wasm' | 'local' | 'tauri' = isTauri ? 'tauri' : isTs ? 'local' : 'wasm';
let bridge: SimBridge = isTauri
  ? new TauriSimBridge(state)
  : isTs
    ? new LocalSimBridge(state, { ticksPerSecond: 20 })
    : new WasmSimBridge(state);

const loadingScreen = initLoadingScreen(document.body);

function wireBridge(b: SimBridge): void {
  b.onMessage((msg: FromSim) => {
    if (msg.type === 'Ready') {
      loadingScreen.complete();
    } else if (msg.type === 'Alert') {
      notifications.publish({
        id: msg.data.kind,
        message: msg.data.message,
        sticky: msg.data.sticky,
      });
    } else if (msg.type === 'Narrative') {
      narrativeManager.onEvent(msg.data.payload as Parameters<typeof narrativeManager.onEvent>[0]);
    }
  });
}

wireBridge(bridge);
initMcpBridge(bridge, state);

function swapSimBridge(): void {
  if (activeBridgeKind === 'tauri') return; // Tauri bridge is not swappable
  const currentState = bridge.getState();
  const nextKind = activeBridgeKind === 'wasm' ? 'local' : 'wasm';
  let newBridge: SimBridge;
  // Carry the command log across the swap so the city survives in both
  // directions. WASM→TS seeds the LocalSimBridge log so a second swap back to
  // WASM can replay. TS→WASM replays the log into a fresh SimHost before ready.
  const cmdLog = bridge.getCommandLog() ?? [];
  if (nextKind === 'wasm') {
    newBridge = new WasmSimBridge(currentState, {}, cmdLog.length ? cmdLog : undefined);
  } else {
    newBridge = new LocalSimBridge(currentState, { ticksPerSecond: 20, initialCmdLog: cmdLog });
  }
  wireBridge(newBridge);
  newBridge.setSpeed(simSpeeds[simSpeed]);
  bridge.dispose();
  bridge = newBridge;
  activeBridgeKind = nextKind;
  simBridgeBtn.textContent = `Sim: ${nextKind === 'wasm' ? 'WASM' : 'TS'}`;
  simBridgeBtn.classList.toggle('active', nextKind === 'local');
}
let debugOverlay: ReturnType<typeof initDebugOverlay> | null = null;
let hotkeys: HotkeyController | null = null;
let minimap: ReturnType<typeof initMinimap> | null = null;
let radioController: RadioWidget | null = null;
let newsTicker: ReturnType<typeof initNewsTicker> | null = null;
const PAN_SPEEDS = {
  slow: 420,
  normal: 700,
  fast: 1000
} as const;
const ZOOM_STEPS = {
  gentle: 0.06,
  normal: 0.1,
  fast: 0.18
} as const;
// Default camera scale on a compact layout, vs. the desktop default of 1 —
// makes each tile a comfortable touch target instead of finger-tip-sized.
const COMPACT_DEFAULT_ZOOM = 1.75;
const simSpeeds = {
  slow: 0.5,
  fast: 1,
  ludicrous: 3
} as const;
type SimSpeedKey = keyof typeof simSpeeds;
let simSpeed: SimSpeedKey = 'fast';
let lastNarrativeMonth = getCalendarPosition(state.day).month;
let lastNarrativeGc = Date.now();
let lastPlayerEventAt = 0;
const PLAYER_EVENT_COOLDOWN_MS = 1500;

const getPlayerActionMessage = (tool: Tool) => {
  switch (tool) {
    case Tool.Road:
      return 'New roads laid across the city.';
    case Tool.Rail:
      return 'Rail corridors extended.';
    case Tool.PowerLine:
      return 'Power lines expanded.';
    case Tool.WaterPipe:
      return 'Underground pipes laid.';
    case Tool.HydroPlant:
      return 'Hydro plant commissioned.';
    case Tool.CoalPlant:
      return 'Coal plant commissioned.';
    case Tool.WindTurbine:
      return 'Wind turbines installed.';
    case Tool.SolarFarm:
      return 'Solar farm installed.';
    case Tool.WaterPump:
      return 'Water pump added.';
    case Tool.WaterTower:
      return 'Water tower added.';
    case Tool.ElementarySchool:
      return 'Elementary school opened.';
    case Tool.HighSchool:
      return 'High school opened.';
    case Tool.Residential:
      return 'New residential zoning approved.';
    case Tool.Commercial:
      return 'New commercial zoning approved.';
    case Tool.Industrial:
      return 'New industrial zoning approved.';
    case Tool.Park:
      return 'New park opened.';
    case Tool.Bulldoze:
      return 'Demolition crews active.';
    case Tool.Tree:
      return 'Greenery planted.';
    case Tool.TerraformRaise:
      return 'Terrain raised for new works.';
    case Tool.TerraformLower:
      return 'Terrain lowered for new works.';
    case Tool.Water:
      return 'Waterway expanded.';
    default:
      return null;
  }
};
const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
const centerCameraOnTile = (tileX: number, tileY: number) => {
  const size = TILE_SIZE * camera.scale;
  const viewTilesX = wrapper.clientWidth / size;
  const viewTilesY = wrapper.clientHeight / size;
  const halfX = Math.min(viewTilesX / 2, state.width / 2);
  const halfY = Math.min(viewTilesY / 2, state.height / 2);
  const targetX = clamp(tileX, halfX - 0.5, state.width - halfX - 0.5);
  const targetY = clamp(tileY, halfY - 0.5, state.height - halfY - 0.5);
  camera.x = wrapper.clientWidth / 2 - (targetX + 0.5) * size;
  camera.y = wrapper.clientHeight / 2 - (targetY + 0.5) * size;
};

const isInBounds = (pos: Position) =>
  pos.x >= 0 && pos.y >= 0 && pos.x < state.width && pos.y < state.height;

const setActiveTool = (nextTool: Tool) => {
  activeTool = nextTool;
  updateToolbar(toolbar, nextTool);
  syncToolbarHeights();
};

const selectTool = (nextTool: Tool) => {
  selectedTool = nextTool;
  temporaryTool = null;
  setActiveTool(nextTool);
};

const restoreSelectedTool = () => {
  if (!temporaryTool) return;
  temporaryTool = null;
  setActiveTool(selectedTool);
};

function applyCurrentTool(tilePos: Position) {
  if (!getTile(state, tilePos.x, tilePos.y)) return;
  if (activeTool === Tool.Inspect) {
    selected = tilePos;
    return;
  }
  const result = bridge.send(applyToolCmd(activeTool, tilePos.x, tilePos.y));
  if (!result.success && result.message) {
    showToast(result.message);
  } else if (result.success) {
    minimap?.markDirty();
    const now = Date.now();
    const message = getPlayerActionMessage(activeTool);
    if (message && now - lastPlayerEventAt > PLAYER_EVENT_COOLDOWN_MS) {
      narrativeManager.onEvent({
        id: `player-action-${now}`,
        type: 'player_action',
        timestamp: now,
        category: 'player',
        severity: 'info',
        message,
        data: { tool: activeTool, x: tilePos.x, y: tilePos.y }
      });
      lastPlayerEventAt = now;
    }
  }
  selected = null;
}

function attachViewportEvents(canvas: HTMLCanvasElement) {
  const pointerDebugEnabled = import.meta.env.DEV && localStorage.getItem('debug-pointer') === '1';
  const logPointerToTile = (phase: string, e: PointerEvent, tilePos: Position) => {
    if (!pointerDebugEnabled) return;
    const rect = canvas.getBoundingClientRect();
    console.debug('[pointer->tile]', phase, {
      client: { x: e.clientX, y: e.clientY, buttons: e.buttons },
      offsetFromCanvas: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      canvasCssSize: { width: rect.width, height: rect.height },
      canvasPixelSize: { width: canvas.width, height: canvas.height },
      tilePos,
      tileSizePx: TILE_SIZE * camera.scale,
      camera: { ...camera }
    });
  };

  // Both only ever called while at least two touch pointers are active.
  const touchMidpoint = () => {
    let x = 0;
    let y = 0;
    for (const p of activeTouchPointers.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / activeTouchPointers.size, y: y / activeTouchPointers.size };
  };
  // Average distance from the midpoint, doubled so it equals the finger-to-finger
  // distance in the common two-finger case (distance-from-centroid is half of that).
  const touchSpread = (mid: { x: number; y: number }) => {
    let total = 0;
    for (const p of activeTouchPointers.values()) {
      total += Math.hypot(p.x - mid.x, p.y - mid.y);
    }
    return (total / activeTouchPointers.size) * 2;
  };

  wrapper.addEventListener('contextmenu', (e) => e.preventDefault());

  wrapper.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchPointers.size >= 2) {
        // A second finger always means camera control: cancel any in-progress
        // paint before it can commit another tile, and start a pinch-pan
        // gesture from the fingers' midpoint/spread. Re-priming on a third
        // finger joining (rather than requiring exactly two) avoids a jump.
        isPainting = false;
        lastPainted = null;
        hovered = null;
        isPinching = true;
        lastPinchMidpoint = touchMidpoint();
        lastPinchDistance = touchSpread(lastPinchMidpoint);
        return;
      }
      touchDownPos = { x: e.clientX, y: e.clientY };
      touchSlopExceeded = false;
    }
    const tilePos = screenToTile(camera, TILE_SIZE, canvas, e.clientX, e.clientY);
    logPointerToTile('pointerdown', e, tilePos);
    hovered = isInBounds(tilePos) ? tilePos : null;
    pointerActive = true;
    if (e.button === 1 || e.altKey) {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      cameraStart = { ...camera };
      return;
    }
    if (e.button === 2) {
      if (activeTool === Tool.Inspect) {
        return;
      }
      if (!temporaryTool) {
        temporaryTool = activeTool;
        setActiveTool(Tool.Bulldoze);
      }
    }
    if (hovered) {
      isPainting = true;
      lastPainted = hovered;
      applyCurrentTool(hovered);
    }
  });

  wrapper.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && activeTouchPointers.has(e.pointerId)) {
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    pointerActive = e.buttons !== 0;
    if (isPinching && lastPinchMidpoint && lastPinchDistance !== null) {
      const midpoint = touchMidpoint();
      camera.x += midpoint.x - lastPinchMidpoint.x;
      camera.y += midpoint.y - lastPinchMidpoint.y;
      const distance = touchSpread(midpoint);
      if (lastPinchDistance > 0 && distance > 0) {
        const inputSettings = state.settings.input;
        const sensitivity = (ZOOM_STEPS[inputSettings.zoomSensitivity] ?? ZOOM_STEPS.normal) / ZOOM_STEPS.normal;
        const factor = Math.pow(distance / lastPinchDistance, sensitivity);
        const rect = canvas.getBoundingClientRect();
        zoomAt(camera, midpoint.x - rect.left, midpoint.y - rect.top, factor);
      }
      lastPinchMidpoint = midpoint;
      if (distance > 0) {
        lastPinchDistance = distance;
      }
      return;
    }
    if (isPanning) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      camera.x = cameraStart.x + dx;
      camera.y = cameraStart.y + dy;
      return;
    }
    const tilePos = screenToTile(camera, TILE_SIZE, canvas, e.clientX, e.clientY);
    logPointerToTile('pointermove', e, tilePos);
    hovered = isInBounds(tilePos) ? tilePos : null;
    if (activeTool === Tool.Inspect) {
      selected = hovered;
    }
    if (e.pointerType === 'touch' && touchDownPos && !touchSlopExceeded) {
      const dx = e.clientX - touchDownPos.x;
      const dy = e.clientY - touchDownPos.y;
      if (Math.hypot(dx, dy) < TOUCH_TAP_SLOP_PX) {
        return;
      }
      touchSlopExceeded = true;
    }
    const primaryDown = (e.buttons & 1) !== 0;
    const secondaryDown = (e.buttons & 2) !== 0;
    const isPaintingWithSecondary = secondaryDown && activeTool === Tool.Bulldoze;
    const shouldPaint = hovered && activeTool !== Tool.Inspect && (primaryDown || isPaintingWithSecondary);
    if (shouldPaint) {
      if (!isPainting) {
        isPainting = true;
      }
      const alreadyPainted =
        lastPainted && lastPainted.x === hovered!.x && lastPainted.y === hovered!.y;
      if (!alreadyPainted) {
        applyCurrentTool(hovered!);
        lastPainted = hovered;
      }
    } else if (!primaryDown && !secondaryDown && isPainting) {
      stopPainting();
    }
  });

  const stopPainting = (e?: PointerEvent) => {
    if (e?.pointerType === 'touch') {
      activeTouchPointers.delete(e.pointerId);
    }
    isPanning = false;
    isPinching = false;
    lastPinchMidpoint = null;
    lastPinchDistance = null;
    touchDownPos = null;
    touchSlopExceeded = false;
    isPainting = false;
    lastPainted = null;
    pointerActive = false;
    restoreSelectedTool();
  };

  wrapper.addEventListener('pointerup', stopPainting);
  window.addEventListener('pointerup', stopPainting);
  wrapper.addEventListener('pointercancel', stopPainting);
  window.addEventListener('pointercancel', stopPainting);

  wrapper.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const inputSettings = state.settings.input;
      const panSpeed = PAN_SPEEDS[inputSettings.panSpeed] ?? PAN_SPEEDS.normal;
      if (e.ctrlKey && inputSettings.ctrlScrollsToPan) {
        const scale = (panSpeed / PAN_SPEEDS.normal) * 0.35;
        const horizontalDelta =
          Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        camera.x -= horizontalDelta * scale;
        return;
      }
      if (inputSettings.shiftScrollsToPan && e.shiftKey) {
        const scale = (panSpeed / PAN_SPEEDS.normal) * 0.35;
        camera.x -= e.deltaX * scale;
        camera.y -= e.deltaY * scale;
        return;
      }
      const zoomStep = ZOOM_STEPS[inputSettings.zoomSensitivity] ?? ZOOM_STEPS.normal;
      const factor = e.deltaY > 0 ? 1 - zoomStep : 1 + zoomStep;
      const rect = canvas.getBoundingClientRect();
      zoomAt(camera, e.clientX - rect.left, e.clientY - rect.top, factor);
    },
    { passive: false }
  );
}

let lastFrame = performance.now();
function gameLoop(renderer: MapRenderer, hud: ReturnType<typeof createHud>) {
  try {
    const now = performance.now();
    const deltaSeconds = (now - lastFrame) / 1000;
    lastFrame = now;
    const movement = hotkeys?.getMovementVector();
    if (movement) {
      const panSpeed = PAN_SPEEDS[state.settings.input.panSpeed] ?? PAN_SPEEDS.normal;
      const direction = state.settings.input.invertPan ? -1 : 1;
      camera.x -= movement.x * panSpeed * direction * deltaSeconds;
      camera.y -= movement.y * panSpeed * direction * deltaSeconds;
    }
    bridge.step(deltaSeconds);
    const calendar = getCalendarPosition(state.day);
    while (calendar.month > lastNarrativeMonth) {
      narrativeManager.onMonthEnd(() => buildCitySnapshot(state), Date.now(), simSpeeds[simSpeed]);
      lastNarrativeMonth += 1;
    }
    const nowMs = Date.now();
    if (nowMs - lastNarrativeGc > 1000) {
      narrativeManager.gc(nowMs);
      lastNarrativeGc = nowMs;
    }
    const overlayMode = state.settings?.minimap?.mode ?? 'base';
    renderer.render(state, hovered, selected, overlayMode, pointerActive, activeTool);
    hud.update(state);
    hud.renderOverlays(state, selected, activeTool);
    minimap?.update(state, camera);
    newsTicker?.update();
    debugOverlay?.update(state);
  } catch (err) {
    console.error('[gameLoop] uncaught error — loop continuing', err);
  }
  requestAnimationFrame(() => gameLoop(renderer, hud));
}

(async function bootstrap() {
  const [paletteTexture, tileTextures] = await Promise.all([
    loadPaletteTexture(),
    loadTileTextures()
  ]);
  console.log('Palette texture loaded', paletteTexture);

  const renderer = new MapRenderer(wrapper, camera, TILE_SIZE, palette, tileTextures);
  await renderer.init(wrapper);
  // `resize` alone can lag or coalesce oddly around a mobile browser's own
  // chrome/toolbar animation during rotation — layoutMode's matchMedia-driven
  // change event is a more direct signal for the breakpoint actually flipping.
  const deviceMode = initDeviceMode({ onChange: syncToolbarHeights });
  if (deviceMode.getMode().layoutMode === 'compact') {
    // Deeper default zoom so tiles are a comfortable touch target on a small
    // screen, rather than starting at the same density as a full desktop view.
    camera.scale = COMPACT_DEFAULT_ZOOM;
  }
  centerCamera(state, wrapper, TILE_SIZE, camera);

  const hud = createHud({
    moneyEl,
    budgetNetEl,
    powerEl,
    waterEl,
    resBar,
    comBar,
    indBar,
    popEl,
    jobsEl,
    monthEl,
    dayEl,
    overlayRoot: wrapper
  });
  newsTicker = initNewsTicker({
    root: newsTickerEl,
    getItems: () => narrativeManager.getTickerQueue(),
    getEnabled: () => state.settings.narrative.enabled && state.settings.narrative.tickerEnabled,
    getReducedMotion: () => state.settings.accessibility.reducedMotion ?? false
  });
  const budgetModal = initBudgetModal({
    getState: () => state,
    getNarrativeEnabled: () => state.settings.narrative.enabled,
    getBudgetInsights: () => narrativeManager.getBudgetInsights(),
    refreshBudgetInsights: () => narrativeManager.refreshBudgetInsights(() => buildCitySnapshot(state))
  });
  const bylawsModal = initBylawsModal({
    getState: () => state,
    onSelectLighting: (lighting) => {
      state.bylaws = state.bylaws ?? { ...DEFAULT_BYLAWS };
      state.bylaws.lighting = lighting;
    }
  });

  const minimapViewport = () => {
    const canvas = renderer.getCanvas();
    return {
      width: canvas?.clientWidth ?? wrapper.clientWidth,
      height: canvas?.clientHeight ?? wrapper.clientHeight
    };
  };

  const setTool = (nextTool: Tool) => {
    selectTool(nextTool);
    if (nextTool === Tool.WaterPipe && state.settings.minimap.mode !== 'underground') {
      applySettings({ ...state.settings, minimap: { ...state.settings.minimap, mode: 'underground' } });
    } else if (
      nextTool !== Tool.WaterPipe &&
      nextTool !== Tool.Bulldoze &&
      state.settings.minimap.mode === 'underground'
    ) {
      applySettings({ ...state.settings, minimap: { ...state.settings.minimap, mode: 'base' } });
    }
  };

  const setSimSpeed = (speed: SimSpeedKey, opts: { silent?: boolean } = {}) => {
    simSpeed = speed;
    bridge.setSpeed(simSpeeds[speed]);
    speedSlowBtn.classList.toggle('active', speed === 'slow');
    speedFastBtn.classList.toggle('active', speed === 'fast');
    speedLudicrousBtn.classList.toggle('active', speed === 'ludicrous');
    if (!opts.silent) {
      showToast(
        `Speed: ${speed === 'slow' ? 'Slow (0.5x)' : speed === 'fast' ? 'Fast (1x)' : 'Ludicrous (3x)'}`
      );
    }
  };

  const updatePendingPenaltyBtn = () => {
    const enabled = state.settings?.pendingPenaltyEnabled ?? true;
    pendingPenaltyBtn.textContent = `Penalties: ${enabled ? 'On' : 'Off'}`;
    pendingPenaltyBtn.classList.toggle('active', enabled);
  };

  const handleHotkeyAction = (action: HotkeyAction) => {
    switch (action) {
      case 'selectInspect':
        setTool(Tool.Inspect);
        return;
      case 'selectTerraformRaise':
        setTool(Tool.TerraformRaise);
        return;
      case 'selectTerraformLower':
        setTool(Tool.TerraformLower);
        return;
      case 'selectWater':
        setTool(Tool.Water);
        return;
      case 'selectTrees':
        setTool(Tool.Tree);
        return;
      case 'selectRoad':
        setTool(Tool.Road);
        return;
      case 'selectRail':
        setTool(Tool.Rail);
        return;
      case 'selectPower':
        setTool(Tool.PowerLine);
        return;
      case 'selectHydro':
        setTool(Tool.HydroPlant);
        return;
      case 'selectWaterPump':
        setTool(Tool.WaterPump);
        return;
      case 'selectWaterTower':
        setTool(Tool.WaterTower);
        return;
      case 'selectElementarySchool':
        setTool(Tool.ElementarySchool);
        return;
      case 'selectHighSchool':
        setTool(Tool.HighSchool);
        return;
      case 'selectResidential':
        setTool(Tool.Residential);
        return;
      case 'selectCommercial':
        setTool(Tool.Commercial);
        return;
      case 'selectIndustrial':
        setTool(Tool.Industrial);
        return;
      case 'selectPark':
        setTool(Tool.Park);
        return;
      case 'selectBulldoze':
        setTool(Tool.Bulldoze);
        return;
      case 'speedSlow':
        setSimSpeed('slow');
        return;
      case 'speedFast':
        setSimSpeed('fast');
        return;
      case 'speedLudicrous':
        setSimSpeed('ludicrous');
        return;
      case 'toggleMinimap':
        minimap?.toggleOpen();
        minimap?.markDirty();
        return;
    }
  };

  const rebuildHotkeys = () => {
    hotkeys?.dispose();
    hotkeys = initHotkeys({
      bindings: state.settings.hotkeys ?? defaultHotkeys,
      onAction: handleHotkeyAction
    });
  };

  const applySettings = (
    nextSettings: GameState['settings'],
    options: { skipHotkeyReload?: boolean } = {}
  ) => {
    const previous = state.settings;
    const normalized = ensureSettingsShape(nextSettings);
    const minimapChanged =
      previous.minimap.open !== normalized.minimap.open ||
      previous.minimap.size !== normalized.minimap.size ||
      previous.minimap.mode !== normalized.minimap.mode;
    const hotkeysChanged =
      JSON.stringify(previous.hotkeys ?? {}) !== JSON.stringify(normalized.hotkeys ?? {});
    state.settings = normalized;
    narrativeManager.setSettings({
      enabled: state.settings.narrative.enabled,
      tickerEnabled: state.settings.narrative.tickerEnabled
    });
    newsTicker?.update();
    if (minimapChanged) {
      minimap?.syncSettings(state.settings.minimap);
      minimap?.markDirty();
    }
    updatePendingPenaltyBtn();
    radioController?.setVolume(state.settings.audio.radioVolume ?? 1);
    const shouldReloadHotkeys = hotkeysChanged || !hotkeys;
    if (!options.skipHotkeyReload && shouldReloadHotkeys) {
      rebuildHotkeys();
    }
  };

  let settingsModal: ReturnType<typeof initSettingsModal> | null = null;

  minimap = initMinimap({
    root: wrapper,
    settings: state.settings.minimap,
    onSettingsChange: (next) => {
      applySettings({ ...state.settings, minimap: next }, { skipHotkeyReload: true });
    },
    onJumpToTile: ({ x, y }) => centerCameraOnTile(x, y),
    getViewportSize: minimapViewport,
    palette
  });

  settingsModal = initSettingsModal({
    getSettings: () => state.settings,
    onApply: (next) => applySettings(next)
  });

  const toolbarControllers = initToolbar(
    toolbar,
    (nextTool) => {
      setTool(nextTool);
    },
    activeTool,
    {
      onOpenBudget: () => budgetModal.open(),
      onOpenBylaws: () => bylawsModal.open(),
      onOpenSettings: () => settingsModal?.open(),
      radioVolume: state.settings.audio.radioVolume
    }
  );
  radioController = toolbarControllers.radio;
  applySettings(state.settings);
  syncToolbarHeights();
  window.addEventListener('resize', syncToolbarHeights);
  requestAnimationFrame(syncToolbarHeights);

  bindPersistenceControls({
    saveBtn,
    loadBtn,
    downloadBtn,
    uploadBtn,
    fileInput,
    getState: () => state,
    getCmdLog: () => bridge.getCommandLog() ?? [],
    onStateLoaded: (loaded, cmdLog) => {
      state = loaded;
      applySettings(state.settings);
      bridge.loadState(state, cmdLog as { tool: Tool; x: number; y: number }[] | undefined);
      centerCamera(state, wrapper, TILE_SIZE, camera);
      narrativeManager.reset();
      lastNarrativeMonth = getCalendarPosition(state.day).month;
    }
  });

  manualBtn.addEventListener('click', () => showManualModal());

  debugOverlay = initDebugOverlay({
    root: wrapper,
    toggleBtn: debugOverlayBtn,
    copyBtn: debugCopyBtn,
    getState: () => state
  });

  pendingPenaltyBtn.addEventListener('click', () => {
    const current = state.settings?.pendingPenaltyEnabled ?? true;
    applySettings({ ...state.settings, pendingPenaltyEnabled: !current }, { skipHotkeyReload: true });
    showToast(`Over-zoning penalty ${state.settings.pendingPenaltyEnabled ? 'enabled' : 'disabled'}`);
  });

  simBridgeBtn.style.display = activeBridgeKind === 'tauri' ? 'none' : '';
  simBridgeBtn.textContent = `Sim: ${activeBridgeKind === 'local' ? 'TS' : 'WASM'}`;
  simBridgeBtn.classList.toggle('active', activeBridgeKind === 'local');
  simBridgeBtn.addEventListener('click', () => {
    swapSimBridge();
    showToast(`Switched to ${activeBridgeKind === 'local' ? 'TypeScript' : 'WASM'} simulation`);
  });

  speedSlowBtn.addEventListener('click', () => setSimSpeed('slow'));
  speedFastBtn.addEventListener('click', () => setSimSpeed('fast'));
  speedLudicrousBtn.addEventListener('click', () => setSimSpeed('ludicrous'));
  setSimSpeed(simSpeed, { silent: true });
  updatePendingPenaltyBtn();

  attachViewportEvents(renderer.getCanvas());

  const cancelCurrentTool = () => {
    const wasInspect = activeTool === Tool.Inspect;
    isPainting = false;
    lastPainted = null;
    setTool(Tool.Inspect);
    if (wasInspect) {
      selected = null;
    }
  };

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      void bridge.undo().then((happened) => {
        if (happened) {
          notifications.publish({ id: 'undo', message: 'Undone', sticky: false });
        }
      });
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelCurrentTool();
    }
  });

  hud.update(state);
  registerServiceWorker();
  requestAnimationFrame(() => gameLoop(renderer, hud));
})();
