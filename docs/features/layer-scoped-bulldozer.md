# Layer-Scoped Bulldozer

**Status:** regressed — design intent documented but not implemented in the Rust engine. This document is the recovery plan.

## Purpose

The bulldozer clears **what the player can see, at the layer they are looking at** — and nothing else. From the surface view it razes buildings, roads, rail, zones, trees, and overhead lines. From the underground view it removes pipes (and, later, subway and fibre). It never reaches across a layer boundary, because a change the player cannot see is a change they cannot predict, verify, or undo with confidence.

This rule has been the design position since the strata model was written — `docs/tile-model.md` (§"The bulldozer works on what you can see"): *"Underground occupants are only removable from the underground view."* The TS-era game honoured it; the Rust migration lost it.

## Current behaviour (the defect)

`bulldoze()` in `crates/city-sim-core/src/commands.rs` is **view-blind**. It applies a fixed precedence regardless of what the player is looking at:

1. a building on the tile → remove the building;
2. else, anything in the underground stratum → clear underground;
3. else → clear surface + overhead, drop the abandoned flag.

Consequences, all reachable today from the ordinary surface view:

* Clicking a tile that carries only a buried pipe **silently destroys the pipe**. Nothing visible changes on screen; the player just paid a credit and cut their water network.
* Clicking a road with a pipe under it takes the **pipe first** (invisible), and needs a second click for the road the player was aiming at.
* Symmetrically, from the underground view, a tile whose underground is empty falls through to branch 3 and **razes the dimmed surface** the player is not meaningfully looking at.

The engine even documents the assumption it cannot enforce — a comment beside branch 2 says underground "is only editable from the underground view", but no view information ever reaches the engine.

### Why it regressed

The active view lives in **client-side settings** (`state.settings.minimap.mode`, persisted in `ClientState`), and `SimCommand::ApplyTool { tool, x, y }` carries no layer field. The engine *cannot* be view-aware today. The pre-migration TS sim could cheat — it ran in-process and read `settings.minimap.mode` directly inside the `Tool.Bulldoze` handler (see `git show main:app/src/game/tools.ts`, which cleared only underground when the mode was `'underground'`). When the simulation moved behind the WASM/Tauri bridge, that read became impossible, the Rust side shipped precedence-based bulldozing, and the oracle rewrite then deleted the TS view check to match. Each step was locally consistent; the feature fell through the seam.

The lesson to codify: **any rule that depends on what the player is looking at must travel over the wire as part of the command.** Client-side "settings" are invisible to the engine by construction.

## Proposed design

### One tool, layer-scoped by the wire

No separate "underground bulldozer" tool — that trades an invisible defect for permanent player-facing complexity. The single Bulldoze tool acts on the **active stratum**, and the stratum is an explicit field on the command:

```
ApplyTool { tool, x, y, stratum }   // stratum: Surface (default) | Underground
```

* `stratum: Surface` → branch on building → else clear surface + overhead (+ clear abandoned). **Never touches underground.**
* `stratum: Underground` → clear the underground stratum only (the whole stratum, not just `Pipe` — `Subway` and `Fibre` bits are already reserved in `occupants.rs`). **Never touches building/surface/overhead.**
* Non-bulldoze tools ignore the field for now (see Interactions), but it is defined for every `ApplyTool` so future underground networks get it for free.

The client fills `stratum` from the active view at click time. The engine stays deterministic and view-agnostic in the honest sense: it doesn't know about *views*, it knows about the *stratum the command names* — which keeps replay, undo, parity, and the golden-city fixtures exact.

### No-op semantics

Bulldozing a tile with nothing in the targeted stratum should **not charge** (today the credit is deducted before the branch, so razing bare land costs 1). Restore the old TS behaviour: free no-op. Decide explicitly whether the no-op reports `success: true` (silent — but then the demolition SFX and "Demolition crews active" narrative event fire for a click that did nothing) or `success: false` with a message ("Nothing to demolish here"). Recommendation: `success: false` + message, so SFX/narrative stay truthful; note that on the WASM path only the success flag crosses the worker boundary today, so surfacing the message is a small follow-on.

