// crossEngineParity.test.ts — the same commands through both engines.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * Cross-language parity: one command list, the real Rust engine and the
 * TypeScript oracle, and an assertion that they answer alike.
 *
 *     bun run test:parity
 *
 * Needs `bun run build:wasm` first — the Rust side is the actual `SimHost`
 * cdylib the browser Worker runs, not a re-implementation.
 *
 * ## Why this exists
 *
 * `app/src/game/simulation.ts`, `adjacency.ts`, `tools.ts` and
 * `buildings/manager.ts` are a declared test-only mirror of the Rust engine —
 * and nothing made them stay one. During #177 `adjacency.ts` drifted from
 * `adjacency.rs` twice (the `hasRoadAccess` PowerLine clause, the
 * `isPowerCarrier` overlay clause) and both were caught only by a human
 * reading the two files side by side. Every test in this file is a question
 * asked of both engines at once, so the next drift fails a build instead.
 *
 * ## What is compared, and what is not
 *
 * Compared: whether each tool was accepted, the per-tile outcome in the
 * spelling-agnostic vocabulary of `tileFacts.ts`, and the headline scalars —
 * money, population, jobs, and the power and water ledgers.
 *
 * Not compared, each for a stated reason:
 *
 * - **wilderness** — excluded from the oracle by design
 *   (`docs/features/wilderness-score.md`, decision 4).
 * - **the raw wire `kind` byte** — `display.rs` documents three intended
 *   normalisations there; that is the visual-regression harness's ground, not
 *   this one's. See the note at the top of `tileFacts.ts`.
 * - **two named headline drifts** — `WATER_PRODUCTION_DRIFT` below, and the
 *   activation gate pinned in "known drift". Both are listed, both are pinned
 *   by a test that fails when the underlying disagreement goes away, and both
 *   are written out in full where they are declared.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initWasm, rustEngine, tsEngine } from './engines';
import { cmd, Command, fuzzScript, replay, ReplayOptions, summarise } from './replay';
import { Tool } from '../toolTypes';

beforeAll(async () => {
  await initWasm();
});

/** Assert two engines agree, printing every disagreement when they do not. */
function expectAgreement(label: string, script: Command[], opts: ReplayOptions = {}): void {
  const found = replay(script, opts);
  expect(found.length, `${label}\n${summarise(found)}`).toBe(0);
}

