# Simulation Feedback Channel — Alerts, Command Results, and Failure Icons

**Status:** regressed in the Rust migration. Audit items B2 and B5 in `docs/wasm-sim-audit.md`, plus a renderer gate bug that compounds them.

## Purpose

When the simulation refuses a command or the city starts failing, the player must be told. The TS-era game did this three ways: sticky deficit toasts, synchronous placement-failure messages, and per-building failure icons. The migration kept all the client-side display code and disconnected every one of its inputs — the game can now brown out, starve, and reject the player's clicks in total silence.

## The three broken paths

### 1. Utility deficit alerts never fire (B2)

* Promise: `app/public/manual.html` — "When power or water drops below zero you'll see a sticky warning toast; it clears with a follow-up notice once supply returns", plus persistent news-ticker alerts (`manual.html`, `SPEC.md`, `docs/game-parameters.md` all repeat it).
* Old: the TS sim ran a deficit state machine and raised alerts + narrative events (`app/src/game/simulation.ts:746-800`, still in the oracle).
* Now: no Rust code constructs `FromSim::Alert` — `app/src/main.ts:441-447` is a dead handler, and the `power_deficit_*` narrative event types (`narrative/types.ts:6-9`) have no producer.
* Recovery: port the deficit state machine into the engine tick, emit `Alert` events over both bridges (WASM worker message + Tauri channel), and reconnect the toast/ticker/narrative consumers that are already sitting there waiting.

### 2. Command results are swallowed (B5)

* Old: the in-process TS sim returned `ChangeResult` synchronously — a refused or underfunded placement produced an immediate toast.
* Now: both bridges are optimistic — `wasmSimBridge.send` always returns `{success: true}` (`wasmSimBridge.ts:257`) and the real result arrives async as `apply_result`, where only the success flag crosses the worker boundary; `tauriSimBridge` is optimistic the same way. `main.ts:732`'s failure toast can never fire on the production paths.
* Recovery: route the async `apply_result` (success **and** message) back into the toast/SFX path keyed by stroke, so "Not enough funds" / "Bulldoze first" reach the player again. This is also a prerequisite for the layer-scoped bulldozer's "Nothing to demolish here" no-op message (see `layer-scoped-bulldozer.md`).

### 3. The no-water icon is suppressed exactly when it's needed most

* Promise: `manual.html` — "Buildings without water will stop working and show a water-drop icon", and water becomes a requirement "until you place your first pump, water tower, or pipe".
* Now: the engine opts a city into the water requirement on pipes too (`crates/city-sim-core/src/state.rs:518-523`, `has_water_system`), but the renderer's icon gate only scans for pump/tower templates (`app/src/rendering/renderer.ts:571-580`), so a pipes-only city flips every building to `InactiveNoWater` — production and growth stop — with no icon, no alert (path 1 is dead), and no explanation anywhere in the UI. This is the worst compound failure of the three: two independent regressions overlapping to make a fully silent city-killer.
* Recovery: make the renderer's gate ask the same question as the engine (mirror `has_water_system` — pipes included), ideally by reading an engine-provided flag rather than re-deriving it client-side.

## Codifying

* Parity/golden scenarios that drive a city into power and water deficit and assert the emitted event stream.
* A bridge-level test that a refused `ApplyTool` surfaces its message on both transports.
* Keep `manual.html`'s promises as written — they describe the right game; the code should catch up to them.

## Non-goals

* New alert categories, alert history UI, or notification settings — restore the three broken paths first.
* Redesigning the narrative layer; it already consumes these events once they exist.
