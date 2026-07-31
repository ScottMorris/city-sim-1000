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
  getTile,
  MinimapMode
} from './game/gameState';
import { Tool } from './game/toolTypes';
import { WasmSimBridge } from './game/wasmSimBridge';
import { TauriSimBridge } from './game/tauriSimBridge';
import type { SimBridge } from './game/simBridge';
import { applyToolCmd, nextStrokeId, setPoliciesCmd } from './game/protocol/commands';
import type { FromSim } from './game/protocol/events';
import {
  buildLegacyEngineImport,
  buildSaveMeta,
  clearLegacyBrowserSave,
  decodeSave,
  encodeSave,
  loadLegacyBrowserSave,
  type SaveContainer
} from './game/persistence';
import { applyClientState, ensureSettingsShape, extractClientState } from './game/clientState';
import { getSave, pickNewestSave, putSave } from './game/saveStore';
import { initAutosave } from './game/autosave';
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
import { initToolbar, updateToolbar, type ToolbarControllers } from './ui/toolbar';
import { createNotificationCenter } from './ui/notifications';
import { initMinimap } from './ui/minimap';
import { initBudgetModal } from './ui/budgetModal';
import { initSettingsModal } from './ui/settingsModal';
import { initBylawsModal } from './ui/bylawsModal';
import { initSfx } from './ui/sfx';
import { initSfxEditorModal } from './ui/sfxEditor';
import { loadGlobalSfxOverrides, saveGlobalSfxOverrides } from './game/globalSfxStore';
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
      <button type="button" id="treasury-chip" class="ribbon-chip ribbon-chip-button" title="City treasury and utilities — click to open the budget screen">
        <div class="ribbon-line">
          <span id="money" class="ribbon-strong">$0</span>
          <span id="budget-net" class="budget-net">+$0 / month</span>
        </div>
        <div class="ribbon-line">
          <span id="power">⚡ 0 MW</span>
          <span id="water">💧 0 m³</span>
        </div>
      </button>
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
      <button type="button" class="ribbon-chip ribbon-chip-button" id="wilderness-chip" title="Wilderness score — how much of the map is thriving nature">
        <div class="ribbon-line"><span id="wilderness" class="ribbon-strong">🌲 —</span></div>
        <div class="ribbon-line"><span class="ribbon-dim">Wilderness</span></div>
      </button>
    </div>
    <div class="ribbon-controls">
      <details class="ribbon-menu">
        <summary id="speed-summary" class="ribbon-btn" title="Simulation speed" aria-label="Speed menu">🐇</summary>
        <div class="ribbon-menu-panel">
          <button id="speed-slow" class="secondary" title="Slow — 0.5x (hotkey 1)">🐢 Slow (0.5x)</button>
          <button id="speed-fast" class="secondary" title="Fast — 1x (hotkey 2)">🐇 Fast (1x)</button>
          <button id="speed-ludicrous" class="secondary" title="Ludicrous — 3x (hotkey 3)">⚡ Ludicrous (3x)</button>
        </div>
      </details>
      <button id="pause-btn" class="ribbon-btn" title="Pause (hotkey Space)" aria-label="Pause">⏸</button>
      <button id="mute-btn" class="ribbon-btn" title="Mute sound effects" aria-label="Mute sound effects">🔊</button>
      <button id="budget-modal-btn" class="ribbon-btn" title="Open the budget screen" aria-label="Open budget">📊</button>
      <button id="bylaws-modal-btn" class="ribbon-btn" title="Open city bylaws" aria-label="Open bylaws">📜</button>
      <details class="ribbon-menu">
        <summary class="ribbon-btn" title="Saves — save, load, download, upload" aria-label="Saves menu">💾</summary>
        <div class="ribbon-menu-panel">
          <button id="save-btn" class="secondary">Save</button>
          <button id="load-btn" class="secondary">Load</button>
          <button id="download-btn" class="primary">Download</button>
          <button id="upload-btn" class="secondary">Upload</button>
          <input type="file" id="file-input" accept=".citysim,application/octet-stream,application/json" style="display:none" />
        </div>
      </details>
      <button id="manual-btn" class="ribbon-btn" title="Open the in-game manual" aria-label="Open manual">📖</button>
      <button id="settings-btn" class="ribbon-btn" title="Open settings" aria-label="Open settings">⚙️</button>
      <details class="ribbon-menu">
        <summary class="ribbon-btn" title="Debug — overlay, state snapshot, penalties, sim engine" aria-label="Debug menu">🛠️</summary>
        <div class="ribbon-menu-panel">
          <button id="debug-overlay-btn" class="secondary">Show overlay</button>
          <button id="debug-copy-btn" class="secondary">Copy state</button>
          <button id="pending-penalty-btn" class="secondary">Penalties: On</button>
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
const wildernessEl = requireElement<HTMLSpanElement>('#wilderness');
const wildernessChip = requireElement<HTMLButtonElement>('#wilderness-chip');
const monthEl = requireElement<HTMLDivElement>('#month');
const dayEl = requireElement<HTMLDivElement>('#day');
const speedSlowBtn = requireElement<HTMLButtonElement>('#speed-slow');
const speedFastBtn = requireElement<HTMLButtonElement>('#speed-fast');
const speedLudicrousBtn = requireElement<HTMLButtonElement>('#speed-ludicrous');
const speedSummaryEl = requireElement<HTMLElement>('#speed-summary');
const pauseBtn = requireElement<HTMLButtonElement>('#pause-btn');
const muteBtn = requireElement<HTMLButtonElement>('#mute-btn');
const saveBtn = requireElement<HTMLButtonElement>('#save-btn');
const loadBtn = requireElement<HTMLButtonElement>('#load-btn');
const downloadBtn = requireElement<HTMLButtonElement>('#download-btn');
const uploadBtn = requireElement<HTMLButtonElement>('#upload-btn');
const fileInput = requireElement<HTMLInputElement>('#file-input');
const manualBtn = requireElement<HTMLButtonElement>('#manual-btn');
const treasuryChip = requireElement<HTMLButtonElement>('#treasury-chip');
const budgetModalBtn = requireElement<HTMLButtonElement>('#budget-modal-btn');
const bylawsModalBtn = requireElement<HTMLButtonElement>('#bylaws-modal-btn');
const settingsBtn = requireElement<HTMLButtonElement>('#settings-btn');
const debugOverlayBtn = requireElement<HTMLButtonElement>('#debug-overlay-btn');
const debugCopyBtn = requireElement<HTMLButtonElement>('#debug-copy-btn');
const pendingPenaltyBtn = requireElement<HTMLButtonElement>('#pending-penalty-btn');
const newsTickerEl = requireElement<HTMLDivElement>('#news-ticker');

