// engines.ts — the two engine adapters the parity harness replays a script on.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * One command list, two engines, one vocabulary of answers.
 *
 * `rustEngine()` drives the real `SimHost` — the same WASM cdylib the browser
 * Worker runs, loaded straight from `app/src/wasm/` (so `bun run build:wasm`
 * is a prerequisite, exactly as it is for `bun run dev`).
 *
 * `tsEngine()` drives `simulation.ts` / `applyTool`, the declared test-only
 * parity oracle in `app/src/game/`.
 *
 * Both expose the same three verbs — `apply`, `tick`, `read` — and answer in
 * {@link TileFacts} and {@link Headline}. Neither adapter is allowed to
 * normalise anything on its engine's behalf: every reading comes off the
 * engine's own public surface (`tile_buffer()` for Rust, `GameState` for TS)
 * and goes through the shared `factsFromWire`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInitialState, getTile, GameState, TileKind } from '../gameState';
import { Simulation } from '../simulation';
import { applyTool } from '../tools';
import { Tool } from '../toolTypes';
import { tileKindFromU8, tileKindToU8 } from '../protocol/tileKind';
import {
  BYTES_PER_TILE,
  tileBufferOffsets,
  decodeUndergroundBits,
  decodeSurfaceBits,
  decodeOverheadBits,
  STATUS
} from '../protocol/tileBuffer';
import { LEGACY_FLAGS } from '../protocol/legacyTileBuffer';
import { Terrain } from '../protocol/occupants';
import { legacyKind, legacyFlags, legacyUndergroundKind } from '../protocol/legacyProjection';
import { factsFromWire, TileFacts } from './tileFacts';

interface WireBuilding {
  id: number;
  kind: number;
  originX: number;
  originY: number;
}

/**
 * TS `Tool` → the Rust `#[repr(u8)]` discriminant.
 *
 * A copy of `TOOL_TO_U8` in `wasmSimBridge.ts`, which is not exported. The
 * `Record<Tool, number>` annotation makes a new `Tool` variant a compile error
 * here, so the copy cannot silently go short.
 */
const TOOL_TO_U8: Record<Tool, number> = {
  [Tool.Inspect]: 0,
  [Tool.TerraformRaise]: 1,
  [Tool.TerraformLower]: 2,
  [Tool.Water]: 3,
  [Tool.Tree]: 4,
  [Tool.Road]: 5,
  [Tool.Rail]: 6,
  [Tool.PowerLine]: 7,
  [Tool.HydroPlant]: 8,
  [Tool.CoalPlant]: 9,
  [Tool.WindTurbine]: 10,
  [Tool.SolarFarm]: 11,
  [Tool.WaterPump]: 12,
  [Tool.WaterTower]: 13,
  [Tool.WaterPipe]: 14,
  [Tool.ElementarySchool]: 15,
  [Tool.HighSchool]: 16,
  [Tool.Residential]: 17,
  [Tool.Commercial]: 18,
  [Tool.Industrial]: 19,
  [Tool.Park]: 20,
  [Tool.Bulldoze]: 21,
  [Tool.ParkLarge]: 22
};

/** Headline scalars both engines publish. */
export interface Headline {
  money: number;
  population: number;
  jobs: number;
  powerProduced: number;
  powerUsed: number;
  powerBalance: number;
  waterProduced: number;
  waterUsed: number;
  waterBalance: number;
}

export interface Engine {
  readonly name: 'rust' | 'ts';
  readonly width: number;
  readonly height: number;
  /** Apply one tool; returns whether the engine accepted it. */
  apply(tool: Tool, x: number, y: number): boolean;
  /** Advance exactly one 20 Hz simulation tick. */
  tick(): void;
  headline(): Headline;
  facts(): TileFacts[];
}

// ---------------------------------------------------------------------------
// Shared starting map
// ---------------------------------------------------------------------------

/**
 * The natural terrain both engines start from, as `TileKind` u8s.
 *
 * `GameState::new` in Rust is bare land; `createInitialState` in TS carves a
 * water border and a lake. The TS map is the one the game actually ships, so it
 * is taken as given and pushed into Rust through `set_natural_terrain` — the
 * same call the Worker makes on boot. Anything else would be comparing two
 * different cities.
 */
