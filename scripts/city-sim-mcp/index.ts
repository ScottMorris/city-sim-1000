#!/usr/bin/env bun
// index.ts — City Sim 1000 MCP server.
//
// Bridges the MCP protocol (stdio) ↔ the browser game (WebSocket on port 5174).
//
// Usage:
//   1. bun run dev              (start game at http://localhost:5173)
//   2. bun run mcp              (start this server)
//   3. Open http://localhost:5173/?mcp in a browser
//   4. Register this server in Claude Code's MCP config
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ServerWebSocket } from 'bun';
import { z } from 'zod';

const MCP_WS_PORT = 5174;

// ---------------------------------------------------------------------------
// WebSocket relay — browser connects here, MCP tools route through it
// ---------------------------------------------------------------------------

type WsPendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

const pending = new Map<string, WsPendingCall>();
let gameSocket: ServerWebSocket<unknown> | null = null;

Bun.serve({
  port: MCP_WS_PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
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

console.error(`[mcp] WebSocket relay listening on ws://localhost:${MCP_WS_PORT}`);

function callGame(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
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
  'Get the state of a single tile: kind, powered, watered, abandoned, happiness, elevation, buildingId.',
  {
    x: z.number().int().describe('Tile column (0 = left edge)'),
    y: z.number().int().describe('Tile row (0 = top edge)'),
  },
  async ({ x, y }) => textResult(await callGame('get_tile', { x, y })),
);

server.tool(
  'get_tiles_where',
  'Return all (x, y) positions matching a given tile kind. Useful for finding existing roads, zones, utilities, etc.',
  {
    kind: z.enum([
      'land', 'water', 'tree',
      'road', 'rail',
      'residential', 'commercial', 'industrial',
      'powerline', 'hydro',
      'pump', 'water_tower', 'water_pipe',
      'elementary_school', 'high_school',
      'park', 'park_large',
    ]).describe('Tile kind string. Note: all power plant types (coal/wind/solar/hydro) share the kind "hydro"'),
  },
  async ({ kind }) => textResult(await callGame('get_tiles_where', { kind })),
);

server.tool(
  'apply_tool',
  'Apply a build or demolish action at tile (x, y). Returns money before/after, the resulting tile state, and a sim state snapshot.',
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
  },
  async ({ tool, x, y }) => textResult(await callGame('apply_tool', { tool, x, y })),
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
  'Apply a build tool along a straight line from (x1,y1) to (x2,y2) using Bresenham\'s algorithm. Ideal for roads, power lines, or pipes. Returns number of tiles placed and money delta.',
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
  },
  async ({ tool, x1, y1, x2, y2 }) =>
    textResult(await callGame('apply_tool_line', { tool, x1, y1, x2, y2 })),
);

server.tool(
  'apply_tool_rect',
  'Fill a rectangular region with a tool — useful for zoning large areas in one call. Returns number of tiles placed and money delta.',
  {
    tool: z.enum([
      'residential', 'commercial', 'industrial', 'park', 'park_large',
      'road', 'water_pipe', 'powerline', 'bulldoze',
    ]).describe('Tool to apply across the rectangle'),
    x1: z.number().int().describe('Left column (inclusive)'),
    y1: z.number().int().describe('Top row (inclusive)'),
    x2: z.number().int().describe('Right column (inclusive)'),
    y2: z.number().int().describe('Bottom row (inclusive)'),
  },
  async ({ tool, x1, y1, x2, y2 }) =>
    textResult(await callGame('apply_tool_rect', { tool, x1, y1, x2, y2 })),
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
