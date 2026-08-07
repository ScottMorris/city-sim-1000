// mcpBridge.ts — browser-side WebSocket client for the City Sim MCP server.
//
// Activated only when `?mcp` appears in the URL.  The MCP server
// (scripts/city-sim-mcp/index.ts) runs a WS server on port 5174; this module
// connects to it and handles game commands on its behalf.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { SimBridge } from './simBridge';
import type { GameState, Tile, ViewStratum } from './gameState';
import { createInitialState, getTile } from './gameState';
import { Terrain } from './protocol/occupants';
import { Tool } from './toolTypes';
import { getCalendarPosition } from './time';
import { nextStrokeId } from './protocol/commands';
import type { FromSim } from './protocol/events';
import { occupantsByStratum, type OccupantLabel } from './protocol/tileLabel';
import { requiredStratumForTool } from './viewStratum';
import type { BuildingInstance, BuildingStatus } from './buildings/state';

/** The wire spelling of `Terrain` at the MCP JSON boundary — the only two
 *  strings a script ever sees for it, via `terrainLabel` below. Internal
 *  code reads/compares `Terrain` itself; this type (and the strings it
 *  names) exist only where the terrain crosses into JSON. */
export type TerrainLabel = 'land' | 'water';

/** `Terrain` → its MCP wire spelling. The one place `Terrain` is converted
 *  to a string for `get_tile`/`get_adjacents`/`apply_tool` responses and
 *  `get_tiles_where`'s `kind` matching. */
export function terrainLabel(t: Terrain): TerrainLabel {
  return t === Terrain.Water ? 'water' : 'land';
}

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
// `tool`'s own required stratum (`requiredStratumForTool`, generalizing what
// used to be a `Tool.WaterPipe`-only default), falling back to the surface
// for an "Any" tool. An explicit `stratum` param lets a script override
// either. The engine refuses a mismatched stratum outright for any tool that
// has one (`commands::required_stratum`), same as the real UI auto-switches
// the view the moment the tool is selected (`SPEC.md`'s Water Pipe entry).
// Exported (only) so it's unit-testable — everything else here needs a live
// WebSocket connection to exercise.
export function stratumParam(params: Record<string, unknown>): ViewStratum {
  if (params.stratum === 'underground' || params.stratum === 'surface') {
    return params.stratum;
  }
  return requiredStratumForTool(params.tool as Tool) ?? 'surface';
}

/** The bits of `CommandResult` a caller needs — kept separate from `FromSim`
 * so this file stays testable without importing the full protocol union. */
export interface CommandResultLike {
  success: boolean;
  /** `null` (not absent) when the engine sent no message — matches the wire
   *  shape of the generated `CommandResult` exactly. */
  message: string | null;
}

/**
 * Correlates `ApplyTool` sends to the `CommandResult`s the bridges report
 * back for them, keyed by `strokeId` (both bridges now stamp one onto every
 * `CommandResult` — see `protocol/events.ts`'s `FromSim` doc comment).
 *
 * Used to be a blind FIFO queue matching sends to results in arrival order —
 * reliable only "as long as MCP mode is the only source of `ApplyTool`
 * commands and results arrive in send order". Neither held: a human clicking
 * the same tab interleaves their own `ApplyTool` sends with MCP's, and
 * Tauri's IPC gives no ordering guarantee across concurrent `invoke()` calls
 * — either could shift an unrelated result into the wrong pending slot.
 * Keying by id removes both assumptions. Exported (only) so it's
 * unit-testable — see `stratumParam`'s doc comment.
 */