function naturalTerrain(state: GameState): Uint8Array {
  const out = new Uint8Array(state.tiles.length);
  state.tiles.forEach((tile, i) => {
    out[i] = tileKindToU8(tile.kind);
  });
  return out;
}

/** The wasm-pack `SimHost` constructor, once `initWasm()` has resolved. */
type SimHostCtor = new (width: number, height: number, seed: number) => SimHostInstance;

/** The slice of `SimHost` the harness drives. See `sim_wasm.d.ts` for the rest. */
interface SimHostInstance {
  apply_tool(toolIdx: number, x: number, y: number, strokeId: number): boolean;
  set_natural_terrain(kinds: Uint8Array): void;
  step(dt: number): void;
  tile_buffer(): Uint8Array;
  buildings_json(): string;
  money(): number;
  population(): number;
  jobs(): number;
  power_produced(): number;
  power_used(): number;
  power_balance(): number;
  water_produced(): number;
  water_used(): number;
  water_balance(): number;
}

let wasmReady: Promise<void> | null = null;
let SimHost: SimHostCtor | null = null;

/**
 * Instantiate the wasm module once per test process.
 *
 * The import is dynamic so that a worktree without `bun run build:wasm` fails
 * with a sentence rather than a module-resolution stack trace — `app/src/wasm/`
 * is generated output and gitignored, exactly as it is for `bun run dev`.
 */
export async function initWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      let mod: { default: (opts: { module_or_path: Uint8Array }) => Promise<unknown>; SimHost: SimHostCtor };
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — generated by wasm-pack; see `wasmSim.worker.ts`.
        mod = await import('../../wasm/sim_wasm/sim_wasm.js');
      } catch (err) {
        throw new Error(
          'The cross-engine parity harness needs the WASM build. Run `bun run build:wasm` ' +
            `from the repo root, then re-run the test. (${String(err)})`
        );
      }
      const wasmPath = fileURLToPath(
        new URL('../../wasm/sim_wasm/sim_wasm_bg.wasm', import.meta.url)
      );
      await mod.default({ module_or_path: readFileSync(wasmPath) });
      SimHost = mod.SimHost;
    })();
  }
  return wasmReady;
}

// ---------------------------------------------------------------------------
// Rust — the real WASM SimHost
// ---------------------------------------------------------------------------

