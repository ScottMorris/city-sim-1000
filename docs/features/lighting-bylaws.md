# Lighting Bylaws — Reconnect Policy to Simulation

**Status:** regressed in the Rust migration (known-deferred, never picked back up). Audit item A6 in `docs/wasm-sim-audit.md`, priority P1. The UI ships and does nothing.

## Purpose

City-wide lighting policy is a real trade-off lever: energy-efficient lighting trims power draw and upkeep at a small happiness cost; decorative lighting does the reverse. It is the game's first bylaw and the template for every future one, so the plumbing matters more than the numbers.

## Old behaviour

The TS sim applied the active policy every tick: scaled zone/civic power use and maintenance and nudged tile happiness toward the policy's target (`applyLightingPolicy`, oracle `app/src/game/simulation.ts:152-154, 281-343`). `docs/game-parameters.md` documents it as live ("trims civic/zone power use (~18%) and upkeep (~10%)"), and `app/public/manual.html` promises "toggles apply immediately".

## Current behaviour

* `BylawState` exists only in TS client state (`app/src/game/bylaws.ts`, persisted via `clientState.ts`) — the engine never hears about it.
* No `SimCommand` carries bylaws: `SetPolicies` has budget/wilderness fields only.
* `crates/city-sim-core/src/economy.rs:31-32, 47-48` stubs the lighting multiplier to 1.0 with a "not yet ported (P3-9+)" comment.
* Yet the Bylaws modal (`app/src/ui/bylawsModal.ts`) still ships, still shows projected power-demand and upkeep deltas (`bylawAnalytics.ts` computes them from the dead TS constants), and still lets the player commit. Power draw, upkeep, and happiness are all identical afterward. The UI is lying with specific numbers.

## Recovery

1. Extend `SetPolicies` (or add `SetBylaws`) on the wire, both TS and Rust protocol sides, and both transports.
2. Port `applyLightingPolicy` into the engine tick: power/maintenance multipliers in `economy.rs`, happiness drift toward the policy target. Note the happiness end interacts with the decay-threshold problem tracked in `happiness-and-abandonment.md` — port the mechanism, tune the targets there.
3. Move bylaw state into the engine snapshot (it is engine-owned state per the persistence rule in `CLAUDE.md`; bump the CSIM snapshot version) or, if kept client-owned, re-send on load — decide explicitly. Engine-owned is recommended: the sim reads it every tick.
4. Keep `bylawAnalytics.ts`'s projections, but source the constants from the same place the engine uses (`tileKindParity.json`-style export or protocol constants) so the modal can't drift from the sim again.
5. Interim mitigation if the port waits: mark the modal as inert ("coming soon") rather than showing live-looking deltas.

## Codifying

* Golden-city scenario: same city, each policy, assert distinct power/upkeep totals.
* Parity scenario once the oracle grows the same path.
* `docs/game-parameters.md` and `manual.html` already describe the target behaviour — leave them, make them true.

## Non-goals

* New bylaw types — but the wire/command shape should be a list/map, not a lighting-specific field, so the next bylaw is data.