### Interactions and edge cases

* **Right-button quick-bulldoze** (`main.ts` pointer handlers) calls `setActiveTool` directly and never touches the view — correct: it should bulldoze the stratum of whatever view is open, which the wire field now expresses. This path must set `stratum` from the live view just like the toolbar path.
* **The `water` minimap overlay also renders pipe tint** on the surface view. Overlays are read-only data filters, not edit layers — the bulldozer's scope follows the **active stratum**, never the overlay. (See the companion `view-layers.md` feature doc for the stratum-vs-overlay taxonomy; that doc proposes promoting the active stratum out of `MinimapMode` into first-class app state, which this feature should build on.)
* **Undo/redo**: snapshot-based history wraps `apply_tool` in both hosts, so layer-scoped bulldozing is automatically undoable. The stroke id stays a transport-level concern.
* **MCP bridge** (`mcpBridge.ts`) constructs `ApplyTool` literals for point/line/rect and has no view state; it must pass `stratum` explicitly (default `Surface`, with an option to target underground).
* **Buildings** remain surface-stratum objects: `stratum: Surface` on a building tile removes the building exactly as today.

### Codifying the rule so it can't get lost again

* **Golden-city scenarios**: pipe-under-road bulldozed from surface leaves the pipe; same tile bulldozed with `stratum: Underground` leaves the road; empty-stratum bulldoze charges nothing. The cross-engine parity harness that used to carry an equivalent scenario ("agrees on what a bulldozer click reaches when a pipe is buried below", in the now-deleted `crossEngineParity.test.ts`) was retired 2026-07-30 along with the TS oracle (preserved at commit `1f8140a`); pin these cases in `golden_city.rs`/`golden_city.script` instead.
* **Golden-city fixtures**: the "pipe buried under a road" scenario in `crates/city-sim-core/tests/golden_city.rs` pins the new behaviour; regenerate `golden_city.expected`.
* **Docs**: update `docs/tile-model.md`'s bulldozer section from design-intent to implemented-and-tested, and `app/public/manual.html`'s bulldozer entry to state the visible-layer rule as a player promise. Fix the stale comment at `crates/city-sim-core/src/occupants.rs:1329-1332`, which claims underground occupants are "only reachable from the underground view" — the invariant the engine assumes but cannot currently enforce.

## Touch list (implementation survey)

Protocol: `crates/city-sim-protocol/src/commands.rs` (`SimCommand::ApplyTool`), TS mirror `app/src/game/protocol/commands.ts` (`applyToolCmd` + all call sites). Transports: `wasmSimBridge.ts` payload + `wasmSim.worker.ts` + `crates/city-sim-wasm/src/lib.rs` `apply_tool` signature; `tauriSimBridge.ts` + `crates/tauri-plugin-city-sim/guest-js/index.ts` + `crates/tauri-plugin-city-sim/src/commands.rs` (`SimCmd::ApplyTool`). Engine: `crates/city-sim-core/src/commands.rs` (`apply_tool`, `bulldoze`) + unit tests. Client: `main.ts` (both the toolbar click path and the right-button quick-bulldoze path). Oracle: `app/src/game/tools.ts` Bulldoze handler + `applyTool` signature. Harnesses: `golden_city.rs` + expected fixture, `soak.rs` (the cross-engine parity harness that used to be listed here was retired 2026-07-30, see above). Bridges: `mcpBridge.ts`.

## Non-goals

* A separate underground bulldozer tool or toolbar entry.
* Per-occupant selective demolition within a stratum (clear-the-stratum is the unit for now; revisit when subway/fibre ship).
* Refunds for demolished infrastructure.
* Terrain changes of any kind — the bulldozer restores a tile *to its terrain*; that rule (#177 step 4) is settled and untouched here.
