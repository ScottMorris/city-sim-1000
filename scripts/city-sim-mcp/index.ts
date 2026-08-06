#!/usr/bin/env bun
// index.ts — City Sim 1000 MCP server.
//
// Bridges the MCP protocol (stdio) ↔ the browser game (WebSocket on port 5174).
//
// Usage:
//   1. bun run dev              (start game at http://localhost:5173)
//   2. bun run mcp              (start this server)
//   3. Open http://localhost:5173/?mcp in a browser
//   4. Register this server with Codex (see the README's MCP section)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ServerWebSocket } from 'bun';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const MCP_WS_PORT = Number.parseInt(process.env.CITY_SIM_MCP_PORT ?? '5174', 10);
const RELAY_LOCK_PATH = `/tmp/city-sim-1000-mcp-${MCP_WS_PORT}.lock`;
let relayLockToken: string | undefined;

// ---------------------------------------------------------------------------
// WebSocket relay — browser connects here, MCP tools route through it
// ---------------------------------------------------------------------------

type WsPendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

const pending = new Map<string, WsPendingCall>();
let gameSocket: ServerWebSocket<unknown> | null = null;
let ownsRelay = false;
let relayStart: Promise<void> | null = null;

async function existingRelayIsAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${MCP_WS_PORT}`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function acquireRelayLock(): boolean {
  try {
    const fd = openSync(RELAY_LOCK_PATH, 'wx');
    relayLockToken = `${process.pid}:${crypto.randomUUID()}`;
    writeFileSync(fd, relayLockToken);
    closeSync(fd);
    process.once('exit', () => {
      try {
        if (readFileSync(RELAY_LOCK_PATH, 'utf8') === relayLockToken) {
          unlinkSync(RELAY_LOCK_PATH);
        }
      } catch { /* Relay lock already removed. */ }
    });
    return true;
  } catch {
    return false;
  }
}

function removeStaleRelayLock(): boolean {
  try {
    const [pidText] = readFileSync(RELAY_LOCK_PATH, 'utf8').split(':', 1);
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      unlinkSync(RELAY_LOCK_PATH);
      return true;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      unlinkSync(RELAY_LOCK_PATH);
      return true;
    }
  } catch {
    return false;
  }
}

function callConnectedGame(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!gameSocket) {
    throw new Error(
      'No game connected. Open http://localhost:5173/?mcp in a browser first.',
    );
  }
  const id = crypto.randomUUID();
  const TIMEOUT_MS = 30_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for game response to "${method}"`));
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve(v) { clearTimeout(timer); resolve(v); },
      reject(e) { clearTimeout(timer); reject(e); },
    });
    gameSocket!.send(JSON.stringify({ id, method, params }));
  });
}

async function startRelay(): Promise<void> {
  if (await existingRelayIsAvailable()) {
    console.error('[mcp] Reusing an existing City Sim relay');
    return;
  }

  if (!acquireRelayLock()) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (await existingRelayIsAvailable()) {
        console.error('[mcp] Reusing an existing City Sim relay');
        return;
      }
    }
    if (removeStaleRelayLock()) return startRelay();
    throw new Error('Another City Sim MCP process is starting the browser relay');
  }

  Bun.serve({
    hostname: '127.0.0.1',
    port: MCP_WS_PORT,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/call' && req.method === 'POST') {
        try {
          const { method, params } = await req.json() as {
            method?: unknown;
            params?: unknown;
          };
          if (typeof method !== 'string' || (params != null && typeof params !== 'object')) {
            return Response.json({ error: 'Invalid relay request' }, { status: 400 });
          }
          return Response.json({ result: await callConnectedGame(method, params as Record<string, unknown> ?? {}) });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      }
      if (req.method === 'GET' && server.upgrade(req)) return undefined;
      return new Response(
        'City Sim 1000 MCP relay — open http://localhost:5173/?mcp in a browser',
        { status: 200, headers: { 'Content-Type': 'text/plain' } },
      );
    },
    websocket: {
      open(ws) {
        gameSocket = ws;
        console.error('[mcp] Browser game connected');
      },
      message(_ws, data) {
        const msg = JSON.parse(data as string) as {
          id: string;
          result?: unknown;
          error?: string;
        };
        const call = pending.get(msg.id);
        if (!call) return;
        pending.delete(msg.id);
        if (msg.error) call.reject(new Error(msg.error));
        else call.resolve(msg.result);
      },
      close() {
        gameSocket = null;
        console.error('[mcp] Browser game disconnected');
      },
    },
  });
  ownsRelay = true;
  console.error(`[mcp] WebSocket relay listening on ws://localhost:${MCP_WS_PORT}`);
}

