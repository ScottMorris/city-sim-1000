// mcpBridge.ts — browser-side WebSocket client for the City Sim MCP server.
//
// Activated only when `?mcp` appears in the URL.  The MCP server
// (scripts/city-sim-mcp/index.ts) runs a WS server on port 5174; this module
// connects to it and handles game commands on its behalf.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { SimBridge } from './simBridge';
import type { GameState, ViewStratum } from './gameState';
import { createInitialState } from './gameState';
import { Tool } from './toolTypes';
import { getCalendarPosition } from './time';
import { nextStrokeId } from './protocol/commands';
import { dominantOccupantLabel } from './protocol/tileLabel';

// Bresenham's line — returns all integer (x,y) pairs from (x0,y0) to (x1,y1).
function bresenhamLine(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const pts: [number, number][] = [];
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
  }
  return pts;
}

const MCP_WS_PORT = 5174;

// The MCP bridge has no view state of its own — scripted commands default to
// the surface, with an explicit `stratum: 'underground'` param letting a
// script lay pipe or bulldoze underground without a client view to read.
// Exported (only) so it's unit-testable — everything else here needs a live
// WebSocket connection to exercise.
export function stratumParam(params: Record<string, unknown>): ViewStratum {
  return params.stratum === 'underground' ? 'underground' : 'surface';
}