describe('cross-engine parity — placement', () => {
  it('lays a road grid and zones beside it', () => {
    const script: Command[] = [];
    for (let x = 1; x < 10; x++) script.push(cmd(Tool.Road, x, 5));
    for (let x = 1; x < 10; x++) script.push(cmd(Tool.Residential, x, 4));
    for (let x = 1; x < 5; x++) script.push(cmd(Tool.Commercial, x, 6));
    for (let x = 5; x < 10; x++) script.push(cmd(Tool.Industrial, x, 6));
    expectAgreement('road grid and zones', script);
  });

  it('strings a hydro line across zones, roads and rail in both build orders', () => {
    const script: Command[] = [
      cmd(Tool.Road, 2, 2),
      cmd(Tool.PowerLine, 2, 2),
      cmd(Tool.PowerLine, 3, 2),
      cmd(Tool.Road, 3, 2),
      cmd(Tool.Rail, 4, 2),
      cmd(Tool.PowerLine, 4, 2),
      cmd(Tool.PowerLine, 5, 2),
      cmd(Tool.Rail, 5, 2),
      cmd(Tool.Residential, 6, 2),
      cmd(Tool.PowerLine, 6, 2),
      cmd(Tool.PowerLine, 7, 2),
      cmd(Tool.Residential, 7, 2)
    ];
    expectAgreement('line over carriageway, both orders', script);
  });

  it('builds level crossings in both build orders', () => {
    const script: Command[] = [
      cmd(Tool.Road, 2, 8),
      cmd(Tool.Rail, 2, 8),
      cmd(Tool.Rail, 4, 8),
      cmd(Tool.Road, 4, 8)
    ];
    expectAgreement('level crossings', script);
  });

  it('refuses a structure stamped over a hydro line hidden on a zone', () => {
    // The three clicks named in `place_footprint_building`: zone, line, park.
    // The line wears `POWER_OVERLAY` rather than `kind`, so a guard that reads
    // only `kind` cannot see it.
    const script: Command[] = [
      cmd(Tool.Residential, 3, 3),
      cmd(Tool.PowerLine, 3, 3),
      cmd(Tool.Park, 3, 3)
    ];
    expectAgreement('park over a line on a zone', script);
  });

  it('refuses a regrade that would strand a live building', () => {
    const script: Command[] = [
      cmd(Tool.CoalPlant, 2, 2),
      cmd(Tool.TerraformLower, 2, 2),
      cmd(Tool.TerraformRaise, 3, 3),
      cmd(Tool.Water, 2, 3),
      cmd(Tool.Tree, 3, 2)
    ];
    expectAgreement('regrade over a live plant', script);
  });

  it('leaves the ground where it was when the bulldozer clears a tile', () => {
    const script: Command[] = [
      cmd(Tool.Water, 4, 4),
      cmd(Tool.Bulldoze, 4, 4),
      cmd(Tool.Road, 6, 6),
      cmd(Tool.Bulldoze, 6, 6),
      cmd(Tool.Park, 8, 8),
      cmd(Tool.Bulldoze, 8, 8)
    ];
    expectAgreement('bulldoze leaves terrain', script);
  });

  it('agrees on what a bulldozer click reaches when a pipe is buried below', () => {
    const script: Command[] = [
      cmd(Tool.WaterPipe, 5, 5),
      cmd(Tool.Road, 5, 5),
      cmd(Tool.Bulldoze, 5, 5)
    ];
    expectAgreement('bulldoze over a buried pipe', script);
  });

  it('plants, paves and zones over forest', () => {
    const script: Command[] = [
      cmd(Tool.Tree, 2, 6),
      cmd(Tool.Road, 2, 6),
      cmd(Tool.Tree, 3, 6),
      cmd(Tool.Residential, 3, 6),
      cmd(Tool.Tree, 4, 6),
      cmd(Tool.PowerLine, 4, 6),
      cmd(Tool.Tree, 5, 6),
      cmd(Tool.Park, 5, 6)
    ];
    expectAgreement('construction over forest', script);
  });

  it('places every footprint building and refuses the overlaps', () => {
    const script: Command[] = [
      cmd(Tool.CoalPlant, 1, 1),
      cmd(Tool.CoalPlant, 2, 2), // overlaps
      cmd(Tool.HydroPlant, 4, 1),
      cmd(Tool.WindTurbine, 7, 1),
      cmd(Tool.SolarFarm, 9, 1),
      cmd(Tool.WaterPump, 1, 4),
      cmd(Tool.WaterTower, 3, 4),
      cmd(Tool.ElementarySchool, 5, 4),
      cmd(Tool.HighSchool, 8, 4),
      cmd(Tool.Park, 1, 7),
      cmd(Tool.ParkLarge, 3, 7),
      cmd(Tool.Road, 6, 7),
      cmd(Tool.Park, 6, 7) // over a road
    ];
    expectAgreement('footprint buildings', script);
  });
});

/**
 * The one headline pair left out of the comparison, and why.
 *
 * `sum_output_water` in `crates/city-sim-core/src/utilities.rs` totals every
 * tile with `water_output > 0` and asks nothing else. `recomputeWaterNetwork`
 * in `app/src/game/utilities/water.ts` credits a source only when its building
 * is `Active` *and* `hasWaterSourceConnection` finds natural water beside the
 * footprint. So a pump dropped on dry ground with no power reports 50 units of
 * production to the HUD, the budget and the water balance in the shipped
 * engine, and 0 in the oracle.
 *
 * This is **not** oracle drift and is not fixed here: the two gates are a
 * modelling rule the TypeScript side implements and the Rust side does not, so
 * closing it is an engine change, and `commands.rs` / `utilities.rs` are
 * canonical. Reported instead. `known drift` below pins the disagreement, so
 * the day the engine grows the gates this exclusion is flagged as stale.
 */
const WATER_PRODUCTION_DRIFT = ['waterProduced', 'waterBalance'] as const;