export function rustEngine(width: number, height: number, seed: number): Engine {
  if (!SimHost) throw new Error('rustEngine() called before initWasm() resolved');
  const terrain = naturalTerrain(createInitialState(width, height, seed));
  const host = new SimHost(width, height, seed);
  host.set_natural_terrain(terrain);
  let stroke = 1;
  const n = width * height;
  const off = tileBufferOffsets(n);

  return {
    name: 'rust',
    width,
    height,
    apply(tool, x, y) {
      return host.apply_tool(TOOL_TO_U8[tool], x, y, stroke++);
    },
    tick() {
      host.step(1 / 20);
    },
    headline() {
      return {
        money: host.money(),
        population: host.population(),
        jobs: host.jobs(),
        powerProduced: host.power_produced(),
        powerUsed: host.power_used(),
        powerBalance: host.power_balance(),
        waterProduced: host.water_produced(),
        waterUsed: host.water_used(),
        waterBalance: host.water_balance()
      };
    },
    facts() {
      const buf = host.tile_buffer();
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      // The live wire no longer carries a resolved kind byte per tile — a
      // `Structure` occupant says only that a building stands here, not
      // which one (#177's TS/wire follow-up). `buildings_json` is the only
      // source for that now, same as `wasmSimBridge.ts`'s decode.
      const wireBuildings: WireBuilding[] = JSON.parse(host.buildings_json());
      const structureKindById = new Map<number, TileKind>();
      for (const b of wireBuildings) {
        const kind = tileKindFromU8(b.kind);
        if (kind !== undefined) structureKindById.set(b.id, kind);
      }
      const structureKindOf = (id: number) => structureKindById.get(id);

      const out: TileFacts[] = [];
      for (let i = 0; i < n; i++) {
        const terrain = (buf[off.status + i] & STATUS.WATER_TERRAIN) !== 0 ? Terrain.Water : Terrain.Land;
        const surface = decodeSurfaceBits(buf[off.surface + i]);
        const overhead = decodeOverheadBits(buf[off.overhead + i]);
        const underground = decodeUndergroundBits(buf[off.underground + i]);
        const buildingIdRaw = view.getUint16(off.buildingId + i * 2, true);
        const buildingId = buildingIdRaw === 0 ? undefined : buildingIdRaw;

        const kind = legacyKind({ terrain, surface, overhead, buildingId, structureKindOf });
        const flags = legacyFlags({ terrain, surface, overhead, buildingId, structureKindOf }, kind);
        const flagBits =
          ((buf[off.status + i] & STATUS.POWERED) !== 0 ? LEGACY_FLAGS.POWERED : 0) |
          ((buf[off.status + i] & STATUS.WATERED) !== 0 ? LEGACY_FLAGS.WATERED : 0) |
          ((buf[off.status + i] & STATUS.ABANDONED) !== 0 ? LEGACY_FLAGS.ABANDONED : 0) |
          (flags.roadUnderlay ? LEGACY_FLAGS.ROAD_UNDERLAY : 0) |
          (flags.railUnderlay ? LEGACY_FLAGS.RAIL_UNDERLAY : 0) |
          (flags.powerOverlay ? LEGACY_FLAGS.POWER_OVERLAY : 0);

        out.push(factsFromWire(kind, flagBits, buildingIdRaw, legacyUndergroundKind(underground)));
      }
      return out;
    }
  };
}

/** Byte length of the SoA buffer, asserted against the protocol constant. */
export function rustBufferLength(width: number, height: number): number {
  return width * height * BYTES_PER_TILE;
}

// ---------------------------------------------------------------------------
// TypeScript — the simulation.ts oracle
// ---------------------------------------------------------------------------

export function tsEngine(width: number, height: number, seed: number): Engine {
  const state = createInitialState(width, height, seed);
  const sim = new Simulation(state, { ticksPerSecond: 20 });

  /** Repack a TS `Tile` into the v4 flags byte so both sides read it alike. */
  const flagsOf = (x: number, y: number): number => {
    const tile = getTile(state, x, y)!;
    let bits = 0;
    if (tile.powered) bits |= LEGACY_FLAGS.POWERED;
    if (tile.watered) bits |= LEGACY_FLAGS.WATERED;
    if (tile.abandoned) bits |= LEGACY_FLAGS.ABANDONED;
    if (tile.roadUnderlay) bits |= LEGACY_FLAGS.ROAD_UNDERLAY;
    if (tile.railUnderlay) bits |= LEGACY_FLAGS.RAIL_UNDERLAY;
    if (tile.powerOverlay) bits |= LEGACY_FLAGS.POWER_OVERLAY;
    return bits;
  };

  return {
    name: 'ts',
    width,
    height,
    apply(tool, x, y) {
      return applyTool(state, tool, x, y).success;
    },
    tick() {
      sim.update(1 / 20);
    },
    headline() {
      return {
        money: state.money,
        population: state.population,
        jobs: state.jobs,
        powerProduced: state.utilities.powerProduced,
        powerUsed: state.utilities.powerUsed,
        powerBalance: state.utilities.power,
        waterProduced: state.utilities.waterProduced,
        waterUsed: state.utilities.waterUsed,
        waterBalance: state.utilities.water
      };
    },
    facts() {
      const out: TileFacts[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const tile = getTile(state, x, y)!;
          out.push(
            factsFromWire(
              tile.kind,
              flagsOf(x, y),
              tile.buildingId ?? 0,
              tile.legacyUnderground === TileKind.WaterPipe ? TileKind.WaterPipe : undefined
            )
          );
        }
      }
      return out;
    }
  };
}