// Use setTimeout rather than rAF — background/unfocused Chromium tabs throttle
// rAF to 1 fps, which would stall every MCP command for seconds and freeze the HUD.
function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function initMcpBridge(bridge: SimBridge, state: GameState): void {
  if (!new URLSearchParams(location.search).has('mcp')) return;

  console.info('[MCP] MCP mode active — connecting to ws://localhost:5174');

  let ws: WebSocket | null = null;
  let currentSpeed = 1;
  const replyOverrides = new Map<string, (result: unknown, error?: string) => void>();

  function connect(): void {
    const sock = new WebSocket(`ws://localhost:${MCP_WS_PORT}`);
    ws = sock;
    sock.addEventListener('open', () => {
      console.info('[MCP] Connected to MCP server');
    });
    sock.addEventListener('close', () => {
      console.info('[MCP] Disconnected — retrying in 2 s');
      ws = null;
      setTimeout(connect, 2000);
    });
    sock.addEventListener('message', evt => {
      void handleCommand(JSON.parse(evt.data as string));
    });
  }

  function reply(id: string, result: unknown, error?: string): void {
    const override = replyOverrides.get(id);
    if (override) { replyOverrides.delete(id); override(result, error); return; }
    ws?.send(JSON.stringify(error != null ? { id, error } : { id, result }));
  }

  function simState() {
    const s = bridge.getState();
    const { month, dayOfMonth } = getCalendarPosition(s.day);
    return {
      tick: s.tick,
      day: s.day,
      month,
      dayOfMonth,
      money: s.money,
      population: s.population,
      jobs: s.jobs,
      power: s.utilities.power,
      water: s.utilities.water,
      demand: {
        residential: s.demand.residential,
        commercial: s.demand.commercial,
        industrial: s.demand.industrial,
      },
      width: s.width,
      height: s.height,
    };
  }

  function tileAt(x: number, y: number) {
    const s = bridge.getState();
    const t = s.tiles[y * s.width + x];
    if (!t) return null;
    return {
      kind: dominantOccupantLabel(s, t),
      powered: t.powered,
      watered: t.watered,
      abandoned: t.abandoned ?? false,
      happiness: t.happiness,
      elevation: t.elevation,
      buildingId: t.buildingId ?? null,
    };
  }

  async function handleCommand(msg: { id: string; method: string; params?: Record<string, unknown> }): Promise<void> {
    const { id, method, params = {} } = msg;
    try {
      switch (method) {
        case 'get_state':
          reply(id, simState());
          break;

        case 'get_tile': {
          const t = tileAt(params.x as number, params.y as number);
          if (t === null) reply(id, null, `Tile (${params.x as number},${params.y as number}) out of bounds`);
          else reply(id, t);
          break;
        }

        case 'get_tiles_where': {
          const s = bridge.getState();
          const kind = params.kind as string;
          const hits = s.tiles.flatMap((t, i) =>
            dominantOccupantLabel(s, t) === kind
              ? [{ x: i % s.width, y: Math.floor(i / s.width) }]
              : [],
          );
          reply(id, hits);
          break;
        }

        case 'apply_tool': {
          const tool = params.tool as Tool;
          const x = params.x as number;
          const y = params.y as number;
          const moneyBefore = bridge.getState().money;
          bridge.send({ type: 'ApplyTool', tool, x, y, strokeId: nextStrokeId(), stratum: stratumParam(params) });
          await waitMs(150);
          reply(id, {
            moneyBefore,
            moneyAfter: bridge.getState().money,
            tile: tileAt(x, y),
            state: simState(),
          });
          break;
        }

        case 'set_speed': {
          const mult = params.multiplier as number;
          currentSpeed = mult;
          bridge.setSpeed(mult);
          reply(id, { ok: true, multiplier: mult });
          break;
        }

        case 'step_ticks': {
          const count = (params.count as number | undefined) ?? 1;
          const targetTick = bridge.getState().tick + count;
          const savedSpeed = currentSpeed;
          // Run at 3× so tick advances don't take real time
          bridge.setSpeed(3);
          await new Promise<void>(resolve => {
            const check = () => {
              if (bridge.getState().tick >= targetTick) resolve();
              else setTimeout(check, 50);
            };
            setTimeout(check, 50);
          });
          bridge.setSpeed(savedSpeed);
          reply(id, simState());
          break;
        }

        case 'undo': {
          const happened = await bridge.undo();
          await waitMs(150);
          reply(id, { happened, state: simState() });
          break;
        }

        case 'apply_tool_line': {
          const tool = params.tool as Tool;
          const pts = bresenhamLine(
            params.x1 as number, params.y1 as number,
            params.x2 as number, params.y2 as number,
          );
          const moneyBefore = bridge.getState().money;
          const lineStroke = nextStrokeId();
          const stratum = stratumParam(params);
          for (const [px, py] of pts) {
            bridge.send({ type: 'ApplyTool', tool, x: px, y: py, strokeId: lineStroke, stratum });
          }
          await waitMs(150);
          reply(id, { placed: pts.length, moneyBefore, moneyAfter: bridge.getState().money, state: simState() });
          break;
        }

        case 'apply_tool_rect': {
          const tool = params.tool as Tool;
          const ax = Math.min(params.x1 as number, params.x2 as number);
          const ay = Math.min(params.y1 as number, params.y2 as number);
          const bx = Math.max(params.x1 as number, params.x2 as number);
          const by = Math.max(params.y1 as number, params.y2 as number);
          const moneyBefore = bridge.getState().money;
          const rectStroke = nextStrokeId();
          const stratum = stratumParam(params);
          let placed = 0;
          for (let ry = ay; ry <= by; ry++) {
            for (let rx = ax; rx <= bx; rx++) {
              bridge.send({ type: 'ApplyTool', tool, x: rx, y: ry, strokeId: rectStroke, stratum });
              placed++;
            }
          }
          await waitMs(150);
          reply(id, { placed, moneyBefore, moneyAfter: bridge.getState().money, state: simState() });
          break;
        }

        case 'get_buildings': {
          const s = bridge.getState();
          const list = s.buildings.map(b => ({
            id: b.id,
            templateId: b.templateId,
            x: b.origin.x,
            y: b.origin.y,
            status: b.state.status as string,
            health: b.state.health,
            abandoned: b.state.abandoned,
          }));
          reply(id, list);
          break;
        }

        case 'get_adjacents': {
          const x = params.x as number, y = params.y as number;
          reply(id, {
            north: tileAt(x,     y - 1),
            east:  tileAt(x + 1, y    ),
            south: tileAt(x,     y + 1),
            west:  tileAt(x - 1, y    ),
          });
          break;
        }

        case 'screenshot': {
          // Capture the main game canvas (exclude minimap canvases).
          const canvas = document.querySelector(
            'canvas:not(.minimap-canvas):not(.minimap-overlay-canvas)',
          ) as HTMLCanvasElement | null;
          if (!canvas) { reply(id, null, 'Game canvas not found'); break; }
          const dataUrl = canvas.toDataURL('image/png');
          reply(id, {
            mimeType: 'image/png',
            data: dataUrl.slice('data:image/png;base64,'.length),
          });
          break;
        }

        case 'reset': {
          const seed = (params.seed as number | undefined) ?? (Math.random() * 0xffff_ffff | 0);
          await bridge.newCity(createInitialState(state.width, state.height, seed));
          await waitMs(150);
          reply(id, { seed, state: simState() });
          break;
        }

        default:
          reply(id, null, `Unknown method: ${method}`);
      }
    } catch (err) {
      reply(id, null, String(err));
    }
  }

  connect();

  // Lets Playwright (or any script) drive the bridge directly without a real
  // MCP server — gated the same way the rest of this module is, by the
  // explicit `?mcp` opt-in above, so it ships in production builds too (the
  // mobile e2e suite runs against a built `vite preview`, not the dev server).
  (window as unknown as Record<string, unknown>).__mcpTest = (
    method: string,
    params?: Record<string, unknown>,
  ) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      replyOverrides.set(id, (result, error) => {
        if (error) reject(new Error(error));
        else resolve(result);
      });
      void handleCommand({ id, method, params: params ?? {} });
    });
}
