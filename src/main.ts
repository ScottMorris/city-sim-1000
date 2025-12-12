import './style.css';
import { Application } from 'pixi.js';
import {
  createDefaultAccessibilitySettings,
  createDefaultAudioSettings,
  createDefaultCosmeticSettings,
  createDefaultInputSettings,
  createDefaultMinimapSettings,
  createInitialState,
  GameState,
  getTile
} from './game/gameState';
import { applyTool } from './game/tools';
import { Tool } from './game/toolTypes';
import { Simulation } from './game/simulation';
import { loadFromBrowser } from './game/persistence';
import { createCamera, centerCamera, screenToTile } from './rendering/camera';
import { MapRenderer, Position } from './rendering/renderer';
import { palette, TILE_SIZE } from './rendering/sprites';
import { loadPaletteTexture, loadTileTextures } from './rendering/tileAtlas';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { createHud } from './ui/hud';
import { bindPersistenceControls, showManualModal, showToast } from './ui/dialogs';
import { initDebugOverlay } from './ui/debugOverlay';
import { initHotkeys, defaultHotkeys, type HotkeyAction, type HotkeyController } from './ui/hotkeys';
import { initToolbar, updateToolbar } from './ui/toolbar';
import { createNotificationCenter } from './ui/notifications';
import { initMinimap } from './ui/minimap';
import { initBudgetModal } from './ui/budgetModal';
import { initSettingsModal } from './ui/settingsModal';
import type { RadioWidget } from './ui/radio';

const appRoot = document.querySelector<HTMLDivElement>('#app');

if (!appRoot) {
  throw new Error('App root missing');
}

