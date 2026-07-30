# Gradual Population Decline

**Status:** regressed in the Rust migration. Audit item A5 in `docs/wasm-sim-audit.md`, still open.

## Purpose

Population moves toward its target at a bounded rate — people trickle in and trickle out. Demolishing a residential block should start an exodus, not teleport the census.

## Old behaviour

The TS sim clamped per-tick growth to ±2: `growth = clamp(desiredPop − pop, −2, 2)` (oracle: `app/src/game/simulation.ts:351-360` at `1f8140a`; oracle removed 2026-07-30, view with `git show 1f8140a:app/src/game/simulation.ts`). Cutting capacity below current population produced a visible decline over many ticks, giving the player time to notice and react, and giving the narrative/demand systems a real signal to describe.

## Current behaviour

`crates/city-sim-core/src/economy.rs:295-311` grows population demand-driven, then hard-clamps with `.min(pop_cap)` — bulldozing housing instantly deletes the overflow population in a single tick. Growth upward is rate-limited; decline is a step function. Undocumented outside the audit; no test pins either behaviour.

## Recovery

* Apply the same ±rate bound on the way down as on the way up (restore the old symmetric clamp, or choose a deliberate asymmetric pair — e.g. slower decline than growth — and document it in `docs/game-parameters.md`).
* Decide how tax revenue and demand read the transient over-capacity population (the old game simply let them see it; keep that unless it double-counts).
* Pin with a golden-city scenario: build housing, populate, bulldoze half, assert the decline curve rather than the cliff.

## Non-goals

* Migration modelling, homelessness mechanics, or per-building move-out animation — this is only the rate clamp.