function ensureRelay(): Promise<void> {
  relayStart ??= startRelay();
  return relayStart;
}

async function callGame(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  await ensureRelay();
  if (ownsRelay) return callConnectedGame(method, params);

  const response = await fetch(`http://127.0.0.1:${MCP_WS_PORT}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Relay request for "${method}" failed`);
  }
  return body.result;
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'city-sim-1000', version: '0.1.0' });

server.tool(
  'get_state',
  'Get current simulation stats: tick, day, month, money, population, jobs, power balance, water balance, residential/commercial/industrial demand, and map dimensions.',
  {},
  async () => textResult(await callGame('get_state')),
);

server.tool(
  'get_tile',
  'Get the state of a single tile: terrain, occupants, powered, watered, abandoned, happiness, elevation, buildingId. `terrain` is `"land"` or `"water"` — the ground itself, independent of anything built on it. `occupants` gives everything actually on the tile as `{ underground: string[], surface: string[], overhead: string[] }` — a tile can carry a road on the surface, a power line overhead, and a pipe underground all at once, so e.g. checking a `water_pipe` placement landed underneath a road means looking at `occupants.underground` and `occupants.surface` together, not a single collapsed label.',
  {
    x: z.number().int().describe('Tile column (0 = left edge)'),
    y: z.number().int().describe('Tile row (0 = top edge)'),
  },
  async ({ x, y }) => textResult(await callGame('get_tile', { x, y })),
);

server.tool(
  'get_tiles_where',
  'Return all (x, y) positions matching a given tile kind. Useful for finding existing roads, zones, utilities, etc. `kind: "land"` or `"water"` matches the tile\'s *terrain* — independent of what\'s built on it, so a road built on land still matches `"land"`. Every other `kind` matches if it appears in ANY of the tile\'s strata (underground/surface/overhead) — e.g. a road hidden under a power line still matches `kind: "road"` — see `get_tile`\'s `occupants` field for the same per-tile breakdown.',
  {
    kind: z.enum([
      'land', 'water', 'tree',
      'road', 'rail',
      'residential', 'commercial', 'industrial',
      'powerline',
      'hydro', 'coal', 'wind', 'solar',
      'pump', 'water_tower', 'water_pipe',
      'elementary_school', 'high_school',
      'park', 'park_large',
    ]).describe('Tile kind string. Each power plant type has its own distinct kind (hydro/coal/wind/solar), not a shared one. `land`/`water` match terrain; every other value matches an occupant in any stratum.'),
  },
  async ({ kind }) => textResult(await callGame('get_tiles_where', { kind })),
);

server.tool(
  'apply_tool',
  'Apply a build or demolish action at tile (x, y). Returns money before/after, the resulting tile state, a sim state snapshot, and `success`/`message` reporting whether the engine actually accepted the command (e.g. wrong stratum, insufficient funds, no road access) — check `success` rather than assuming the placement landed.',
  {
    tool: z.enum([
      'inspect',
      'terraform_raise', 'terraform_lower',
      'water', 'tree',
      'road', 'rail', 'powerline',
      'hydro', 'coal', 'wind', 'solar',
      'pump', 'water_tower', 'water_pipe',
      'elementary_school', 'high_school',
      'residential', 'commercial', 'industrial',
      'park', 'park_large', 'bulldoze',
    ]).describe('Tool to apply'),
    x: z.number().int().describe('Tile column'),
    y: z.number().int().describe('Tile row'),
    stratum: z.enum(['surface', 'underground']).optional()
      .describe('Which layer to act on. `bulldoze` clears only this stratum; `water_pipe` refuses outright unless this is "underground" (and defaults there automatically if omitted). Every other tool ignores it. Defaults to surface otherwise.'),
  },
  async ({ tool, x, y, stratum }) => textResult(await callGame('apply_tool', { tool, x, y, stratum })),
);

server.tool(
  'set_speed',
  'Set simulation speed. 0 = paused, 0.5 = slow, 1 = normal, 3 = fast.',
  {
    multiplier: z.number().min(0).describe('Speed multiplier'),
  },
  async ({ multiplier }) => textResult(await callGame('set_speed', { multiplier })),
);

