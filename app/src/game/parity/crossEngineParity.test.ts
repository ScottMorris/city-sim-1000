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
 *   activation gate pinned in "known drift". Both are listed, both are pinned by
 *   a test that fails when the underlying disagreement goes away, and both are
 *   written out in full where they are declared.
 * - **the headline scalars on the two long deterministic scenarios** — a
 *   numeric-representation difference rather than a logic one, written out at
 *   `COMPARE_TILES_ONLY`. Every other scenario compares them exactly.
 * - **which lot zone growth picks, past about 110 ticks** — two independent RNG
 *   streams that only stay in step while their draw counts do. Measured and
 *   written out at `SERVICED_CITY`, which is also where the coverage of
 *   `developed`, `powered`, `watered` and `abandoned` is explained.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Engine, initWasm, rustEngine, tsEngine } from './engines';
import { cmd, Command, fuzzScript, replay, ReplayOptions, settle, summarise } from './replay';
import { Tool } from '../toolTypes';

beforeAll(async () => {
  await initWasm();
});

/** Assert two engines agree, printing every disagreement when they do not. */
function expectAgreement(label: string, script: Command[], opts: ReplayOptions = {}): void {
  const found = replay(script, opts);
  expect(found.length, `${label}\n${summarise(found)}`).toBe(0);
}

/**
 * Replay `script` on a fresh pair of engines and hand them back, so a scenario
 * can assert what state was *reached* and not only that the two agree on it.
 *
 * Agreement on its own is a weak claim for anything that has to happen over
 * time: two engines that both grew nothing agree perfectly. Honours `settle` the
 * same way `replay` does.
 */