// Compact layout has no room for the minimap and the tile inspector as two
// separate floating panels (they collide) — they share one corner instead,
// switched with these tabs. Always created (cheap, two buttons); style.css
// scopes all of the compact-sharing CSS to the compact breakpoint, so this
// is inert on desktop regardless of the dataset value below.
const compactInfoTabs = document.createElement('div');
compactInfoTabs.className = 'compact-info-tabs';
const compactInfoTabMap = document.createElement('button');
compactInfoTabMap.type = 'button';
compactInfoTabMap.className = 'compact-info-tab';
compactInfoTabMap.textContent = '🗺️ Map';
// One combined tab, not a separate "Inspect" + "Tool" pair — desktop already
// shows tile-inspect results and the active tool's cost/upkeep/hints card in
// the very same shared spot, auto-switching on whichever the current tool
// makes relevant (hud.ts's 'auto' mode). Splitting that into two compact tabs
// meant "Inspect" was a dead, empty tab whenever any tool other than Inspect
// was active — this mirrors the desktop model instead: one tab, content (and
// its own label) follows the active tool. Label is refreshed in
// setActiveTool below, not just on tab clicks, since it needs to stay
// accurate even while this tab isn't the one currently open.
const compactInfoTabInspect = document.createElement('button');
compactInfoTabInspect.type = 'button';
compactInfoTabInspect.className = 'compact-info-tab';
compactInfoTabInspect.textContent = '🔍 Inspect';
compactInfoTabs.append(compactInfoTabMap, compactInfoTabInspect);
// compactInfoTabs is a DOM child of wrapper (like .minimap-panel and the hud
// .overlay before it), so without this a tap on it also bubbles up to
// wrapper's own pointerdown handler below and gets treated as a tile tap —
// applying the Inspect tool underneath and re-toggling the tab right back.
compactInfoTabs.addEventListener('pointerdown', (e) => e.stopPropagation());
wrapper.append(compactInfoTabs);

// Reassigned once `hud`/`deviceMode` exist inside bootstrap() below (same
// forward-declared-callback pattern as `handleDeviceModeChange`) — keeps both
// the tool-info card's and the tile-inspector's visibility (hud.ts's
// setToolInfoMode/setTileInspectMode) in sync with whichever compact tab is
// open, on every tab switch and layout-mode flip. They're never out of sync
// with each other, so one callback drives both.
let syncToolInfoMode: () => void = () => {};

function setCompactInfoTab(tab: 'map' | 'inspect' | 'none') {
  wrapper.dataset.compactInfoTab = tab;
  compactInfoTabMap.classList.toggle('active', tab === 'map');
  compactInfoTabInspect.classList.toggle('active', tab === 'inspect');
  syncToolInfoMode();
}
compactInfoTabMap.addEventListener('click', () => {
  setCompactInfoTab(wrapper.dataset.compactInfoTab === 'map' ? 'none' : 'map');
});
compactInfoTabInspect.addEventListener('click', () => {
  setCompactInfoTab(wrapper.dataset.compactInfoTab === 'inspect' ? 'none' : 'inspect');
});
setCompactInfoTab('none');