describe('cross-engine parity — running city', () => {
  const smallCity: Command[] = [
    cmd(Tool.CoalPlant, 1, 1),
    cmd(Tool.WaterPump, 1, 4),
    cmd(Tool.Road, 3, 1),
    cmd(Tool.Road, 3, 2),
    cmd(Tool.Road, 3, 3),
    cmd(Tool.Road, 3, 4),
    cmd(Tool.Road, 3, 5),
    cmd(Tool.PowerLine, 3, 6),
    cmd(Tool.WaterPipe, 3, 5),
    cmd(Tool.WaterPipe, 2, 5),
    cmd(Tool.WaterPipe, 1, 5),
    cmd(Tool.Residential, 4, 2),
    cmd(Tool.Residential, 4, 3),
    cmd(Tool.Commercial, 4, 4),
    cmd(Tool.Industrial, 4, 5)
  ];

  it('agrees on the power and water networks a small city settles into', () => {
    expectAgreement('utility networks', smallCity, {
      ticks: 60,
      ignoreHeadline: WATER_PRODUCTION_DRIFT
    });
  });

  it('develops a lot standing under a hydro line, at the same tick, in both engines', () => {
    // The guard that refuses a *structure* over a live line must not refuse a
    // zone lot growing under one — in the engine it lives in
    // `place_footprint_building`, which zone growth never reaches. Putting the
    // mirror of it in `placeBuilding` instead of `tools.ts` would have stopped
    // every lot under a line from ever developing, and no placement-only test
    // would have noticed.
    const script: Command[] = [
      cmd(Tool.CoalPlant, 1, 1),
      cmd(Tool.Road, 3, 1),
      cmd(Tool.Road, 3, 2),
      cmd(Tool.Road, 3, 3),
      cmd(Tool.Residential, 4, 2),
      cmd(Tool.PowerLine, 4, 2)
    ];
    const engines = [rustEngine(8, 8, 7), tsEngine(8, 8, 7)];
    for (const engine of engines) {
      for (const c of script) engine.apply(c.tool, c.x, c.y);
    }
    const lot = 2 * 8 + 4; // (4, 2)
    const developedAt = engines.map(engine => {
      for (let t = 1; t <= 400; t++) {
        engine.tick();
        const facts = engine.facts()[lot];
        expect(facts.line, `${engine.name} lost the hydro line over the lot`).toBe(true);
        if (facts.developed) return t;
      }
      return -1;
    });
    expect(developedAt[0], 'the engine never developed the lot under the line').toBeGreaterThan(0);
    expect(developedAt[1], 'rust and ts developed the lot at different ticks').toBe(developedAt[0]);
  });

  it('agrees on money, population and jobs across the first two sim days', () => {
    // 60 ticks at 20 Hz is 3 real seconds — 2 sim days, and past the 40-tick
    // zone-growth delay, so demand, tax and daily maintenance have all run.
    const script: Command[] = [
      cmd(Tool.Road, 2, 2),
      cmd(Tool.Road, 2, 3),
      cmd(Tool.Road, 2, 4),
      cmd(Tool.Residential, 3, 2),
      cmd(Tool.Residential, 3, 3),
      cmd(Tool.Commercial, 3, 4),
      cmd(Tool.Industrial, 1, 3)
    ];
    expectAgreement('unpowered city economy', script, {
      ticks: 60,
      ignoreHeadline: WATER_PRODUCTION_DRIFT
    });
  });
});

