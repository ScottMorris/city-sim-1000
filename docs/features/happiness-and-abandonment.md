# Happiness and Abandonment — Reconnect the Pipeline

**Status:** partially regressed, partially unreachable by construction. Audit item A7 in `docs/wasm-sim-audit.md` (now only partly stale) plus a drift ratified in the stack's oracle rewrite.

## Purpose

Tile happiness is supposed to be the third leg of decay: zones abandon when demand collapses, when power fails, or when tiles stay unhappy. The wilderness system's headline consequence ("a paved city does the opposite") flows through the same channel. Today that channel is connected at both ends and dead in the middle.

## Current behaviour

* The abandonment threshold is happiness < 0.4 (`crates/city-sim-core/src/buildings.rs:222, 334`).
* Tile happiness starts at 1.0 (`state.rs:150`). Its only movers: +0.05 on footprint-building placement (`commands.rs:499`), −0.1 on abandonment (`buildings.rs:404`), and the wilderness drift — whose target is clamped to `1.0 ± 0.2`, i.e. `[0.8, 1.2]` (`wilderness.rs:509-519`).
* Nothing can push a live lot below 0.8, so the unhappy-abandonment branch **never fires**, and the wilderness→happiness consequence advertised in `docs/features/wilderness-score.md` and `manual.html` ("Zones can abandon if... tiles are unhappy"; "unhappy tiles (<0.4 happiness) add pressure" in `game-parameters.md`) has no observable effect on decay.
* Two inputs were also lost in migration: the old per-placement +0.05 applied to **every** tool (terrain/zone/road/rail/line) via `setTile`, now only footprint buildings — ratified in the stack's oracle-rewrite commit body without a doc note; and the lighting bylaw's happiness nudge (see `lighting-bylaws.md`) is stubbed out entirely.

## Recovery

This is a tuning feature, not a port: the numbers never worked together, even before migration (A7 predates it — the audit called the branch "nearly unreachable" in Rust from day one).

1. Pick the intended dynamic range: either widen the wilderness drift target band so a heavily paved city can actually sink below 0.4, or move the threshold up, or add real negative inputs (pollution-adjacent industry, abandonment contagion via the existing −0.1, missing services). The wilderness score is the natural primary driver — it already computes a city-wide signal.
2. Reinstate (or deliberately retire) the small placement bump for non-building tools; if retired, note it in `game-parameters.md` so the ratification is on the record.
3. Route the lighting-bylaw happiness nudge through the same tuned scale when that feature lands.
4. Make happiness visible: the tile inspector shows Wet/Dry but never happiness, so the whole mechanic is invisible even where it works. A player cannot manage what they cannot see.

## Codifying

* A golden-city scenario that drives a city to unhappy-abandonment and asserts it happens — the test that is impossible to write today is the proof the feature exists.
* `game-parameters.md` gets the final constants: drift band, threshold, per-input deltas.

## Non-goals

* A full needs/services happiness model — only making the existing three-input pipeline reachable, tunable, and visible.
