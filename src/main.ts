import './style.css';
import { Application, Graphics } from 'pixi.js';
import {
  Tool,
  TileKind,
  GameState,
  applyTool,
  createInitialState,
  getTile,
  tick,
  serialize,
  deserialize
} from './game';
import { loadPaletteTexture } from './rendering/tileAtlas';

const LOCAL_STORAGE_KEY = 'city-sim-1000-save';
const TILE_SIZE = 28;

const palette: Record<TileKind, number> = {
  [TileKind.Land]: 0x345c3d,
  [TileKind.Water]: 0x234c7f,
  [TileKind.Tree]: 0x3c7a4b,
  [TileKind.Road]: 0x7f8894,
  [TileKind.Rail]: 0x8c6b3e,
  [TileKind.Residential]: 0xb3e675,
  [TileKind.Commercial]: 0x5bc0eb,
  [TileKind.Industrial]: 0xf08c42,
  [TileKind.PowerLine]: 0xe9d985,
  [TileKind.HydroPlant]: 0x50d1ff,
  [TileKind.WaterPump]: 0x4ac6b7,
  [TileKind.Park]: 0x2fa05a
};

const toolLabels: Record<Tool, string> = {
  [Tool.Inspect]: 'Inspect',
  [Tool.Terraform]: 'Land',
  [Tool.Water]: 'Water',
  [Tool.Tree]: 'Trees',
  [Tool.Road]: 'Road',
  [Tool.Rail]: 'Rail',
  [Tool.PowerLine]: 'Power',
  [Tool.HydroPlant]: 'Hydro',
  [Tool.WaterPump]: 'Pump',
  [Tool.Residential]: 'Res',
  [Tool.Commercial]: 'Com',
  [Tool.Industrial]: 'Ind',
  [Tool.Bulldoze]: 'Bulldoze',
  [Tool.Park]: 'Park'
};

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
    </div>
  </div>
  <div id="viewport">
    <div class="toolbar" id="toolbar"></div>
    <div class="canvas-wrapper" id="canvas-wrapper"></div>
  </div>
  <footer>Offline ready • WebGL powered • Inspired by pixel skylines</footer>
