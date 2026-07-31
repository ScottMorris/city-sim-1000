// Black-box tests for City Sim's MCP browser relay.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, expect, test } from 'bun:test';

const decoder = new TextDecoder();
const serverPath = new URL('./index.ts', import.meta.url).pathname;
const testPort = 55000 + (process.pid % 1000);
const relayUrl = `http://127.0.0.1:${testPort}`;
const relayLockPath = `/tmp/city-sim-1000-mcp-${testPort}.lock`;
const processes: Bun.Subprocess[] = [];

class McpClient {
  #buffer = '';
  #reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(readonly process: Bun.Subprocess) {
    this.#reader = process.stdout.getReader();
  }

  send(message: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async readMessage(): Promise<Record<string, unknown>> {
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return JSON.parse(line) as Record<string, unknown>;
      }
      const { done, value } = await this.#reader.read();
      if (done) throw new Error('MCP server closed stdout before responding');
      this.#buffer += decoder.decode(value, { stream: true });
    }
  }

  async request(id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.send({ jsonrpc: '2.0', id, method, params });
    const response = await this.readMessage();
    expect(response.id).toBe(id);
    return response;
  }

  async initialise(id: number): Promise<void> {
    const response = await this.request(id, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'relay-test', version: '1.0.0' },
    });
    expect(response.result).toBeDefined();
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
}

function startClient(): McpClient {
  const child = Bun.spawn(['bun', 'run', serverPath], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, CITY_SIM_MCP_PORT: String(testPort) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.push(child);
  return new McpClient(child);
}

async function waitForRelay(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(relayUrl)).ok) return;
    } catch {
      // The process is still claiming the port.
    }
    await Bun.sleep(25);
  }
  throw new Error('MCP relay did not start');
}

afterEach(async () => {
  const children = processes.splice(0);
  for (const process of children) process.kill();
  await Promise.all(children.map(process => process.exited));
  try { await Bun.file(relayLockPath).delete(); } catch { /* No test lock remains. */ }
});

test('concurrent MCP clients complete initialisation without competing for the relay port', async () => {
  const first = startClient();
  const second = startClient();

  await Promise.all([first.initialise(1), second.initialise(2)]);
  await waitForRelay();
}, 10_000);

test('a second MCP client proxies a browser tool call through the relay owner', async () => {
  const owner = startClient();
  await owner.initialise(1);
  await waitForRelay();

  const proxy = startClient();
  await proxy.initialise(2);

  const game = new WebSocket(`ws://127.0.0.1:${testPort}`);
  await new Promise<void>((resolve, reject) => {
    game.addEventListener('open', () => resolve(), { once: true });
    game.addEventListener('error', () => reject(new Error('Test browser could not connect')), { once: true });
  });

  const browserCall = new Promise<void>((resolve, reject) => {
    game.addEventListener('message', event => {
      try {
        const request = JSON.parse(String(event.data)) as { id: string; method: string; params: unknown };
        expect(request.method).toBe('get_state');
        expect(request.params).toEqual({});
        game.send(JSON.stringify({ id: request.id, result: { tick: 42, population: 7 } }));
        resolve();
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });

  const response = await proxy.request(3, 'tools/call', { name: 'get_state', arguments: {} });
  await browserCall;
  const result = response.result as { content: Array<{ text: string }> };
  expect(JSON.parse(result.content[0].text)).toEqual({ tick: 42, population: 7 });
  game.close();
}, 10_000);