function driveBoth(script: Command[], width = 12, height = 12, seed = 7): Engine[] {
  const engines = [rustEngine(width, height, seed), tsEngine(width, height, seed)];
  for (const engine of engines) {
    for (const c of script) {
      engine.apply(c.tool, c.x, c.y);
      for (let n = 0; n < (c.settle ?? 0); n++) engine.tick();
    }
  }
  return engines;
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

/**
 * Tiles compared, headline not — the option the two long deterministic scenarios
 * below pass, and why they pass it — a *representation* difference, not a logic one, and the reason it
 * only shows up over long runs.
 *
 * The two engines hold the ledgers in different numeric types. Rust keeps
 * `utilities.power_used` / `water_used` as `i32` and money as an `i64` plus a
 * separate `money_frac`; TypeScript keeps all of them as floats. Every
 * individual figure is the same to within a rounding step — `powerUse` is 1.5
 * for a house and 2.5 for a shop, so an odd number of active lots reads 8.5 in
 * the oracle and 9 in the engine — but the residues accumulate, and over 90
 * ticks of daily maintenance the whole-credit part of money crosses a boundary
 * too (measured: 73 756 against 73 757.15, one credit apart).
 *
 * None of that is drift in the mirror, so it is not pinned as one; it is also
 * not something these two scenarios are for. The headline scalars are compared
 * **exactly** by the short scenarios above and by all 26 fuzz scenarios, where
 * the run is brief enough that no residue has accumulated. What the long ones
 * add is the four *tile* facts — `developed`, `powered`, `watered`, `abandoned`
 * — and those are compared in full.
 */
const COMPARE_TILES_ONLY: ReplayOptions = { compareHeadline: false };

/**
 * A city with hydro, water and road access, on a 12×12 map — the prelude that
 * puts the *service* facts within reach of a scenario.
 *
 * ## Why this exists
 *
 * Four of the twelve `TileFacts` predicates — `powered`, `watered`, `developed`,
 * `abandoned` — belong to `buildings/manager.ts` and the two utility mirrors,
 * which is half of the drift this file's header names as its reason for
 * existing. The original fuzz families could reach none of them: no palette
 * contained a power source, so nothing was ever `powered`; and the two placement
 * families run zero ticks while the third stops at 30, under the 40-tick growth
 * delay, so nothing was ever `developed`, `watered` or `abandoned`. The stated
 * purpose and the actual coverage disagreed.
 *
 * A wider palette on its own does not close that. A 300-click script drawn from
 * a palette with a plant in it spends the treasury in twenty commands and then
 * measures refusals, and it only builds a *working* network by luck. A fixed
 * prelude does it in nine commands and every time.
 *
 * ## Why the pump stands on a lake shore
 *
 * `WATER_PRODUCTION_DRIFT` is not only a headline exclusion: the oracle credits
 * a pump's output only when it is `Active` *and* beside natural water, and the
 * water *balance* feeds `applyZoneGrowthForType`'s growth probability. A pump on
 * dry ground therefore makes which lots develop a downstream consequence of a
 * pinned drift instead of a parity question. Powered, and on a shore, both
 * engines credit the same 50 units.
 *
 * ## What still cannot be fuzzed, and why — measured, not assumed
 *
 * Zone growth is a Fisher-Yates shuffle plus a per-candidate probability roll,
 * drawn from `SeededRng` in TypeScript and the deliberately matching `rng.rs` in
 * Rust. The two streams stay in step only while the *number of draws* does, and
 * the draw count depends on the candidate list, on `utilityFactor` (0.15 for an
 * unpowered lot, 0.35 for an unwatered one) and therefore on the utility
 * balances. Two things were measured rather than assumed:
 *
 * - **Under a random script, growth diverges immediately.** With this prelude
 *   plus 80 fuzz commands and then 90 ticks, two of four seeds disagreed on
 *   `developed` for two tiles each. Every one traced back to a random click
 *   knocking out the pump or the plant and the two pinned drifts then moving one
 *   engine's water balance, not to anything new.
 * - **Even undisturbed, growth diverges past about 110 ticks.** This prelude on
 *   its own agrees exactly at 90 and at 100 ticks; at 120 the two engines have
 *   grown different lots (TypeScript takes (5,4) and (1,7), Rust takes (2,7)).
 *   That is the RNG streams falling out of step as the city starts abandoning and
 *   regrowing, and it is a real limit of the oracle rather than of this file.
 *
 * So the two deterministic scenarios below stop at **90 ticks**, inside the
 * window where growth selection is reproducible across the language boundary,
 * and the fuzz families stop at 30, under the growth delay — which is why they
 * still pass `ticks: 30` and why they compare `powered` and `watered` but not
 * `developed`. `docs/testing.md` carries the 110-tick ceiling in its gap table;
 * closing it means making one engine's RNG consumption match the other's
 * exactly, which is an oracle-calibration change and moves committed goldens.
 */
const SERVICED_CITY: Command[] = [
  // A coal plant, its spur, and two crossing streets that carry the power:
  // roads conduct, so the whole grid is one network.
  cmd(Tool.CoalPlant, 0, 0),
  cmd(Tool.PowerLine, 2, 1),
  cmd(Tool.PowerLine, 3, 1),
  ...Array.from({ length: 12 }, (_, y) => cmd(Tool.Road, 4, y)),
  ...Array.from({ length: 12 }, (_, x) => cmd(Tool.Road, x, 6)),
  // A lake, and a pump on its shore, piped into the grid.
  cmd(Tool.Water, 6, 8),
  cmd(Tool.Water, 7, 8),
  cmd(Tool.Water, 6, 9),
  cmd(Tool.Water, 7, 9),
  cmd(Tool.WaterPump, 5, 8),
  cmd(Tool.WaterPipe, 5, 7),
  cmd(Tool.WaterPipe, 5, 6),
  // Zones on both streets. Every one has road access, so they develop rather
  // than sitting vacant.
  cmd(Tool.Residential, 3, 0),
  cmd(Tool.Residential, 3, 2),
  cmd(Tool.Residential, 3, 4),
  cmd(Tool.Commercial, 5, 0),
  cmd(Tool.Commercial, 5, 2),
  cmd(Tool.Commercial, 5, 4),
  cmd(Tool.Industrial, 0, 7),
  cmd(Tool.Industrial, 1, 7),
  cmd(Tool.Industrial, 2, 7)
];

/** The nine zoned lots of {@link SERVICED_CITY}, as tile indices on a 12-wide map. */
const SERVICED_LOTS: readonly number[] = [
  0 * 12 + 3,
  2 * 12 + 3,
  4 * 12 + 3,
  0 * 12 + 5,
  2 * 12 + 5,
  4 * 12 + 5,
  7 * 12 + 0,
  7 * 12 + 1,
  7 * 12 + 2
];

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

  it('develops every lot of a serviced city, in both engines', () => {
    // The positive half of the `developed` / `powered` / `watered` coverage the
    // fuzz families cannot reach — see `SERVICED_CITY`. Agreement alone would
    // not be enough here: two engines that both grew nothing would agree
    // perfectly, so the reached states are asserted directly as well.
    const script: Command[] = [...SERVICED_CITY, settle(90)];
    expectAgreement('serviced city, grown', script, {
      width: 12,
      height: 12,
      ...COMPARE_TILES_ONLY
    });

    for (const engine of driveBoth(script)) {
      const facts = engine.facts();
      const built = SERVICED_LOTS.filter(i => facts[i].developed);
      // Not all nine. Residential demand falls as the lots fill, and the run
      // stops at 90 ticks for the reason `SERVICED_CITY` gives, so four is what
      // this window builds — identically in both engines, which is what the
      // agreement check above has already established. Four is a floor to catch
      // the scenario silently stopping, not a measurement of anything.
      expect(
        built.length,
        `${engine.name} grew only ${built.length} of ${SERVICED_LOTS.length} serviced lots, so ` +
          'this scenario is no longer exercising development'
      ).toBeGreaterThanOrEqual(4);
      for (const lot of built) {
        expect(facts[lot].powered, `${engine.name} left developed lot ${lot} unpowered`).toBe(true);
        expect(facts[lot].watered, `${engine.name} left developed lot ${lot} unwatered`).toBe(true);
      }
    }
  });

  it('abandons what it built when the city loses its only power plant', () => {
    // `abandoned` is the last of the four service facts, and the only route to
    // it is a live city that then goes wrong. The plant is razed after the lots
    // have grown; `troublePowerPenalty` is 3.0 a tick against an abandon
    // threshold of 12, so twelve ticks is comfortably past the turn and well
    // short of the 40-tick delay before a vacated lot may regrow — which is what
    // keeps this deterministic, because regrowth is the RNG roll `SERVICED_CITY`
    // explains cannot be compared.
    const script: Command[] = [
      ...SERVICED_CITY,
      settle(90),
      cmd(Tool.Bulldoze, 0, 0),
      settle(12)
    ];
    expectAgreement('serviced city, cut off', script, {
      width: 12,
      height: 12,
      ...COMPARE_TILES_ONLY
    });

    for (const engine of driveBoth(script)) {
      const facts = engine.facts();
      const abandoned = SERVICED_LOTS.filter(i => facts[i].abandoned).length;
      expect(abandoned, `${engine.name} abandoned nothing after losing its hydro`).toBeGreaterThan(
        0
      );
    }
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

  /**
   * The footprint tools, which the cheap palette leaves out because a 300-click
   * script would exhaust the treasury in twenty. Short scripts, bigger map: this
   * family is aimed at the bounds, overlap and road-access guards, not at the
   * economy.
   *
   * ## Why it carries the carriageways and the zones too
   *
   * `buildings/manager.ts` is half of the drift this file's header names as its
   * reason for existing, and it owns two things: where a footprint may be
   * stamped, and what happens to it on every tick afterwards. A palette of
   * nothing but stamps reaches the first and not the second — a plant with no
   * road beside it and no line out of it is refused or inert, so the per-tick
   * status path never runs on anything this family built.
   *
   * So the palette carries `Road`, `Rail`, `PowerLine` and `WaterPipe` to wire
   * what it stamps, and the three zones to give the stamps neighbours. Measured
   * against the narrower palette this replaced, over the same six seeds: accepted
   * commands 130 → 202, structure tiles 200 → 217, powered tiles 80 → 128.
   *
   * ## Why it ticks, and why only 30
   *
   * Every fuzz family here once ran zero ticks or drew from a palette with no
   * power source in it, so no fuzz scenario ever reached a *built* footprint that
   * the tick loop had then looked at. Thirty ticks fixes that — it is past the
   * point `updateBuildingStatuses` decides a plant's output and a lot's road
   * access, and under the 40-tick zone-growth delay, which is where the two
   * engines' RNG streams start to matter. `SERVICED_CITY` sets out why nothing in
   * this file fuzzes past that delay.
   *
   * `watered` stays out of reach here and is *not* claimed: the palette has no
   * `Tool.Water`, so a pump or tower it stamps never stands beside natural water.
   * That fact is the serviced-city family's ground, not this one's.
   */
  const FOOTPRINT_PALETTE: readonly Tool[] = [
    Tool.HydroPlant,
    Tool.CoalPlant,
    Tool.WindTurbine,
    Tool.SolarFarm,
    Tool.ElementarySchool,
    Tool.HighSchool,
    Tool.WaterTower,
    Tool.WaterPump,
    Tool.ParkLarge,
    Tool.Road,
    Tool.Rail,
    Tool.PowerLine,
    Tool.WaterPipe,
    Tool.Residential,
    Tool.Commercial,
    Tool.Industrial,
    Tool.Bulldoze
  ];

  for (const seed of [31, 32, 33, 34, 35, 36]) {
    it(`agrees over a random footprint-building script (seed ${seed})`, () => {
      const script = fuzzScript(seed, 60, 12, FOOTPRINT_PALETTE);
      expectAgreement(`footprint fuzz seed ${seed}`, script, {
        width: 12,
        height: 12,
        ticks: 30,
        ignoreHeadline: WATER_PRODUCTION_DRIFT
      });

      // Agreement alone would not show this family still reaches what the
      // palette was widened for: a random script that built nothing, or built it
      // and left it dark, agrees perfectly. So the reached state is asserted, in
      // both engines, the same way the serviced-city scenarios do it.
      //
      // The floors are deliberately far below what is measured — every one of
      // the six seeds reaches at least 33 structure tiles and 20 powered ones in
      // both engines — because their job is to catch this family going quiet, not
      // to pin a number that a harmless change to the palette would move.
      for (const engine of driveBoth([...script, settle(30)], 12, 12)) {
        const facts = engine.facts();
        const structures = facts.filter(f => f.structure).length;
        const powered = facts.filter(f => f.powered).length;
        expect(
          structures,
          `${engine.name} stamped only ${structures} footprint tiles from seed ${seed}, so this ` +
            'family is no longer exercising placement'
        ).toBeGreaterThanOrEqual(8);
        expect(
          powered,
          `${engine.name} left every tile of seed ${seed} unpowered, so this family is no longer ` +
            'exercising the per-tick status path in buildings/manager.ts'
        ).toBeGreaterThanOrEqual(4);
      }
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

  // A serviced city, then a random script over it. This is the family that
  // reaches `powered` and `watered` — see `SERVICED_CITY` for why the three
  // families above cannot, and `docs/testing.md` for the two facts that stay out
  // of reach of any fuzz.
  for (const seed of [41, 42, 43, 44] as const) {
    it(`agrees on the networks of a serviced city put through a random script (seed ${seed})`, () => {
      expectAgreement(
        `serviced-city fuzz seed ${seed}`,
        [...SERVICED_CITY, ...fuzzScript(seed, 80, 12, PALETTE)],
        {
          width: 12,
          height: 12,
          // Under the 40-tick growth delay, deliberately: see `SERVICED_CITY`.
          ticks: 30,
          ignoreHeadline: WATER_PRODUCTION_DRIFT
        }
      );
    });
  }
});
