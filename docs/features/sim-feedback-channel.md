# Simulation Feedback Channel — Alerts, Command Results, and Failure Icons

**Status:** fixed (#199). Audit items B2 and B5 in `docs/wasm-sim-audit.md`, plus a renderer gate bug that compounded them, are resolved — all three paths described below are live on both bridges.

## Purpose

When the simulation refuses a command or the city starts failing, the player must be told. The TS-era game did this three ways: sticky deficit toasts, synchronous placement-failure messages, and per-building failure icons. The migration kept all the client-side display code and disconnected every one of its inputs — the game can now brown out, starve, and reject the player's clicks in total silence.

## The three broken paths

### 1. Utility deficit alerts never fire (B2) — fixed

* Promise: `app/public/manual.html` — "When power or water drops below zero you'll see a sticky warning toast; it clears with a follow-up notice once supply returns", plus persistent news-ticker alerts (`manual.html`, `SPEC.md`, `docs/game-parameters.md` all repeat it).
* Old: the TS sim ran a deficit state machine and raised alerts + narrative events (`app/src/game/simulation.ts:746-800` at `1f8140a`; oracle removed 2026-07-30, view with `git show 1f8140a:app/src/game/simulation.ts`).
* Fix: the edge-triggered deficit state machine now lives in `crates/city-sim-core/src/sim.rs`'s `Simulation::handle_resource_alerts` (ported from the TS oracle above), raising `city_sim_protocol::events::SimAlert`s into a `pending_alerts` queue drained once per host step/tick via `Simulation::take_alerts`. `SimHost::take_alerts_json` (WASM, forwarded through `wasmSim.worker.ts`'s `step_result`) and `TickEvent.alerts` (Tauri, built in `build_tick_event`) both carry it to `main.ts`'s previously-dead `Alert` handler. Each alert's paired ticker event (`power_deficit_start`/`_end` etc.) is derived TS-side, in `protocol/deficitNarrative.ts`'s `deriveNarrativeEventFromAlert` — shared by both bridges rather than reimplemented per transport.

### 2. Command results are swallowed (B5) — fixed

* Old: the in-process TS sim returned `ChangeResult` synchronously — a refused or underfunded placement produced an immediate toast.
* Was: both bridges were optimistic — `wasmSimBridge.send` always returned `{success: true}` and the real result arrived async as `apply_result`, where only the success flag crossed the worker boundary; Tauri's `apply_tool` was fire-and-forget with no result path at all.
* Fix: `send()` still answers synchronously/optimistically (the `SimBridge` interface contract), but the real result now reaches `main.ts` asynchronously as a `FromSim::CommandResult` message. WASM: `SimHost::last_apply_message` exposes the `CommandResult.message` Rust already computed, read by `wasmSim.worker.ts` right after `apply_tool` and forwarded by `wasmSimBridge.ts`. Tauri: `SimCmd::ApplyTool` gained a reply channel (`mpsc::SyncSender<CommandResult>`, mirroring the existing `Undo`/`Redo`/`GetSnapshot` pattern), so the `apply_tool` Tauri command — and `tauriSimBridge.ts`'s `.applyTool()` promise — now resolve with the real result instead of `void`. `main.ts`'s failure toast fires on the `CommandResult` message now, not on `bridge.send()`'s (still-optimistic) return value. Not done: correcting the immediate/optimistic SFX cue to match the async result — left as a known limitation, since it needs per-stroke correlation the drag-paint gesture model doesn't cleanly support yet.

### 3. The no-water icon is suppressed exactly when it's needed most — fixed

* Promise: `manual.html` — "Buildings without water will stop working and show a water-drop icon", and water becomes a requirement "until you place your first pump, water tower, or pipe".
* Was: the engine opts a city into the water requirement on pipes too (`crates/city-sim-core/src/state.rs:518-523`, `has_water_system`), but the renderer's icon gate only scanned for pump/tower templates, so a pipes-only city flipped every building to `InactiveNoWater` — production and growth stopped — with no icon, no alert, and no explanation anywhere in the UI.
* Fix: both bridges already mirrored `has_water_system` correctly (pipes included) as a side effect of the #177 TS/wire follow-up — a building can only ever reach `BuildingStatus.InactiveNoWater` when that mirror decided a water system exists. `app/src/rendering/renderer.ts`'s icon gate now reads that status directly instead of re-deriving "does the map have water infra" from a second, pump/tower-only template scan.

## Codifying

* Parity/golden scenarios that drive a city into power and water deficit and assert the emitted event stream.
* A bridge-level test that a refused `ApplyTool` surfaces its message on both transports.
* Keep `manual.html`'s promises as written — they describe the right game; the code should catch up to them.

## Non-goals

* New alert categories, alert history UI, or notification settings — restore the three broken paths first.
* Redesigning the narrative layer; it already consumes these events once they exist.