// Labels which content the combined tab currently holds — there's nothing to
// show for the Inspect tool itself (that's what tapping a tile is for), so
// every other tool reads as "Details" (its cost/upkeep/hints card) instead.
function syncCompactInfoTabLabel(tool: Tool) {
  compactInfoTabInspect.textContent = tool === Tool.Inspect ? '🔍 Inspect' : '🛠️ Details';
}
syncCompactInfoTabLabel(Tool.Inspect);

// Ribbon dropdowns (<details>): only one open at a time, close on outside
// click or Escape, and close the saves menu after an action is chosen.
const ribbonMenus = [...document.querySelectorAll<HTMLDetailsElement>('details.ribbon-menu')];
for (const menu of ribbonMenus) {
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    for (const other of ribbonMenus) {
      if (other !== menu) other.open = false;
    }
    // The panel is position: fixed (see style.css), so it isn't placed by
    // the normal flow — anchor it under this menu's own button each time.
    const panel = menu.querySelector<HTMLElement>('.ribbon-menu-panel');
    if (panel) {
      const rect = menu.getBoundingClientRect();
      panel.style.top = `${rect.bottom + 6}px`;
      panel.style.right = `${window.innerWidth - rect.right}px`;
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
// Picking a speed tier is a one-shot choice too — collapse after use.
const speedMenu = ribbonMenus.find((m) => m.querySelector('#speed-slow'));
speedMenu?.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    speedMenu.open = false;
  });
});