`;

const toolbar = document.querySelector<HTMLDivElement>('#toolbar');
const wrapper = document.querySelector<HTMLDivElement>('#canvas-wrapper');
const moneyEl = document.querySelector<HTMLDivElement>('#money');
const powerEl = document.querySelector<HTMLDivElement>('#power');
const waterEl = document.querySelector<HTMLDivElement>('#water');
const resBar = document.querySelector<HTMLDivElement>('#res-bar');
const comBar = document.querySelector<HTMLDivElement>('#com-bar');
const indBar = document.querySelector<HTMLDivElement>('#ind-bar');
const popEl = document.querySelector<HTMLDivElement>('#population');
const jobsEl = document.querySelector<HTMLDivElement>('#jobs');
const dayEl = document.querySelector<HTMLDivElement>('#day');
const saveBtn = document.querySelector<HTMLButtonElement>('#save-btn');
const loadBtn = document.querySelector<HTMLButtonElement>('#load-btn');
const downloadBtn = document.querySelector<HTMLButtonElement>('#download-btn');
const uploadBtn = document.querySelector<HTMLButtonElement>('#upload-btn');
const fileInput = document.querySelector<HTMLInputElement>('#file-input');

if (!toolbar || !wrapper || !moneyEl || !powerEl || !waterEl || !resBar || !comBar || !indBar || !popEl || !jobsEl || !dayEl || !saveBtn || !loadBtn || !downloadBtn || !uploadBtn || !fileInput) {
  throw new Error('UI missing');
}

let tool: Tool = Tool.Inspect;
let state: GameState = createInitialState();

let app: Application;
const mapLayer = new Graphics();
const overlayLayer = new Graphics();
let camera = { x: 0, y: 0, scale: 1 };
let hovered: { x: number; y: number } | null = null;
let selected: { x: number; y: number } | null = null;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };

function createToolbar() {
  toolbar.innerHTML = '';
  (Object.values(Tool) as Tool[]).forEach((key) => {
    const button = document.createElement('button');
    button.className = 'tool-button';
    button.textContent = toolLabels[key];
    button.dataset.tool = key;
    button.addEventListener('click', () => {
      tool = key;
      updateToolbar();
    });
    toolbar.appendChild(button);
  });
  updateToolbar();
}

function updateToolbar() {
  toolbar.querySelectorAll('.tool-button').forEach((btn) => {
    const isActive = btn.getAttribute('data-tool') === tool;
    btn.classList.toggle('active', isActive);
  });
}

async function initPixi() {
  app = new Application();
  await app.init({
    background: '#0b1424',
    resizeTo: wrapper,
    antialias: true
  });
  wrapper.appendChild(app.canvas);
  app.stage.addChild(mapLayer);
  app.stage.addChild(overlayLayer);
  centerCamera();
}

function centerCamera() {
  if (!wrapper) return;
  const size = TILE_SIZE * camera.scale;
  camera.x = wrapper.clientWidth / 2 - (state.width * size) / 2;
  camera.y = wrapper.clientHeight / 2 - (state.height * size) / 2;
}

function draw() {
  mapLayer.clear();
  const size = TILE_SIZE * camera.scale;
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      const tile = getTile(state, x, y)!;
      const color = palette[tile.kind];
      mapLayer.beginFill(color, 0.95);
      mapLayer.drawRect(camera.x + x * size, camera.y + y * size, size - 1, size - 1);
      mapLayer.endFill();
    }
  }
  overlayLayer.clear();
  if (hovered) {
    overlayLayer.lineStyle({ width: 2, color: 0xffffff });
    overlayLayer.drawRect(camera.x + hovered.x * size, camera.y + hovered.y * size, size, size);
  }
  if (selected) {
    overlayLayer.lineStyle({ width: 2, color: 0x7bffb7 });
    overlayLayer.drawRect(camera.x + selected.x * size, camera.y + selected.y * size, size, size);
  }
}

function screenToTile(clientX: number, clientY: number) {
  const rect = app.canvas.getBoundingClientRect();
  const x = (clientX - rect.left - camera.x) / (TILE_SIZE * camera.scale);
  const y = (clientY - rect.top - camera.y) / (TILE_SIZE * camera.scale);
  return { x: Math.floor(x), y: Math.floor(y) };
}

function updateHUD() {
  moneyEl.textContent = `$${Math.floor(state.money).toLocaleString()}`;
  powerEl.textContent = `⚡ ${state.power.toFixed(1)} MW`;
  waterEl.textContent = `💧 ${state.water.toFixed(1)} m³`;
  resBar.style.width = `${state.demand.residential}%`;
  comBar.style.width = `${state.demand.commercial}%`;
  indBar.style.width = `${state.demand.industrial}%`;
  popEl.textContent = `Population ${Math.floor(state.population)}`;
  jobsEl.textContent = `Jobs ${Math.floor(state.jobs)}`;
  dayEl.textContent = `Day ${Math.floor(state.day)}`;
}

function applyCurrentTool(tilePos: { x: number; y: number }) {
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

function showToast(message: string) {
  const div = document.createElement('div');
  div.textContent = message;
  div.style.position = 'absolute';
  div.style.right = '12px';
  div.style.top = '12px';
  div.style.padding = '10px 12px';
  div.style.background = '#1f2c4b';
  div.style.border = '1px solid #7bffb7';
  div.style.borderRadius = '10px';
  div.style.color = '#e8f1ff';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1400);
}

function saveToLocal() {
  localStorage.setItem(LOCAL_STORAGE_KEY, serialize(state));
  showToast('Saved to browser');
}

function loadFromLocal() {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!data) {
    showToast('No save found');
    return;
  }
  state = deserialize(data);
  centerCamera();
  showToast('Loaded from browser');
}

function downloadSave() {
  const blob = new Blob([serialize(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'city-sim-save.json';
  a.click();
  URL.revokeObjectURL(url);
}

function uploadSave(file: File) {
  file.text().then((txt) => {
    state = deserialize(txt);
    centerCamera();
    showToast('Save loaded');
  });
}

function attachEvents() {
  wrapper.addEventListener('contextmenu', (e) => e.preventDefault());
  wrapper.addEventListener('pointerdown', (e) => {
    if (!app) return;
    const tilePos = screenToTile(e.clientX, e.clientY);
    hovered = tilePos;
    if (e.button === 2 || e.button === 1 || e.altKey) {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      cameraStart = { ...camera };
      return;
    }
    applyCurrentTool(tilePos);
  });

  wrapper.addEventListener('pointermove', (e) => {
    if (!app) return;
    if (isPanning) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      camera.x = cameraStart.x + dx;
      camera.y = cameraStart.y + dy;
      return;
    }
    hovered = screenToTile(e.clientX, e.clientY);
  });

  wrapper.addEventListener('pointerup', () => {
    isPanning = false;
  });

  wrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    const prevScale = camera.scale;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    camera.scale = Math.min(3, Math.max(0.5, camera.scale * factor));
    const rect = app.canvas.getBoundingClientRect();
    const focusX = (e.clientX - rect.left);
    const focusY = (e.clientY - rect.top);
    camera.x = focusX - ((focusX - camera.x) / prevScale) * camera.scale;
    camera.y = focusY - ((focusY - camera.y) / prevScale) * camera.scale;
  }, { passive: false });

  saveBtn.addEventListener('click', saveToLocal);
  loadBtn.addEventListener('click', loadFromLocal);
  downloadBtn.addEventListener('click', downloadSave);
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) uploadSave(file);
  });
}

function renderSelectionInfo() {
  if (!selected || !wrapper) return;
  const tile = getTile(state, selected.x, selected.y);
  if (!tile) return;
  let existing = wrapper.querySelector('.overlay');
  if (!existing) {
    existing = document.createElement('div');
    existing.className = 'overlay';
    wrapper.appendChild(existing);
  }
  existing.innerHTML = `
    <div class="info-box">
      <div class="status-line"><span>Tile</span><strong>${selected.x},${selected.y}</strong></div>
      <div class="status-line"><span>Type</span><strong>${tile.kind}</strong></div>
      <div class="status-line"><span>Happy</span><strong>${tile.happiness.toFixed(2)}</strong></div>
      <div class="map-stats">Utilities are modeled globally; keep power and water above zero to grow.</div>
    </div>
  `;
}

function loadExistingSave() {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (data) {
    state = deserialize(data);
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // ignore
    });
  }
}

function gameLoop(now: number) {
  const dt = 1 / 60;
  tick(state, dt);
  draw();
  updateHUD();
  renderSelectionInfo();
  requestAnimationFrame(gameLoop);
}

(async function bootstrap() {
  loadExistingSave();
  const paletteTexture = await loadPaletteTexture();
  console.log('Palette texture loaded', paletteTexture);
  createToolbar();
  attachEvents();
  await initPixi();
  updateHUD();
  registerServiceWorker();
  requestAnimationFrame(gameLoop);
})();