server.tool(
  'step_ticks',
  'Wait for the simulation to advance by N ticks, then return a state snapshot. The browser briefly runs at 3× speed so the wait is short.',
  {
    count: z.number().int().positive().default(20).describe('Number of simulation ticks to wait for'),
  },
  async ({ count }) => textResult(await callGame('step_ticks', { count })),
);

server.tool(
  'apply_tool_line',
  'Apply a build tool along a straight line from (x1,y1) to (x2,y2) using Bresenham\'s algorithm. Ideal for roads, power lines, or pipes. Returns `placed` (tiles the engine actually accepted), `attempted` (total tiles on the line), and `firstFailureMessage` (the engine\'s reason for the first rejected tile, if `placed` < `attempted`) alongside the money delta.',
  {
    tool: z.enum([
      'road', 'rail', 'powerline',
      'pump', 'water_pipe',
      'bulldoze',
    ]).describe('Tool to apply along the line'),
    x1: z.number().int().describe('Start tile column'),
    y1: z.number().int().describe('Start tile row'),
    x2: z.number().int().describe('End tile column'),
    y2: z.number().int().describe('End tile row'),
    stratum: z.enum(['surface', 'underground']).optional()
      .describe('Which layer to act on. `bulldoze` clears only this stratum; `water_pipe` refuses outright unless this is "underground" (and defaults there automatically if omitted). Every other tool ignores it. Defaults to surface otherwise.'),
  },
  async ({ tool, x1, y1, x2, y2, stratum }) =>
    textResult(await callGame('apply_tool_line', { tool, x1, y1, x2, y2, stratum })),
);

server.tool(
  'apply_tool_rect',
  'Fill a rectangular region with a tool — useful for zoning large areas in one call. Returns `placed` (tiles the engine actually accepted), `attempted` (total tiles in the rectangle), and `firstFailureMessage` (the engine\'s reason for the first rejected tile, if `placed` < `attempted`) alongside the money delta.',
  {
    tool: z.enum([
      'residential', 'commercial', 'industrial', 'park', 'park_large',
      'road', 'water_pipe', 'powerline', 'bulldoze',
    ]).describe('Tool to apply across the rectangle'),
    x1: z.number().int().describe('Left column (inclusive)'),
    y1: z.number().int().describe('Top row (inclusive)'),
    x2: z.number().int().describe('Right column (inclusive)'),
    y2: z.number().int().describe('Bottom row (inclusive)'),
    stratum: z.enum(['surface', 'underground']).optional()
      .describe('Which layer to act on. `bulldoze` clears only this stratum; `water_pipe` refuses outright unless this is "underground" (and defaults there automatically if omitted). Every other tool ignores it. Defaults to surface otherwise.'),
  },
  async ({ tool, x1, y1, x2, y2, stratum }) =>
    textResult(await callGame('apply_tool_rect', { tool, x1, y1, x2, y2, stratum })),
);

server.tool(
  'get_buildings',
  'Return all placed buildings with their id, templateId, tile origin, status, health, and abandoned flag.',
  {},
  async () => textResult(await callGame('get_buildings')),
);

server.tool(
  'get_adjacents',
  'Return the tile state for the four cardinal neighbours (north/east/south/west) of a given tile.',
  {
    x: z.number().int().describe('Tile column'),
    y: z.number().int().describe('Tile row'),
  },
  async ({ x, y }) => textResult(await callGame('get_adjacents', { x, y })),
);

server.tool(
  'undo',
  'Undo the last placed tile or player action.',
  {},
  async () => textResult(await callGame('undo')),
);

server.tool(
  'screenshot',
  'Capture a PNG screenshot of the game canvas.',
  {},
  async () => {
    const result = await callGame('screenshot') as { mimeType: string; data: string };
    return { content: [{ type: 'image' as const, data: result.data, mimeType: result.mimeType }] };
  },
);

server.tool(
  'reset',
  'Start a new game. An optional seed makes world generation deterministic.',
  {
    seed: z.number().int().optional().describe('Seed for deterministic world generation'),
  },
  async ({ seed }) => textResult(await callGame('reset', seed != null ? { seed } : {})),
);

// ---------------------------------------------------------------------------
// Connect MCP to stdio
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
void ensureRelay().catch(error => {
  console.error(`[mcp] Could not start the browser relay: ${String(error)}`);
});