export function createCommandResultQueue() {
  // One FIFO of resolvers *per stroke id* — a line/rect stroke sends many
  // `ApplyTool`s under a single id, so a flat `Map<strokeId, resolver>`
  // would overwrite all but the last send in the batch. Within one stroke
  // the engine answers in send order (the worker is single-threaded and the
  // Tauri plugin serialises on its state mutex), so per-stroke FIFO is
  // exact; across strokes the id does the matching, which is what fixes
  // the misattribution the old blind global FIFO allowed.
  const pending = new Map<number, Array<(result: CommandResultLike) => void>>();
  return {
    /**
     * Call once per `ApplyTool` send, with the exact `strokeId` it was sent
     * with. `cancel` drops the entry without resolving it — callers that
     * give up waiting (a timeout) must call it, or a later result for the
     * same stroke would resolve the abandoned slot instead of its own.
     */
    expectNext(strokeId: number): { promise: Promise<CommandResultLike>; cancel: () => void } {
      let resolve!: (result: CommandResultLike) => void;
      const promise = new Promise<CommandResultLike>(res => { resolve = res; });
      const queue = pending.get(strokeId) ?? [];
      queue.push(resolve);
      pending.set(strokeId, queue);
      return { promise, cancel: () => {
        const q = pending.get(strokeId);
        if (!q) return;
        const i = q.indexOf(resolve);
        if (i !== -1) q.splice(i, 1);
        if (q.length === 0) pending.delete(strokeId);
      } };
    },
    /**
     * Call once per `CommandResult` message received. A no-op for an id with
     * nothing pending — already resolved, cancelled, or never ours.
     */
    resolveNext(result: CommandResultLike & { strokeId: number }): void {
      const queue = pending.get(result.strokeId);
      const resolve = queue?.shift();
      if (!queue || !resolve) return;
      if (queue.length === 0) pending.delete(result.strokeId);
      resolve(result);
    },
  };
}

/** Reduces a batch of `ApplyTool` results (`apply_tool_line`/`_rect`) down
 * to a placed/attempted count plus one representative failure message —
 * enough to tell a script "some of this didn't land" without a result per
 * tile. Exported (only) so it's unit-testable — see `stratumParam`'s doc
 * comment. */
export function summariseApplyResults(results: CommandResultLike[]) {
  const failures = results.filter(r => !r.success);
  return {
    placed: results.length - failures.length,
    attempted: results.length,
    firstFailureMessage: failures[0]?.message ?? null,
  };
}

/**
 * `get_tiles_where`'s matcher. `kind: "land"`/`"water"` matches the tile's
 * *terrain* — a road built on land still matches `"land"`, since terrain and
 * occupants are independent axes (see `get_tile`'s `terrain` field). Every
 * other `kind` matches `occupantsByStratum`'s full per-layer breakdown in ANY
 * stratum — a road hidden under a power line still matches `kind: "road"`,
 * unlike the old single-label `dominantOccupantLabel` this replaced. Exported
 * (only) so it's unit-testable — see `stratumParam`'s doc comment.
 */
export function tileMatchesKind(state: GameState, tile: Tile, kind: string): boolean {
  if (kind === 'land' || kind === 'water') {
    return terrainLabel(tile.terrain) === (kind as TerrainLabel);
  }
  // `kind` is caller-supplied (an MCP script's untyped filter string), so
  // the comparison against the typed `OccupantLabel[]` breakdown below is
  // deliberately a plain string membership check, not a cast into the type.
  const occupants = occupantsByStratum(state, tile);
  const inAnyStratum = (labels: readonly OccupantLabel[]): boolean => (labels as readonly string[]).includes(kind);
  return inAnyStratum(occupants.underground) || inAnyStratum(occupants.surface) || inAnyStratum(occupants.overhead);
}

/** `get_buildings`' response shape for one building. */
export interface McpBuildingSummary {
  id: number;
  templateId: string;
  x: number;
  y: number;
  status: BuildingStatus;
  abandoned: boolean;
}

/**
 * Serializes one building for the MCP `get_buildings` response: id, template
 * kind string, origin, the engine's own status label, and `abandoned` —
 * joined in from the building's *origin tile*, not the building mirror
 * itself. `abandoned` is a wire-populated tile flag, not part of the
 * building state (`BuildingState.abandoned` was deleted as dead, never-wire-
 * populated state), so it has to be read off `state.tiles` at display time
 * rather than off `b.state` directly. Exported (only) so it's unit-testable
 * — see `stratumParam`'s doc comment.
 */
