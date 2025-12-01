import './style.css';
import { Application } from 'pixi.js';
import { createDefaultMinimapSettings, createInitialState, GameState, getTile } from './game/gameState';
import { applyTool } from './game/tools';
import { Tool } from './game/toolTypes';
import { Simulation } from './game/simulation';
import { loadFromBrowser } from './game/persistence';
import { createCamera, centerCamera, screenToTile } from './rendering/camera';
import { MapRenderer, Position } from './rendering/renderer';
import { palette, TILE_SIZE } from './rendering/sprites';
import { loadPaletteTexture } from './rendering/tileAtlas';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import { createHud } from './ui/hud';
import { bindPersistenceControls, showManualModal, showToast } from './ui/dialogs';
import { initDebugOverlay } from './ui/debugOverlay';
import { initHotkeys, defaultHotkeys, type HotkeyController } from './ui/hotkeys';
import { initToolbar, updateToolbar } from './ui/toolbar';
import { createNotificationCenter } from './ui/notifications';
import { initMinimap } from './ui/minimap';

const appRoot = document.querySelector<HTMLDivElement>('#app');

if (!appRoot) {
  throw new Error('App root missing');
}

appRoot.innerHTML = `
  <div class="topbar">
    <div class="logo">🏙️ <span>City Sim 1000</span></div>
    <div class="hud">
      <div class="panel"><h4>Budget</h4><div id="money">$0</div><div id="power">⚡ 0 MW</div><div id="water">💧 0 m³</div></div>
      <div class="panel"><h4>Demands</h4><div class="demand-rows"><div class="demand-row"><span class="demand-label">R</span><div class="demand-bar"><div id="res-bar" class="demand-fill" style="background:#7bffb7;width:30%"></div></div></div><div class="demand-row"><span class="demand-label">C</span><div class="demand-bar"><div id="com-bar" class="demand-fill" style="background:#5bc0eb;width:30%"></div></div></div><div class="demand-row"><span class="demand-label">I</span><div class="demand-bar"><div id="ind-bar" class="demand-fill" style="background:#f08c42;width:30%"></div></div></div></div></div>
      <div class="panel"><h4>City</h4><div id="population">Population 0</div><div id="jobs">Jobs 0</div><div id="day">Day 1</div></div>
      <div class="panel"><h4>Speed</h4><div class="controls-row"><button id="speed-slow" class="secondary">Slow</button><button id="speed-fast" class="secondary">Fast</button><button id="speed-ludicrous" class="secondary">Ludicrous</button></div><div class="panel-hint">Hotkeys: 1/2/3</div></div>
      <div class="panel"><h4>Saves</h4><div class="controls-row"><button id="save-btn" class="secondary">Save</button><button id="load-btn" class="secondary">Load</button></div><div class="controls-row"><button id="download-btn" class="primary">Download</button><button id="upload-btn" class="secondary">Upload</button><input type="file" id="file-input" accept="application/json" style="display:none" /></div></div>
      <div class="panel"><h4>Manual</h4><div class="controls-row"><button id="manual-btn" class="secondary">Open manual</button></div><div class="panel-hint">Opens the in-game guide in a popup.</div></div>
      <div class="panel"><h4>Debug</h4><div class="controls-row"><button id="debug-overlay-btn" class="secondary">Show overlay</button><button id="debug-copy-btn" class="secondary">Copy state</button><button id="pending-penalty-btn" class="secondary">Penalties: On</button></div><div class="panel-hint">Live stats and a clipboard snapshot.</div></div>
    </div>
  </div>
  <div id="viewport">
    <div class="toolbar" id="toolbar"></div>
    <div class="canvas-wrapper" id="canvas-wrapper"></div>
  </div>
  <footer>Offline ready • WebGL powered • Inspired by pixel skylines</footer>
`;

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) {
    throw new Error(`UI element missing: ${selector}`);
  }
  return el;
}

const toolbar = requireElement<HTMLDivElement>('#toolbar');
const wrapper = requireElement<HTMLDivElement>('#canvas-wrapper');
const moneyEl = requireElement<HTMLDivElement>('#money');
const powerEl = requireElement<HTMLDivElement>('#power');
const waterEl = requireElement<HTMLDivElement>('#water');
const resBar = requireElement<HTMLDivElement>('#res-bar');
const comBar = requireElement<HTMLDivElement>('#com-bar');
const indBar = requireElement<HTMLDivElement>('#ind-bar');
const popEl = requireElement<HTMLDivElement>('#population');
const jobsEl = requireElement<HTMLDivElement>('#jobs');
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

const app = new Application();
const camera = createCamera();
let hovered: Position | null = null;
let selected: Position | null = null;
let isPanning = false;
let isPainting = false;
let panStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };
let lastPainted: Position | null = null;
let tool: Tool = Tool.Inspect;
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
const KEYBOARD_PAN_SPEED = 700;
const simSpeeds = {
  slow: 0.5,
  fast: 1,
  ludicrous: 3
} as const;
type SimSpeedKey = keyof typeof simSpeeds;
let simSpeed: SimSpeedKey = 'fast';
const ensureSettingsShape = (settings?: GameState['settings']) => ({
  pendingPenaltyEnabled: settings?.pendingPenaltyEnabled ?? true,
  minimap: {
    ...createDefaultMinimapSettings(),
    ...(settings?.minimap ?? {})
  }
});
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

function applyCurrentTool(tilePos: Position) {
  if (!getTile(state, tilePos.x, tilePos.y)) return;
  if (tool === Tool.Inspect) {
    selected = tilePos;
    return;
  }
  const result = applyTool(state, tool, tilePos.x, tilePos.y);
  if (!result.success && result.message) {
    showToast(result.message);
  } else if (result.success) {
    minimap?.markDirty();
  }
  selected = tilePos;
}

