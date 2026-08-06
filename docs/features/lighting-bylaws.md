# Lighting Bylaws — Reconnect Policy to Simulation

**Status:** fixed. `Policies` gained `lighting: LightingPolicy` (CSIM snapshot `VERSION = 7`); the bylaw is engine-owned, engine-simulated, and set over the wire like `budget`/`wilderness` already were.

## Purpose

City-wide lighting policy is a real trade-off lever: energy-efficient lighting trims power draw and upkeep at a small happiness cost; decorative lighting does the reverse. It is the game's first bylaw and the template for every future one, so the plumbing matters more than the numbers.

## Current behaviour

* `LightingPolicy` (`crates/city-sim-protocol/src/commands.rs`) is a three-way enum — `Mixed` (neutral default), `Efficient`, `CarbonArc` — living on `Policies::lighting` alongside `budget`/`wilderness`, so it rides the same `SetPolicies` command and the same CSIM snapshot as the rest of engine state.
* `crates/city-sim-core/src/economy.rs` scales civic + zone maintenance by `LightingPolicy::maintenance_multiplier()`; `crates/city-sim-core/src/sim.rs` scales civic + zone power draw by `power_use_multiplier()`. Power-plant maintenance/output is untouched by the bylaw either way (`lighting_bylaw_scales_civic_and_zone_maintenance_only`, `economy.rs`).
* `app/src/game/bylaws.ts` is the TS-side *display* table only — labels, ledes, and `previewLightingPolicy`'s preview arithmetic for the Bylaws modal, mirroring `LightingPolicy::power_use_multiplier`/`maintenance_multiplier` by hand (pinned against the Rust values by `commands::tests::non_default_lighting_policies_are_not_neutral`). It no longer owns any simulated state — `ClientState` (`clientState.ts`) has dropped the old `bylaws` field entirely.
* Selecting a standard in the Bylaws modal (`app/src/ui/bylawsModal.ts`'s `onSelectLighting`) mutates `state.policies.lighting` and sends `setPoliciesCmd(state.policies)` (`main.ts`) — the same one-command path budget/wilderness policy changes already used.
* A legacy save's old client-side `bylaws.lighting` field (from before the move) is folded into engine `Policies` on import via `extractLegacyLightingPolicy` (`bylaws.ts`), consumed by `persistence.ts`'s `transcodeLegacySave`.

## Recovery

Done — see *Current behaviour*. `docs/game-parameters.md` and `app/public/manual.html`'s claims about the lighting bylaw having live effect are accurate as written; no further prose changes needed on their account.

## Codifying

* `crates/city-sim-core/src/economy.rs`: `lighting_bylaw_scales_civic_and_zone_maintenance_only`, `default_lighting_policy_reproduces_neutral_maintenance`.
* `crates/city-sim-protocol/src/commands.rs`: `default_lighting_policy_is_mixed_and_neutral`, `non_default_lighting_policies_are_not_neutral`, `lighting_policy_round_trips_postcard`.

## Non-goals

* District-level lighting overrides — the bylaws modal's UI already flags this as "coming soon"; the wire/command shape is a single city-wide `Policies::lighting` value, not yet a per-district list/map.