export function summariseBuildingForMcp(state: GameState, b: BuildingInstance): McpBuildingSummary {
  return {
    id: b.id,
    templateId: b.templateId,
    x: b.origin.x,
    y: b.origin.y,
    status: b.state.status,
    abandoned: getTile(state, b.origin.x, b.origin.y)?.abandoned ?? false,
  };
}

// Use setTimeout rather than rAF — background/unfocused Chromium tabs throttle
// rAF to 1 fps, which would stall every MCP command for seconds and freeze the HUD.
function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function initMcpBridge(
  bridge: SimBridge,
  state: GameState,
  tapSimMessages: (tap: (msg: FromSim) => void) => void,
): void {
  if (!new URLSearchParams(location.search).has('mcp')) return;

  console.info('[MCP] MCP mode active — connecting to ws://localhost:5174');

  let ws: WebSocket | null = null;
  let currentSpeed = 1;
  const replyOverrides = new Map<string, (result: unknown, error?: string) => void>();
  const commandResults = createCommandResultQueue();
  tapSimMessages(msg => {
    if (msg.type === 'CommandResult') {
      commandResults.resolveNext({ success: msg.success, message: msg.message ?? null, strokeId: msg.strokeId });
    }
  });

  // Fire an ApplyTool command and resolve once its CommandResult arrives —
  // or after 2s with an assumed success, so a dropped/never-sent result
  // (e.g. a bridge implementation that doesn't emit CommandResult) can't
  // hang an MCP call forever.
  function sendApplyTool(
    tool: Tool, x: number, y: number, strokeId: number, stratum: ViewStratum,
  ): Promise<CommandResultLike> {
    const { promise, cancel } = commandResults.expectNext(strokeId);
    bridge.send({ type: 'ApplyTool', tool, x, y, strokeId, stratum });
    return Promise.race([
      promise,
      new Promise<CommandResultLike>(resolve => setTimeout(() => { cancel(); resolve({ success: true, message: null }); }, 2000)),
    ]);
  }

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
      // `terrain` and `occupants` are independent axes: the ground itself
      // (land/water) versus what's built on/over it. A tile can carry a road
      // on the surface *and* a power line overhead *and* a pipe underground
      // all at once — `occupants` lists every one of them, not just a single
      // collapsed winner, so a script can tell "there's a road here, just
      // hidden behind a power line" from "no road here" — e.g. to confirm a
      // `water_pipe` placement actually landed underneath a road.
      terrain: terrainLabel(t.terrain),
      occupants: occupantsByStratum(s, t),
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
            tileMatchesKind(s, t, kind) ? [{ x: i % s.width, y: Math.floor(i / s.width) }] : [],
          );
          reply(id, hits);
          break;
        }

        case 'apply_tool': {
          const tool = params.tool as Tool;
          const x = params.x as number;
          const y = params.y as number;
          const moneyBefore = bridge.getState().money;
          const pendingResult = sendApplyTool(tool, x, y, nextStrokeId(), stratumParam(params));
          await waitMs(150);
          const result = await pendingResult;
          reply(id, {
            moneyBefore,
            moneyAfter: bridge.getState().money,
            tile: tileAt(x, y),
            state: simState(),
            success: result.success,
            message: result.message ?? null,
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
          const pending = pts.map(([px, py]) => sendApplyTool(tool, px, py, lineStroke, stratum));
          await waitMs(150);
          const summary = summariseApplyResults(await Promise.all(pending));
          reply(id, { ...summary, moneyBefore, moneyAfter: bridge.getState().money, state: simState() });
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
          const pending: Promise<CommandResultLike>[] = [];
          for (let ry = ay; ry <= by; ry++) {
            for (let rx = ax; rx <= bx; rx++) {
              pending.push(sendApplyTool(tool, rx, ry, rectStroke, stratum));
            }
          }
          await waitMs(150);
          const summary = summariseApplyResults(await Promise.all(pending));
          reply(id, { ...summary, moneyBefore, moneyAfter: bridge.getState().money, state: simState() });
          break;
        }

        case 'get_buildings': {
          const s = bridge.getState();
          reply(id, s.buildings.map(b => summariseBuildingForMcp(s, b)));
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