const syncToolbarHeights = () => {
  // The compact shell has no top-anchored row at all — everything lives in a
  // position: fixed dock/sheet at the bottom — so #viewport shouldn't reserve
  // any top padding for it the way it does for the full desktop toolbar row.
  if (toolbar.dataset.layoutMode === 'compact') {
    viewport.style.setProperty('--toolbar-base-height', '0px');
    viewport.style.setProperty('--toolbar-visible-height', '0px');
    // The compact-info-tabs / shared minimap+inspector panel float above
    // .toolbar-compact-dock (position: fixed, bottom: 0) — measure its real
    // height (varies with safe-area-inset-bottom) instead of guessing, same
    // approach as the full shell's own height vars above.
    const dockHeight = toolbar.querySelector('.toolbar-compact-dock')?.getBoundingClientRect().height ?? 0;
    viewport.style.setProperty('--compact-dock-height', `${dockHeight}px`);
    return;
  }
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


const app = new Application();
const camera = createCamera();
let hovered: Position | null = null;
let selected: Position | null = null;
let isPanning = false;
let isPainting = false;
// Stroke id for the paint gesture in progress. All ApplyTool commands sharing
// an id form a single undo step in the engine history; a fresh id is
// allocated whenever a gesture ends.
let strokeId = nextStrokeId();
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
// Set when one finger of a multi-touch gesture lifts while another is still
// down. Without this, the surviving finger's very next pointermove falls
// through to plain single-finger paint-drag handling — using wherever that
// finger currently happens to be as if it were a fresh tap — occasionally
// leaving an unwanted tile behind right as a pinch/pan gesture ends. Stays
// true until every finger is up; a genuinely new gesture starts fresh in
// pointerdown.
let ignoreTouchUntilAllLifted = false;
// A single touch's down position and whether it's moved past tap slop yet —
// keeps a slightly-trembling tap from registering as a one-tile drag-paint.
const TOUCH_TAP_SLOP_PX = 10;
let touchDownPos: { x: number; y: number } | null = null;
let touchSlopExceeded = false;
// A touch pointerdown can't tell in advance whether a second finger is about
// to land and turn it into a pinch/pan gesture — without this, the first
// finger down immediately (and expensively) applies the active tool to
// whatever tile it landed on. Give a fast-following second finger a brief
// grace window to arrive and cancel it before it commits.
const TOUCH_MULTI_TOUCH_GRACE_MS = 60;
let pendingTouchApply: { tile: Position; timeoutId: number } | null = null;

function cancelPendingTouchApply() {
  if (!pendingTouchApply) return;
  window.clearTimeout(pendingTouchApply.timeoutId);
  pendingTouchApply = null;
}
let activeTool: Tool = Tool.Inspect;
let selectedTool: Tool = Tool.Inspect;
let temporaryTool: Tool | null = null;
// The bridge always boots a fresh city; any browser save (CSAV in
// IndexedDB, or a legacy localStorage JSON) is loaded asynchronously right
// after the engine is ready — see `bootLoadSave` below.
const state: GameState = createInitialState();
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
const isTauri = bridgeParam === 'tauri' || (inTauri && bridgeParam !== 'wasm');
const bridge: SimBridge = isTauri ? new TauriSimBridge(state) : new WasmSimBridge(state);

const loadingScreen = initLoadingScreen(document.body);

// A stuck loading screen with no devtools access (a phone, most often) would
// otherwise be a silent dead end — surface anything that happens before the
// engine is up directly on the one screen we know is actually being looked at.
// Only relevant during boot, so both listeners come off once the outcome (Ready
// or InitError) is known — nothing after that point should still be routed here.
function onBootError(event: ErrorEvent): void {
  loadingScreen.showError(`Error: ${event.message}`);
}
function onBootRejection(event: PromiseRejectionEvent): void {
  const reason = event.reason;
  loadingScreen.showError(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
}
window.addEventListener('error', onBootError);
window.addEventListener('unhandledrejection', onBootRejection);
function stopBootErrorWatch(): void {
  window.removeEventListener('error', onBootError);
  window.removeEventListener('unhandledrejection', onBootRejection);
}

function wireBridge(b: SimBridge): void {
  b.onMessage((msg: FromSim) => {
    if (msg.type === 'Ready') {
      stopBootErrorWatch();
      loadingScreen.complete();
    } else if (msg.type === 'InitError') {
      stopBootErrorWatch();
      loadingScreen.showError(msg.message);
    } else if (msg.type === 'Alert') {
      notifications.publish({
        id: msg.data.kind,
        message: msg.data.message,
        sticky: msg.data.sticky,
      });
    } else if (msg.type === 'Narrative') {
      narrativeManager.onEvent(msg.data.payload as Parameters<typeof narrativeManager.onEvent>[0]);
    } else if (msg.type === 'CommandResult') {
      // The synchronous check in applyCurrentTool (bridge.send()'s return
      // value) can never see a failure — both bridges answer optimistically
      // before the engine has actually processed the command, so the click
      // already played the success chime. This is the real result, arriving
      // async; correct both the sound and the message the same way.
      if (!msg.success) {
        // playToolResult ignores `tool` entirely once `success` is false —
        // it always plays the throttled 'error' cue — so which tool was
        // active doesn't need to be correlated back to this specific call.
        sfx?.playToolResult(activeTool, false);
        if (msg.message) {
          // Keyed by message text, same as the Alert branch above keys by
          // kind: a drag-paint stroke can send one ApplyTool per tile, and a
          // sustained failure (e.g. running out of funds mid-drag) would
          // otherwise post one stacked toast per tile instead of one toast
          // that keeps refreshing.
          showToast(msg.message, { id: `command-result:${msg.message}`, severity: 'warning' });
        }
      }
    } else if (msg.type === 'HistoryChanged') {
      onHistoryChanged?.(msg.data);
    }
  });
}

// Set by UI modules (e.g. the compact-HUD undo button) that want to grey
// themselves out when nothing is undoable/redoable.
let onHistoryChanged: ((flags: { canUndo: boolean; canRedo: boolean }) => void) | null = null;

// `applySettings` is created inside the boot IIFE (it needs the DOM); load
// paths run before/outside it, so they reach it through this ref.
let applySettingsRef: ((settings: GameState['settings']) => void) | null = null;

/** "3 days" / "1 day" — for the undo/redo time-travel toasts. */
function formatDaySpan(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Undo the last stroke and confirm with the shared "Undone" toast. Undo
 * rewinds the clock to the pre-stroke moment, so when that skips a day or
 * more the toast says how far — time travel should never be silent.
 */
function performUndo(): void {
  const dayBefore = state.day;
  void bridge.undo().then((happened) => {
    if (happened) {
      const daysRewound = Math.floor(dayBefore - state.day);
      const message = daysRewound >= 1 ? `Undone — rewound ${formatDaySpan(daysRewound)}` : 'Undone';
      notifications.publish({ id: 'undo', message, sticky: false });
      minimap?.markDirty();
      sfx?.playUndo();
    }
  });
}

/** Redo the most recently undone stroke, mirroring `performUndo`. */
function performRedo(): void {
  const dayBefore = state.day;
  void bridge.redo().then((happened) => {
    if (happened) {
      const daysForward = Math.floor(state.day - dayBefore);
      const message = daysForward >= 1 ? `Redone — jumped forward ${formatDaySpan(daysForward)}` : 'Redone';
      notifications.publish({ id: 'redo', message, sticky: false });
      minimap?.markDirty();
    }
  });
}

/** Restore a decoded CSAV container into the engine and display mirror. */
async function loadCityContainer(container: SaveContainer): Promise<void> {
  await bridge.loadSnapshot(container.engineSnapshot);
  applyClientState(state, container.client);
  afterCityLoaded();
}

/** One-time import of a legacy JSON save, then upgrade it to CSAV. */
async function importLegacyCity(legacy: GameState): Promise<void> {
  await bridge.importLegacy(buildLegacyEngineImport(legacy));
  applyClientState(state, { settings: legacy.settings, bylaws: legacy.bylaws });
  bridge.send(setPoliciesCmd(legacy.policies));
  afterCityLoaded();
  try {
    // Upgrade in place; only drop the old localStorage save once the CSAV
    // write has definitely landed, so a failure keeps the legacy fallback.
    const bytes = encodeSave({
      meta: buildSaveMeta(state, 'manual', new Date().toISOString()),
      engineSnapshot: await bridge.getSnapshot(),
      client: extractClientState(state)
    });
    await putSave('manual', decodeSave(bytes).meta, bytes);
    clearLegacyBrowserSave();
  } catch {
    // IndexedDB unavailable (private mode, quota) — the legacy save stays.
  }
}

/** Post-load housekeeping shared by every load path. */
function afterCityLoaded(): void {
  applySettingsRef?.(state.settings);
  centerCamera(state, wrapper, TILE_SIZE, camera);
  narrativeManager.reset();
  lastNarrativeMonth = getCalendarPosition(state.day).month;
  minimap?.markDirty();
}

/** "just now" / "5 min ago" / "3 h ago" — for the autosave-restore toast. */
function formatAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

/**
 * Boot-time restore: the newest of the manual and autosave slots (a crash or
 * refresh should cost at most one autosave interval), else the legacy
 * localStorage save.
 */
async function bootLoadSave(): Promise<void> {
  try {
    const [manual, autosave] = await Promise.all([getSave('manual'), getSave('autosave')]);
    const record = pickNewestSave(manual, autosave);
    if (record) {
      await loadCityContainer(decodeSave(new Uint8Array(record.container)));
      if (record.id === 'autosave') {
        showToast(`Restored autosave from ${formatAgo(record.meta.savedAt)}`);
      }
      return;
    }
    const legacy = loadLegacyBrowserSave();
    if (legacy) {
      await importLegacyCity(legacy);
    }
  } catch (err) {
    console.error('[boot] failed to restore save', err);
    showToast('Could not restore your save — starting fresh', { severity: 'warning' });
  }
}

/**
 * Start the periodic autosave — only after the boot restore has resolved, so
 * a freshly booted default city can never overwrite a real autosave.
 */
function startAutosave(): void {
  let warnedOnce = false;
  initAutosave({
    getTick: () => state.tick,
    save: async () => {
      const engineSnapshot = await bridge.getSnapshot();
      const meta = buildSaveMeta(state, 'autosave', new Date().toISOString());
      const bytes = encodeSave({ meta, engineSnapshot, client: extractClientState(state) });
      await putSave('autosave', meta, bytes);
    },
    onError: (err) => {
      console.error('[autosave] failed', err);
      if (!warnedOnce) {
        warnedOnce = true;
        showToast('Autosave failed — use Download to back up your city', { severity: 'warning' });
      }
    }
  });
}

wireBridge(bridge);
initMcpBridge(bridge, state);
void bootLoadSave().finally(startAutosave);

let debugOverlay: ReturnType<typeof initDebugOverlay> | null = null;
let hotkeys: HotkeyController | null = null;
let minimap: ReturnType<typeof initMinimap> | null = null;
let radioController: RadioWidget | null = null;
let newsTicker: ReturnType<typeof initNewsTicker> | null = null;
let sfx: ReturnType<typeof initSfx> | null = null;
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
const SPEED_ICONS: Record<SimSpeedKey, string> = {
  slow: '🐢',
  fast: '🐇',
  ludicrous: '⚡'
};
type SimSpeedKey = keyof typeof simSpeeds;
let simSpeed: SimSpeedKey = 'fast';
let isPaused = false;
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
  syncCompactInfoTabLabel(nextTool);
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
    if (toolbar.dataset.layoutMode === 'compact') {
      setCompactInfoTab('inspect');
    }
    return;
  }
  // Both bridges answer this optimistically (success:true, always) before the
  // engine has actually processed the command — the real result, including
  // any failure message, arrives async as a `CommandResult` FromSim message
  // (see `wireBridge` above), not through this return value.
  const result = bridge.send(applyToolCmd(activeTool, tilePos.x, tilePos.y, strokeId));
  sfx?.playToolResult(activeTool, result.success);
  if (result.success) {
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
        cancelPendingTouchApply();
        isPainting = false;
        lastPainted = null;
        hovered = null;
        isPinching = true;
        ignoreTouchUntilAllLifted = false;
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
      if (e.pointerType === 'touch') {
        cancelPendingTouchApply();
        const tile = hovered;
        pendingTouchApply = {
          tile,
          timeoutId: window.setTimeout(() => {
            pendingTouchApply = null;
            isPainting = true;
            lastPainted = tile;
            applyCurrentTool(tile);
          }, TOUCH_MULTI_TOUCH_GRACE_MS)
        };
      } else {
        isPainting = true;
        lastPainted = hovered;
        applyCurrentTool(hovered);
      }
    }
  });

  wrapper.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && activeTouchPointers.has(e.pointerId)) {
      activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (e.pointerType === 'touch' && ignoreTouchUntilAllLifted) {
      return;
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
      // Dragging means this was never a stationary tap — let the paint-while-
      // dragging logic below take over from here rather than also committing
      // the original touchdown tile once the grace window above elapses.
      cancelPendingTouchApply();
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
      if (activeTouchPointers.size > 0) {
        // One finger of a multi-touch gesture lifted, but at least one other
        // is still down — stay fully inert (no accidental solo-paint using
        // the survivor's current position) until every finger is up. See
        // ignoreTouchUntilAllLifted's own comment for the failure mode this
        // avoids.
        isPanning = false;
        isPinching = false;
        lastPinchMidpoint = null;
        lastPinchDistance = null;
        touchDownPos = null;
        touchSlopExceeded = false;
        isPainting = false;
        lastPainted = null;
        pointerActive = false;
        ignoreTouchUntilAllLifted = true;
        return;
      }
      ignoreTouchUntilAllLifted = false;
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
    strokeId = nextStrokeId();
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
// Idle render-skip tracking (M4-2): renderer.render() is a full immediate-mode
// redraw (clears and rebuilds everything, no dirty flag) — the heaviest call
// in the loop. When the sim is paused AND the display mirror wasn't mutated
// this frame (bridge.step()'s return — covers both tool placements applied
// while paused and undo/redo/load landing out of band, not just camera/
// selection) AND none of the inputs that feed the draw have changed since
// the last frame, the redraw would produce a byte-identical frame, so it's
// skipped. HUD/minimap/ticker/debug overlay still run every frame regardless
// — comparatively cheap DOM writes, not worth the added complexity/risk of
// gating those too. Never skipped while unpaused — the sim is visibly
// progressing (tiles building, money changing) whenever unpaused, even if
// camera/selection happen to be momentarily unchanged.
let lastRenderCameraX = camera.x;
let lastRenderCameraY = camera.y;
let lastRenderCameraScale = camera.scale;
let lastRenderHovered: Position | null = hovered;
let lastRenderSelected: Position | null = selected;
let lastRenderTool: Tool = activeTool;
let lastRenderOverlayMode: MinimapMode | null = null;
let lastRenderPointerActive = pointerActive;
let hasRenderedOnce = false;

function positionsEqual(a: Position | null, b: Position | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y;
}

function gameLoop(renderer: MapRenderer, hud: ReturnType<typeof createHud>) {
  try {
    const now = performance.now();
    const deltaSeconds = (now - lastFrame) / 1000;
    lastFrame = now;
    debugOverlay?.recordFrame(deltaSeconds);
    const movement = hotkeys?.getMovementVector();
    if (movement) {
      const panSpeed = PAN_SPEEDS[state.settings.input.panSpeed] ?? PAN_SPEEDS.normal;
      const direction = state.settings.input.invertPan ? -1 : 1;
      camera.x -= movement.x * panSpeed * direction * deltaSeconds;
      camera.y -= movement.y * panSpeed * direction * deltaSeconds;
    }
    const mirrorChanged = bridge.step(deltaSeconds);
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
    const canSkipRender =
      hasRenderedOnce &&
      isPaused &&
      !mirrorChanged &&
      camera.x === lastRenderCameraX &&
      camera.y === lastRenderCameraY &&
      camera.scale === lastRenderCameraScale &&
      positionsEqual(hovered, lastRenderHovered) &&
      positionsEqual(selected, lastRenderSelected) &&
      activeTool === lastRenderTool &&
      overlayMode === lastRenderOverlayMode &&
      pointerActive === lastRenderPointerActive;
    if (!canSkipRender) {
      renderer.render(state, hovered, selected, overlayMode, pointerActive, activeTool);
      lastRenderCameraX = camera.x;
      lastRenderCameraY = camera.y;
      lastRenderCameraScale = camera.scale;
      lastRenderHovered = hovered;
      lastRenderSelected = selected;
      lastRenderTool = activeTool;
      lastRenderOverlayMode = overlayMode;
      lastRenderPointerActive = pointerActive;
      hasRenderedOnce = true;
    }
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

  // `resize` alone can lag or coalesce oddly around a mobile browser's own
  // chrome/toolbar animation during rotation — layoutMode's matchMedia-driven
  // change event is a more direct signal for the breakpoint actually flipping.
  // Reassigned once the toolbar is set up below, so a live layoutMode flip
  // (rotation across the compact/full breakpoint) can rebuild its shell too.
  let handleDeviceModeChange = () => syncToolbarHeights();
  const deviceMode = initDeviceMode({ onChange: () => handleDeviceModeChange() });
  if (deviceMode.getMode().layoutMode === 'compact') {
    // Deeper default zoom so tiles are a comfortable touch target on a small
    // screen, rather than starting at the same density as a full desktop view.
    camera.scale = COMPACT_DEFAULT_ZOOM;
    // Set this before the renderer first measures canvas-wrapper below,
    // rather than leaving it to syncToolbarHeights() afterward — Pixi's
    // resizeTo does resize its internal screen/canvas dimensions correctly
    // in response to a later CSS-only size change (confirmed), but the
    // canvas doesn't actually draw into the newly-available area regardless,
    // for reasons that didn't resolve with a manual app.resize() call either.
    // Simplest fix: never let the size change out from under it in the first
    // place. The compact shell has no top-anchored content, so this is 0
    // unconditionally, unlike the full shell's real .toolbar-row height.
    viewport.style.setProperty('--toolbar-base-height', '0px');
    viewport.style.setProperty('--toolbar-visible-height', '0px');
  }

  const renderer = new MapRenderer(wrapper, camera, TILE_SIZE, palette, tileTextures);
  await renderer.init(wrapper);
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
    wildernessEl,
    wildernessChip,
    overlayRoot: wrapper
  });
  // Always 'auto' now, desktop and compact alike — content picks itself
  // (tile info vs. the active tool's card) exactly like the desktop-only
  // panel always did. The CSS rule hiding .overlay entirely while the
  // compact "map"/"none" tab is showing is what actually gates visibility
  // on a phone; this only controls which content wins once it's visible.
  syncToolInfoMode = () => {
    hud.setToolInfoMode('auto');
    hud.setTileInspectMode('auto');
  };
  syncToolInfoMode();
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
    refreshBudgetInsights: () => narrativeManager.refreshBudgetInsights(() => buildCitySnapshot(state)),
    onPolicyChange: (policy) => {
      state.policies = { ...state.policies, budget: policy };
      bridge.send(setPoliciesCmd(state.policies));
    }
  });
  const bylawsModal = initBylawsModal({
    getState: () => state,
    onSelectLighting: (lighting) => {
      state.bylaws = state.bylaws ?? { ...DEFAULT_BYLAWS };
      state.bylaws.lighting = lighting;
    },
    onWildernessPolicyChange: (policy) => {
      state.policies = { ...state.policies, wilderness: policy };
      bridge.send(setPoliciesCmd(state.policies));
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
    isPaused = false;
    bridge.setSpeed(simSpeeds[speed]);
    speedSlowBtn.classList.toggle('active', speed === 'slow');
    speedFastBtn.classList.toggle('active', speed === 'fast');
    speedLudicrousBtn.classList.toggle('active', speed === 'ludicrous');
    speedSummaryEl.textContent = SPEED_ICONS[speed];
    pauseBtn.textContent = '⏸';
    pauseBtn.title = 'Pause (hotkey Space)';
    pauseBtn.setAttribute('aria-label', 'Pause');
    pauseBtn.classList.remove('active');
    if (!opts.silent) {
      showToast(
        `Speed: ${speed === 'slow' ? 'Slow (0.5x)' : speed === 'fast' ? 'Fast (1x)' : 'Ludicrous (3x)'}`
      );
    }
  };

  const togglePause = () => {
    isPaused = !isPaused;
    bridge.setSpeed(isPaused ? 0 : simSpeeds[simSpeed]);
    pauseBtn.textContent = isPaused ? '▶' : '⏸';
    pauseBtn.title = isPaused ? 'Resume (hotkey Space)' : 'Pause (hotkey Space)';
    pauseBtn.setAttribute('aria-label', isPaused ? 'Resume' : 'Pause');
    pauseBtn.classList.toggle('active', isPaused);
    showToast(isPaused ? 'Paused' : 'Resumed');
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
      case 'togglePause':
        togglePause();
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

  // In compact mode the minimap's own Hide/Show control is replaced by the
  // shared map/inspect tabs (see setCompactInfoTab above), so the panel's
  // *content* should always be ready to draw — force `open` in memory only
  // (syncSettings doesn't call onSettingsChange) rather than persisting it,
  // so an explicit "hide minimap" choice made on desktop survives a phone
  // session.
  const syncMinimapSettings = (settings: GameState['settings']['minimap']) => {
    minimap?.syncSettings(
      deviceMode.getMode().layoutMode === 'compact' ? { ...settings, open: true } : settings
    );
  };

  const syncMuteButton = () => {
    const muted = state.settings.audio.sfxMuted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
    const label = muted ? 'Unmute sound effects' : 'Mute sound effects';
    muteBtn.title = label;
    muteBtn.setAttribute('aria-label', label);
    muteBtn.classList.toggle('active', muted);
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
      syncMinimapSettings(state.settings.minimap);
      minimap?.markDirty();
    }
    updatePendingPenaltyBtn();
    radioController?.setVolume(state.settings.audio.radioVolume ?? 1);
    syncMuteButton();
    const shouldReloadHotkeys = hotkeysChanged || !hotkeys;
    if (!options.skipHotkeyReload && shouldReloadHotkeys) {
      rebuildHotkeys();
    }
  };

  let settingsModal: ReturnType<typeof initSettingsModal> | null = null;

  sfx = initSfx({
    getVolume: () => (state.settings.audio.sfxMuted ? 0 : (state.settings.audio.sfxVolume ?? 1)),
    getCityOverrides: () => state.settings.sfxOverrides,
    getGlobalOverrides: loadGlobalSfxOverrides
  });

  const sfxEditorModal = initSfxEditorModal({
    sfx,
    getCityOverrides: () => state.settings.sfxOverrides,
    getGlobalOverrides: loadGlobalSfxOverrides,
    onSaveCity: (next) => {
      state.settings.sfxOverrides = next;
    },
    onSaveGlobal: saveGlobalSfxOverrides
  });

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
  syncMinimapSettings(state.settings.minimap);

  settingsModal = initSettingsModal({
    getSettings: () => state.settings,
    onApply: (next) => applySettings(next),
    onOpenSfxEditor: () => sfxEditorModal.open()
  });

  treasuryChip.addEventListener('click', () => budgetModal.open());
  // No hover on touch — the breakdown behind this chip's `title` tooltip
  // (hud.ts's update()) needs a tap equivalent; reuse the same string
  // rather than recomputing it here.
  wildernessChip.addEventListener('click', () => {
    showToast(wildernessChip.title, { id: 'wilderness-breakdown', durationMs: 5000 });
  });
  budgetModalBtn.addEventListener('click', () => budgetModal.open());
  bylawsModalBtn.addEventListener('click', () => bylawsModal.open());
  settingsBtn.addEventListener('click', () => settingsModal?.open());

  let toolbarControllers: ToolbarControllers;
  const setupToolbar = () => {
    const previousStationId = toolbarControllers?.getActiveStationId();
    toolbarControllers = initToolbar(
      toolbar,
      (nextTool) => {
        setTool(nextTool);
      },
      activeTool,
      {
        layoutMode: deviceMode.getMode().layoutMode,
        radioVolume: state.settings.audio.radioVolume,
        radioStationId: previousStationId,
        onUndo: performUndo
      }
    );
    radioController = toolbarControllers.radio;
    // The compact-dock undo button greys itself in/out with the engine's
    // undo availability; seed the current value on every shell rebuild.
    toolbarControllers.setUndoEnabled(bridge.canUndo());
    onHistoryChanged = (flags) => toolbarControllers.setUndoEnabled(flags.canUndo);
  };
  setupToolbar();
  handleDeviceModeChange = () => {
    // Rebuild the toolbar shell first (if the mode actually flipped) so
    // syncToolbarHeights below reads the freshly-updated layoutMode instead
    // of the stale one — otherwise --toolbar-base-height stays wrong until
    // some unrelated resize/rAF happens to recompute it.
    if (toolbar.dataset.layoutMode !== deviceMode.getMode().layoutMode) {
      setupToolbar();
    }
    syncToolInfoMode();
    syncMinimapSettings(state.settings.minimap);
    syncToolbarHeights();
    // See the matching comment below: force Pixi to pick up canvas-wrapper's
    // new size, since `resizeTo`'s own auto-resize doesn't reliably do so
    // within the same tick as the CSS change that caused it.
    renderer.app.resize();
  };
  applySettings(state.settings);
  syncToolbarHeights();
  window.addEventListener('resize', syncToolbarHeights);
  requestAnimationFrame(syncToolbarHeights);
  // syncToolbarHeights() may have just changed --toolbar-base-height from
  // its CSS fallback to the real computed full-shell .toolbar-row height.
  // Pixi's `resizeTo` is known not to reliably respond to a layout-only
  // resize like this (https://github.com/pixijs/pixijs/issues/11427) — only
  // to an actual window resize event — so nudge it explicitly. (Compact mode
  // avoids ever needing this for the initial load by setting the height
  // before the renderer first initializes, above; this remains a best-effort
  // catch-all for the full shell and any other future case.)
  renderer.app.resize();

  applySettingsRef = applySettings;
  bindPersistenceControls({
    saveBtn,
    loadBtn,
    downloadBtn,
    uploadBtn,
    fileInput,
    getState: () => state,
    getEngineSnapshot: () => bridge.getSnapshot(),
    onContainerLoaded: loadCityContainer,
    onLegacyLoaded: importLegacyCity,
    getInputMode: () => deviceMode.getMode().inputMode
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

  speedSlowBtn.addEventListener('click', () => setSimSpeed('slow'));
  speedFastBtn.addEventListener('click', () => setSimSpeed('fast'));
  speedLudicrousBtn.addEventListener('click', () => setSimSpeed('ludicrous'));
  pauseBtn.addEventListener('click', () => togglePause());
  muteBtn.addEventListener('click', () => {
    state.settings.audio.sfxMuted = !state.settings.audio.sfxMuted;
    syncMuteButton();
  });
  syncMuteButton();
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
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      e.preventDefault();
      // One undo per physical keypress: with full-rewind semantics, letting
      // the key auto-repeat can silently unwind a whole session (a held
      // Ctrl+Z fires ~30 undos/second, and each one may rewind days).
      if (!e.repeat) performUndo();
      return;
    }
    // Redo: Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y.
    if (
      (e.ctrlKey || e.metaKey) &&
      ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')
    ) {
      e.preventDefault();
      if (!e.repeat) performRedo();
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