describe('cross-engine parity — known drift, pinned not papered over', () => {
  it('the engine credits water production from a pump that is neither powered nor beside water', () => {
    // A pump alone in the middle of dry land: no plant, no line, no lake.
    const script = [cmd(Tool.WaterPump, 5, 5)];
    const withoutExclusion = replay(script, { ticks: 20, compareTiles: false });
    const predicates = withoutExclusion.map(d => d.predicate).sort();
    expect(
      predicates,
      `Only the water-production drift should survive here; anything else is new.\n${summarise(withoutExclusion)}`
    ).toEqual(['waterBalance', 'waterProduced']);
    const produced = withoutExclusion.find(d => d.predicate === 'waterProduced')!;
    expect(Number(produced.rust), 'the engine credits an idle pump').toBeGreaterThan(0);
    expect(Number(produced.ts), 'the oracle credits nothing').toBe(0);
  });

  it('the two engines disagree on whether a lot activates in a city with no water system', () => {
    // `Simulation::tick_fixed` gates the water requirement on
    // `state.has_water_system()` — "until the first pump/tower/pipe exists,
    // buildings don't need water". `simulation.ts` has no such gate: it passes
    // `waterEnabled: true` unconditionally, so every lot in a city that has
    // never seen a pipe sits at `InactiveNoWater`, drawing no power.
    //
    // Not fixed here. Closing it means changing `simulation.ts`, which moves
    // the committed goldens in `stateHash.test.ts` and the tolerance bands in
    // `regression.test.ts` — an oracle-calibration decision, not a test one.
    // Placement parity is unaffected: the tile facts still agree exactly, which
    // is what the assertion below records.
    const script: Command[] = [
      cmd(Tool.CoalPlant, 1, 1),
      cmd(Tool.Road, 3, 1),
      cmd(Tool.Road, 3, 2),
      cmd(Tool.Road, 3, 3),
      cmd(Tool.Road, 3, 4),
      cmd(Tool.Road, 3, 5),
      cmd(Tool.PowerLine, 3, 6),
      cmd(Tool.Residential, 4, 2),
      cmd(Tool.Residential, 4, 3),
      cmd(Tool.Commercial, 4, 4),
      cmd(Tool.Industrial, 4, 5)
    ];
    // 80 ticks — past the 40-tick growth delay and past the tick at which the
    // first lot's status is decided. Parity is exact at 70.
    const at70 = replay(script, { ticks: 70, ignoreHeadline: WATER_PRODUCTION_DRIFT });
    expect(at70.length, `parity should still be exact at 70 ticks\n${summarise(at70)}`).toBe(0);

    const at80 = replay(script, { ticks: 80, ignoreHeadline: WATER_PRODUCTION_DRIFT });
    const predicates = [...new Set(at80.map(d => d.predicate))].sort();
    expect(
      predicates,
      `Only the activation-gate drift should survive here; anything else is new.\n${summarise(at80)}`
    ).toEqual(['powerBalance', 'powerUsed']);
    const used = at80.find(d => d.predicate === 'powerUsed')!;
    expect(Number(used.rust), 'the engine has an active lot drawing power').toBeGreaterThan(0);
    expect(Number(used.ts), 'the oracle has the same lot sitting InactiveNoWater').toBe(0);
  });
});

describe('cross-engine parity — fuzz', () => {
  // The whole palette bar Inspect, which is a no-op both sides.
  const PALETTE: readonly Tool[] = [
    Tool.TerraformRaise,
    Tool.TerraformLower,
    Tool.Water,
    Tool.Tree,
    Tool.Road,
    Tool.Rail,
    Tool.PowerLine,
    Tool.WaterPipe,
    Tool.Residential,
    Tool.Commercial,
    Tool.Industrial,
    Tool.Park,
    Tool.ParkLarge,
    Tool.WaterPump,
    Tool.WaterTower,
    Tool.Bulldoze
  ];

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    it(`agrees over a 300-command random script (seed ${seed})`, () => {
      expectAgreement(`fuzz seed ${seed}`, fuzzScript(seed, 300, 10, PALETTE), {
        width: 10,
        height: 10
      });
    });
  }

  // The footprint tools, which the cheap palette leaves out because a 300-click
  // script would exhaust the treasury in twenty. Short scripts, bigger map:
  // this is aimed at the bounds and overlap guards, not at the economy.
  const FOOTPRINT_PALETTE: readonly Tool[] = [
    Tool.HydroPlant,
    Tool.CoalPlant,
    Tool.WindTurbine,
    Tool.SolarFarm,
    Tool.ElementarySchool,
    Tool.HighSchool,
    Tool.WaterTower,
    Tool.ParkLarge,
    Tool.Road,
    Tool.PowerLine,
    Tool.Bulldoze
  ];

  for (const seed of [31, 32, 33, 34, 35, 36]) {
    it(`agrees over a random footprint-building script (seed ${seed})`, () => {
      expectAgreement(`footprint fuzz seed ${seed}`, fuzzScript(seed, 60, 12, FOOTPRINT_PALETTE), {
        width: 12,
        height: 12
      });
    });
  }

  for (const seed of [21, 22, 23, 24]) {
    it(`agrees on the utility networks a random city settles into (seed ${seed})`, () => {
      // Under the 40-tick zone-growth delay on purpose — see the known-drift
      // test below for where growth takes the two engines apart.
      expectAgreement(`fuzz+tick seed ${seed}`, fuzzScript(seed, 150, 10, PALETTE), {
        width: 10,
        height: 10,
        ticks: 30,
        ignoreHeadline: WATER_PRODUCTION_DRIFT
      });
    });
  }
});