appRoot.innerHTML = `
  <div class="topbar">
    <div class="logo">🏙️ <span>City Sim 1000</span></div>
    <div class="hud">
      <div class="panel"><h4>Budget</h4><div id="money">$0</div><div id="budget-net" class="budget-net">+$0 / month</div><div id="power">⚡ 0 MW</div><div id="water">💧 0 m³</div></div>
      <div class="panel"><h4>Demands</h4><div class="demand-rows"><div class="demand-row"><span class="demand-label">R</span><div class="demand-bar"><div id="res-bar" class="demand-fill" style="background:#7bffb7;width:30%"></div></div></div><div class="demand-row"><span class="demand-label">C</span><div class="demand-bar"><div id="com-bar" class="demand-fill" style="background:#5bc0eb;width:30%"></div></div></div><div class="demand-row"><span class="demand-label">I</span><div class="demand-bar"><div id="ind-bar" class="demand-fill" style="background:#f08c42;width:30%"></div></div></div></div></div>
      <div class="panel"><h4>City</h4><div id="month">Month 1</div><div id="day">Day 1 of 30</div><div id="population">Population 0</div><div id="jobs">Jobs 0</div></div>
      <div class="panel"><h4>Speed</h4><div class="controls-row"><button id="speed-slow" class="secondary">Slow</button><button id="speed-fast" class="secondary">Fast</button><button id="speed-ludicrous" class="secondary">Ludicrous</button></div><div class="panel-hint">Hotkeys: 1/2/3</div></div>
      <div class="panel"><h4>Saves</h4><div class="controls-row"><button id="save-btn" class="secondary">Save</button><button id="load-btn" class="secondary">Load</button></div><div class="controls-row"><button id="download-btn" class="primary">Download</button><button id="upload-btn" class="secondary">Upload</button><input type="file" id="file-input" accept="application/json" style="display:none" /></div></div>
      <div class="panel"><h4>Manual</h4><div class="controls-row"><button id="manual-btn" class="secondary">Open manual</button></div><div class="panel-hint">Opens the in-game guide in a popup.</div></div>
      <div class="panel panel-right"><h4>Debug</h4><div class="controls-row"><button id="debug-overlay-btn" class="secondary">Show overlay</button><button id="debug-copy-btn" class="secondary">Copy state</button><button id="pending-penalty-btn" class="secondary">Penalties: On</button></div><div class="panel-hint">Live stats and a clipboard snapshot.</div></div>
    </div>
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
  if (!['base', 'power', 'water', 'alerts', 'education'].includes(minimapSettings.mode)) {
    minimapSettings.mode = 'base';
  }
  const inputDefaults = createDefaultInputSettings();
  const accessibilityDefaults = createDefaultAccessibilitySettings();
  const audioDefaults = createDefaultAudioSettings();
  const cosmeticDefaults = createDefaultCosmeticSettings();
  return {
    pendingPenaltyEnabled: settings?.pendingPenaltyEnabled ?? true,
    minimap: minimapSettings,
    input: { ...inputDefaults, ...(settings?.input ?? {}) },
    accessibility: { ...accessibilityDefaults, ...(settings?.accessibility ?? {}) },
    audio: { ...audioDefaults, ...(settings?.audio ?? {}) },
    hotkeys: { ...defaultHotkeys, ...(settings?.hotkeys ?? {}) },
    cosmetics: { ...cosmeticDefaults, ...(settings?.cosmetics ?? {}) }
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
let activeTool: Tool = Tool.Inspect;
let selectedTool: Tool = Tool.Inspect;
let temporaryTool: Tool | null = null;
let state: GameState = loadFromBrowser() ?? createInitialState();
state.settings = ensureSettingsShape(state.settings);
const notifications = createNotificationCenter();
const simulation = new Simulation(state, {
  ticksPerSecond: 20,
  notify: notifications.publish
});
let debugOverlay: ReturnType<typeof initDebugOverlay> | null = null;
let hotkeys: HotkeyController | null = null;
let minimap: ReturnType<typeof initMinimap> | null = null;
let radioController: RadioWidget | null = null;
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
const simSpeeds = {
  slow: 0.5,
  fast: 1,
  ludicrous: 3
} as const;
type SimSpeedKey = keyof typeof simSpeeds;
let simSpeed: SimSpeedKey = 'fast';
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
  const result = applyTool(state, activeTool, tilePos.x, tilePos.y);
  if (!result.success && result.message) {
    showToast(result.message);
  } else if (result.success) {
    minimap?.markDirty();
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

  wrapper.addEventListener('contextmenu', (e) => e.preventDefault());

  wrapper.addEventListener('pointerdown', (e) => {
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
    pointerActive = e.buttons !== 0;
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
    const primaryDown = (e.buttons & 1) !== 0;
    const secondaryDown = (e.buttons & 2) !== 0;
    const isPaintingWithSecondary = secondaryDown && activeTool === Tool.Bulldoze;
    const shouldPaint = hovered && activeTool !== Tool.Inspect && (primaryDown || isPaintingWithSecondary);
    if (shouldPaint) {
      if (!isPainting) {
        isPainting = true;
      }
      const alreadyPainted =
        lastPainted && lastPainted.x === hovered.x && lastPainted.y === hovered.y;
      if (!alreadyPainted) {
        applyCurrentTool(hovered);
        lastPainted = hovered;
      }
    } else if (!primaryDown && !secondaryDown && isPainting) {
      stopPainting();
    }
  });

  const stopPainting = () => {
    isPanning = false;
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
      const prevScale = camera.scale;
      const zoomStep = ZOOM_STEPS[inputSettings.zoomSensitivity] ?? ZOOM_STEPS.normal;
      const factor = e.deltaY > 0 ? 1 - zoomStep : 1 + zoomStep;
      camera.scale = Math.min(3, Math.max(0.5, camera.scale * factor));
      const rect = canvas.getBoundingClientRect();
      const focusX = e.clientX - rect.left;
      const focusY = e.clientY - rect.top;
      camera.x = focusX - ((focusX - camera.x) / prevScale) * camera.scale;
      camera.y = focusY - ((focusY - camera.y) / prevScale) * camera.scale;
    },
    { passive: false }
  );
}

let lastFrame = performance.now();
function gameLoop(renderer: MapRenderer, hud: ReturnType<typeof createHud>) {
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
  simulation.update(deltaSeconds);
  const overlayMode = state.settings?.minimap?.mode ?? 'base';
  renderer.render(state, hovered, selected, overlayMode, pointerActive, activeTool);
  hud.update(state);
  hud.renderOverlays(state, selected, activeTool);
  minimap?.update(state, camera);
  debugOverlay?.update(state);
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
  const budgetModal = initBudgetModal({
    getState: () => state
  });

  const minimapViewport = () => {
    const canvas = renderer.getCanvas();
    return {
      width: canvas?.clientWidth ?? wrapper.clientWidth,
      height: canvas?.clientHeight ?? wrapper.clientHeight
    };
  };

  const setTool = (nextTool: Tool) => selectTool(nextTool);

  const setSimSpeed = (speed: SimSpeedKey, opts: { silent?: boolean } = {}) => {
    simSpeed = speed;
    simulation.setSpeed(simSpeeds[speed]);
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
    onStateLoaded: (loaded) => {
      state = loaded;
      applySettings(state.settings);
      simulation.setState(state);
      centerCamera(state, wrapper, TILE_SIZE, camera);
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
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelCurrentTool();
    }
  });

  hud.update(state);
  registerServiceWorker();
  requestAnimationFrame(() => gameLoop(renderer, hud));
})();
