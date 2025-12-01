import './style.css';
import { Application } from 'pixi.js';
import { createInitialState, GameState, getTile } from './game/gameState';
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
import { initToolbar } from './ui/toolbar';

const appRoot = document.querySelector<HTMLDivElement>('#app');

if (!appRoot) {
  throw new Error('App root missing');
}

appRoot.innerHTML = `
  <div class="topbar">
    <div class="logo">🏙️ <span>City Sim 1000</span></div>
    <div class="hud">
      <div class="panel"><h4>Budget</h4><div id="money">$0</div><div id="power">⚡ 0 MW</div><div id="water">💧 0 m³</div></div>
      <div class="panel"><h4>Demands</h4><div class="demand-labels"><span>R</span><span>C</span><span>I</span></div><div class="demand-bar"><div id="res-bar" class="demand-fill" style="background:#7bffb7;width:30%"></div></div><div class="demand-bar"><div id="com-bar" class="demand-fill" style="background:#5bc0eb;width:30%"></div></div><div class="demand-bar"><div id="ind-bar" class="demand-fill" style="background:#f08c42;width:30%"></div></div></div>
      <div class="panel"><h4>City</h4><div id="population">Population 0</div><div id="jobs">Jobs 0</div><div id="day">Day 1</div></div>
      <div class="panel"><h4>Saves</h4><div class="controls-row"><button id="save-btn" class="secondary">Save</button><button id="load-btn" class="secondary">Load</button></div><div class="controls-row"><button id="download-btn" class="primary">Download</button><button id="upload-btn" class="secondary">Upload</button><input type="file" id="file-input" accept="application/json" style="display:none" /></div></div>
      <div class="panel"><h4>Manual</h4><div class="controls-row"><button id="manual-btn" class="secondary">Open manual</button></div><div class="panel-hint">Opens the in-game guide in a popup.</div></div>
      <div class="panel"><h4>Debug</h4><div class="controls-row"><button id="debug-overlay-btn" class="secondary">Show overlay</button><button id="debug-copy-btn" class="secondary">Copy state</button></div><div class="panel-hint">Live stats and a clipboard snapshot.</div></div>
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
const saveBtn = requireElement<HTMLButtonElement>('#save-btn');
const loadBtn = requireElement<HTMLButtonElement>('#load-btn');
const downloadBtn = requireElement<HTMLButtonElement>('#download-btn');
const uploadBtn = requireElement<HTMLButtonElement>('#upload-btn');
const fileInput = requireElement<HTMLInputElement>('#file-input');
const manualBtn = requireElement<HTMLButtonElement>('#manual-btn');
const debugOverlayBtn = requireElement<HTMLButtonElement>('#debug-overlay-btn');
const debugCopyBtn = requireElement<HTMLButtonElement>('#debug-copy-btn');

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
const simulation = new Simulation(state, { ticksPerSecond: 20 });
let debugOverlay: ReturnType<typeof initDebugOverlay> | null = null;

function applyCurrentTool(tilePos: Position) {
  if (!getTile(state, tilePos.x, tilePos.y)) return;
  if (tool === Tool.Inspect) {
    selected = tilePos;
    return;
  }
  const result = applyTool(state, tool, tilePos.x, tilePos.y);
  if (!result.success && result.message) {
    showToast(result.message);
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
  simulation.update(deltaSeconds);
  renderer.render(state, hovered, selected);
  hud.update(state);
  hud.renderSelectionInfo(state, selected);
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

  initToolbar(
    toolbar,
    (nextTool) => {
      tool = nextTool;
    },
    tool
  );

  bindPersistenceControls({
    saveBtn,
    loadBtn,
    downloadBtn,
    uploadBtn,
    fileInput,
    getState: () => state,
    onStateLoaded: (loaded) => {
      state = loaded;
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

  attachViewportEvents(renderer.getCanvas());

  hud.update(state);
  registerServiceWorker();
  requestAnimationFrame(() => gameLoop(renderer, hud));
})();
