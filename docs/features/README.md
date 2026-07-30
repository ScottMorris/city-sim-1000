# Feature Docs

One document per feature: what it is, why it exists, what the code actually does today, and how it is (or will be) codified in tests and player-facing docs. Live design references, not archives — when behaviour changes, the doc changes in the same commit (see the docs rule in `AGENTS.md`). Collectively these are the raw material for a future proper manual.

## Shipped features

- [City Narrative](city-narrative.md) — the toggleable storytelling layer over simulation events.
- [Wilderness Score](wilderness-score.md) — the ecosystem-preservation metric and its consequences.

## Recovery docs (2026-07 migration audit)

The TS→Rust simulation migration and the tile-model PR stack (#186–#196) silently changed or dropped behaviour the game once had or promised. A full audit (branch `fix/bulldoze-underground-view`, 2026-07-30) produced one recovery doc per finding; each has a matching GitHub issue.

- [View Layers](view-layers.md) — strata vs data overlays as first-class, orthogonal state; the model the bulldozer fix builds on.
- [Layer-Scoped Bulldozer](layer-scoped-bulldozer.md) — the headline regression: the bulldozer must clear only what the active view shows.
- [Simulation Feedback Channel](sim-feedback-channel.md) — deficit alerts, command-result messages, and failure icons; several other fixes depend on this plumbing.
- [Water Source Gating](water-source-gating.md) — pumps need a water source; production accounting must respect building status.
- [Shore-Adjacency Placement](shore-adjacency-placement.md) — hydro/pump water-edge placement rules.
- [Population Decline](population-decline.md) — bounded decline instead of snap-to-capacity.
- [Lighting Bylaws](lighting-bylaws.md) — reconnect the bylaws UI to the engine.
- [Happiness and Abandonment](happiness-and-abandonment.md) — make the third decay input reachable, tunable, visible.
- [Growth Gating](growth-gating.md) — hard-gate promises vs soft-multiplier reality; pick one and document it.
- [Rail Benefit](rail-benefit.md) — give rail a reason to exist.
- [Terraform and Elevation](terraform-elevation.md) — decide what Raise/Lower/Water mean; elevation is currently dead data.
- [Desktop Building Identity](tauri-building-identity.md) — fixed; the Tauri wire shares WASM's exact SoA tile buffer and decode helpers, no client-side derivation left.
- [Documentation Truth Sweep](docs-truth-sweep.md) — the batch of places where docs, comments, or UI strings contradict the code.