function attachViewportEvents(canvas: HTMLCanvasElement) {
  wrapper.addEventListener('contextmenu', (e) => e.preventDefault());

  wrapper.addEventListener('pointerdown', (e) => {
    const tilePos = screenToTile(camera, TILE_SIZE, canvas, e.clientX, e.clientY);
    hovered = tilePos;
    if (e.button === 2 || e.button === 1 || e.altKey) {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      cameraStart = { ...camera };
      return;
    }
    isPainting = true;
    lastPainted = tilePos;
    applyCurrentTool(tilePos);
  });

  wrapper.addEventListener('pointermove', (e) => {
    if (isPanning) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      camera.x = cameraStart.x + dx;
      camera.y = cameraStart.y + dy;
      return;
    }
    const tilePos = screenToTile(camera, TILE_SIZE, canvas, e.clientX, e.clientY);
    hovered = tilePos;
    const primaryDown = (e.buttons & 1) !== 0;
    if (primaryDown && tool !== Tool.Inspect) {
      if (!isPainting) {
        isPainting = true;
      }
      const alreadyPainted =
        lastPainted && lastPainted.x === tilePos.x && lastPainted.y === tilePos.y;
      if (!alreadyPainted) {
        applyCurrentTool(tilePos);
        lastPainted = tilePos;
      }
    } else if (!primaryDown && isPainting) {
      stopPainting();
    }
  });

  const stopPainting = () => {
    isPanning = false;
    isPainting = false;
    lastPainted = null;
  };

  wrapper.addEventListener('pointerup', stopPainting);
  window.addEventListener('pointerup', stopPainting);
  wrapper.addEventListener('pointercancel', stopPainting);
  window.addEventListener('pointercancel', stopPainting);

  wrapper.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const prevScale = camera.scale;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
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
    camera.x -= movement.x * KEYBOARD_PAN_SPEED * deltaSeconds;
    camera.y -= movement.y * KEYBOARD_PAN_SPEED * deltaSeconds;
  }
  simulation.update(deltaSeconds);
  renderer.render(state, hovered, selected);
  hud.update(state);
  hud.renderOverlays(state, selected, tool);
  minimap?.update(state, camera);
  debugOverlay?.update(state);
  requestAnimationFrame(() => gameLoop(renderer, hud));
}

(async function bootstrap() {
  const paletteTexture = await loadPaletteTexture();
  console.log('Palette texture loaded', paletteTexture);

  const renderer = new MapRenderer(wrapper, camera, TILE_SIZE, palette);
  await renderer.init(wrapper);
  centerCamera(state, wrapper, TILE_SIZE, camera);

  const hud = createHud({
    moneyEl,
    powerEl,
    waterEl,
    resBar,
    comBar,
    indBar,
    popEl,
    jobsEl,
    dayEl,
    overlayRoot: wrapper
  });

  const minimapViewport = () => {
    const canvas = renderer.getCanvas();
    return {
      width: canvas?.clientWidth ?? wrapper.clientWidth,
      height: canvas?.clientHeight ?? wrapper.clientHeight
    };
  };

  minimap = initMinimap({
    root: wrapper,
    settings: state.settings.minimap,
    onSettingsChange: (next) => {
      state.settings.minimap = next;
    },
    onJumpToTile: ({ x, y }) => centerCameraOnTile(x, y),
    getViewportSize: minimapViewport,
    palette
  });

  const setTool = (nextTool: Tool) => {
    tool = nextTool;
    updateToolbar(toolbar, nextTool);
  };

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

  initToolbar(
    toolbar,
    (nextTool) => {
      setTool(nextTool);
    },
    tool
  );

  hotkeys = initHotkeys({
    bindings: defaultHotkeys,
    onAction: (action) => {
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
    }
  });

  bindPersistenceControls({
    saveBtn,
    loadBtn,
    downloadBtn,
    uploadBtn,
    fileInput,
    getState: () => state,
    onStateLoaded: (loaded) => {
      state = loaded;
      state.settings = ensureSettingsShape(state.settings);
      simulation.setState(state);
      centerCamera(state, wrapper, TILE_SIZE, camera);
      minimap?.syncSettings(state.settings.minimap);
      minimap?.markDirty();
      updatePendingPenaltyBtn();
    }
  });

  manualBtn.addEventListener('click', () => showManualModal());

  debugOverlay = initDebugOverlay({
    root: wrapper,
    toggleBtn: debugOverlayBtn,
    copyBtn: debugCopyBtn,
    getState: () => state
  });

  const updatePendingPenaltyBtn = () => {
    const enabled = state.settings?.pendingPenaltyEnabled ?? true;
    pendingPenaltyBtn.textContent = `Penalties: ${enabled ? 'On' : 'Off'}`;
    pendingPenaltyBtn.classList.toggle('active', enabled);
  };

  pendingPenaltyBtn.addEventListener('click', () => {
    const current = state.settings?.pendingPenaltyEnabled ?? true;
    state.settings.pendingPenaltyEnabled = !current;
    updatePendingPenaltyBtn();
    showToast(`Over-zoning penalty ${state.settings.pendingPenaltyEnabled ? 'enabled' : 'disabled'}`);
  });

  speedSlowBtn.addEventListener('click', () => setSimSpeed('slow'));
  speedFastBtn.addEventListener('click', () => setSimSpeed('fast'));
  speedLudicrousBtn.addEventListener('click', () => setSimSpeed('ludicrous'));
  setSimSpeed(simSpeed, { silent: true });
  updatePendingPenaltyBtn();

  attachViewportEvents(renderer.getCanvas());

  const cancelCurrentTool = () => {
    const wasInspect = tool === Tool.Inspect;
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
