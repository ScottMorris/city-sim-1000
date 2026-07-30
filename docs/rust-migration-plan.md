# Rust Simulation Engine — Migration Plan

**Status**: Planning · **Owner**: Scott · **Supersedes**: the brainstorm suite in
`~/Documents/Liminal HQ/City Sim 1000/Rust Migration/city-sim-migration-docs-here/`

This is the reality-anchored plan. The brainstorm docs are a good *menu* of ideas but
predate the current codebase (≈ Feb 2025) and describe an app that no longer exactly
exists. Where they conflict with the code today, the code wins and this doc says so.

---

## 1. Goals (agreed)

The move to Rust is justified by **all** of these together, which is why the full
core/protocol/dual-transport investment is warranted:

1. **Performance / bigger maps** — escape the single-threaded TS sim; tight memory layout.
2. **Determinism & replays** — shareable seeds, replay files, reproducible bug reports as
   real player-facing features.
3. **Longevity / correctness** — a typed, tested engine that outlives UI churn.
4. **Native Tauri v2** — run the sim core natively on desktop hardware, not just WASM.

**Targets**: Web (PWA, WASM-in-Worker) **and** Desktop (Tauri v2, native Rust).
**End state of the TS sim**: fully replaced. Rust `city-sim-core` becomes canonical; the TS
sim is deleted once parity holds (kept only transiently as a dev oracle — see §7).

---

## 2. Where the app actually is today

- **~11k LOC TS, no framework.** `main.ts` is the composition root: builds HUD DOM,
  wires input, owns one `GameState`, drives `requestAnimationFrame`.
- **The sim is already `step()`-shaped.** `Simulation.update(dt)` is a fixed-timestep
  accumulator calling `tick()`. `tick()` runs systems in a fixed sequence
  (power → water → zone growth → building states → power/water again → education →
  one big maintenance/capacity/demand/economy pass). Two clean side channels already
  exist: `notify(alert)` and `onNarrativeEvent(event)`.
- **Determinism is almost free.** The *only* nondeterminism in the sim is **two
  `Math.random()` calls** in `spawnZoneBuildings` (a Fisher–Yates shuffle + a growth
  roll). `Date.now()` only appears in the narrative/alert layer, which is UI-side.
- **Rendering reads `state.tiles` directly every frame** (PixiJS, 60 Hz) while the sim
  ticks at a lower rate. This coupling is the crux of the boundary design (§4).
- **Water is fully implemented** — `water.ts` is a complete BFS flood-fill (pumps source,
  pipes conduct, towers extend); `waterEnabled` gate is on. Power deficit *and* water
  deficit alerts are both wired (`waterDeficitActive` flag, `water_deficit_start/end`
  events). Port it as-is; don't redesign.
- **`applyTool(state, tool, x, y)`** in `tools.ts` holds the real placement *rules*
  (cost, road access, overwrite/clear semantics) and mutates state. This is a
  substantial body of logic that must move into Rust — the brainstorm protocol only
  shows the trivial `PlaceTile` and underplays it.

## 3. Corrections to the brainstorm docs

| Brainstorm doc says | Reality / our decision |
|---|---|
| `GameState` has `seed`/RNG | It does **not** — add seeded RNG as step one. |
| `budgetHistory: { daily, monthly }` | Actually `{ daily, lastRecordedDay }`. |
| Avoid `Record<string,number>` (hand-waved) | Budget breakdown really uses `powerByType`/`civicByType`/`zonesByType` maps. Decide: intern to a fixed enum table (preferred) vs `HashMap`. |
| Narrative / services / serviceDistribution / bylawAnalytics | **Absent from docs entirely** — they exist and must be accounted for. Narrative stays UI-side, fed by the event channel. |
| `TileKind` numeric mapping is canonical | `TileKind` is a **string enum** today. The u8 mapping must be defined once in `city-sim-protocol` and become the single source of truth. |
| "JSON protocol phase 1, binary later" | Greenfield the Rust side **binary-first** (postcard). Keep a JSON debug encoding behind a flag for inspection. |
| Golden hash proves TS↔Rust bit-parity | **Trap.** The TS sim is float-heavy; bit-exact TS↔Rust parity would require first making TS bit-deterministic. Use TS as a *behavioural oracle within tolerance*, and reserve exact golden-hash for **Rust-to-Rust** replay/cross-platform determinism. See §6. |
| Big-bang: all systems in core, WASM at week 5 | **Vertical-slice-first** instead — prove the worker/bridge/tile-mirror pipe end-to-end with a stub sim *before* porting systems. See §8. |
| `f32` "or document non-determinism" | Commit: **gameplay-affecting state is integer/fixed-point**; floats only in cosmetic/derived values excluded from the hash. Required for cross-platform (x64/ARM, web/native) replay. |

## 4. The central design decision: the UI↔sim boundary

The renderer reads tiles every frame; the sim runs in another thread/process. How tile
state crosses that boundary is the most important call, and the brainstorm docs
under-specify it (they assume a JSON `TileDelta[]` every tick, which won't scale to the
"bigger maps" goal).

**Decision: the UI always holds a typed-array tile mirror; the renderer reads only from
the mirror.** How the mirror is *updated* differs per transport, but the renderer code
is identical:

- **Web**: tiles live in a `SharedArrayBuffer`. The WASM sim (in a Worker) writes tile
  fields directly; the main thread reads them in the rAF loop. **Zero per-tick
  serialization of the grid.** (Requires COOP/COEP headers — verify on GitHub Pages;
  fallback is binary tile diffs over `postMessage` with transferable `ArrayBuffer`s.)
- **Desktop (Tauri v2)**: the native sim runs in the backend process — no shared memory
  with the webview. Push a **binary tile buffer / diff over a Tauri Channel**; the
  webview applies it into the same typed-array mirror.

So: **structured messages (events, stats, building metadata, errors) are small and
serialized; the tile grid is bulk binary** (shared memory on web, channel on desktop).
This unifies both transports behind one renderer and is a better articulation than the
docs' per-tick JSON.

Tile layout (SoA-friendly, one source of truth in `city-sim-protocol`):
`kind:u8 · elevation:u8 · flags:u8 (powered/watered/abandoned/underlays/overlay) ·
happiness:u8 (fixed-point) · building_id:u32 · underground:u8`.

## 5. Core design principle: utility networks as a generic abstraction

Power and water share an identical computational shape:

```
Producers  →  buildings that emit a quantity per tick (plants, pumps/towers)
Carriers   →  tiles the BFS traverses (powerline/road/rail  ·  pipe/road/rail)
Consumers  →  zones + buildings that draw from the network
Balance    →  produced − used  →  surplus or deficit
Coverage   →  per-tile boolean flag set by BFS  (powered / watered)
Events     →  deficit_start, deficit_end  →  alerts + narrative
Overlay    →  minimap mode colour-codes tiles by coverage flag
```

In Rust this is **one generic system**, not two separate ones:

```rust
pub enum UtilityKind { Power, Water }  // extensible: Sewage, Heat, Fibre...

impl UtilityKind {
    fn is_carrier(&self, tile: &Tile) -> bool { ... }
    fn coverage_flag(&self) -> TileFlag { ... }
    fn produced(&self, buildings: &[BuildingInstance], templates: &Templates) -> f32 { ... }
}

pub fn recompute_utility_network(state: &mut GameState, kind: UtilityKind) { /* one BFS */ }
```

The brainstorm docs treated power and water as two separate ports. We implement them as
**one parameterised system**. Adding sewage, heating districts, or any future network
resource is a new `UtilityKind` variant + carrier predicate — zero new BFS code.

The **service coverage** system (police, fire, health, education) follows an *analogous*
but distinct shape: radius-based flood rather than network BFS. It shares the same
deficit-event → alert → minimap-overlay pipeline, so the reporting layer is unified even
though the underlying computation differs.

**Building type hierarchy** (resolved in planning):

```
BuildingCategory  (Power | Civic | Zone | Transport)   ← fixed enum
  └─ BuildingKind  (Hydro | Coal | Wind | Solar | ...)  ← grows with templates
       └─ ZoneDensity (Low | Medium | High)             ← orthogonal to ZoneKind
```

Budget breakdown aggregates by `(BuildingKind, ZoneDensity)` — a sorted
`Vec<(KindId, i32)>` per category. No `HashMap`, no `Record<string,number>`.
`BuildingKind` is a `u8` enum; string id stays on the wire for human-readability.

Each power plant type gets its own `TileKind` variant (issue #30 — fix during Phase 1
when `TileKind` u8 mapping is defined, not before).

Zone density lives as a 2-bit field in the tile flags byte. `TileKind` stays as the
zone type (`Residential | Commercial | Industrial`); density is orthogonal so carrier
logic, BFS, and road-access checks never need to inspect it.

## 7. Architecture & crate layout

### Layout

```
TypeScript UI (src/)
  └─ SimBridge (interface)  ← renderer reads tile mirror; sends SimCommands; gets events/stats
        ├─ WasmSimBridge   (web:  Worker + SharedArrayBuffer — default browser path)
        └─ TauriSimBridge  (desktop: invoke + Channel — auto-detected or ?bridge=tauri)
        // LocalSimBridge removed in P5-4; simulation.ts retained as test-only oracle,
        // then fully removed 2026-07-30 once Rust became the sole engine (§9) — last
        // version preserved at commit 1f8140a

crates/                     (all stay in this repo)
  sim_core      pure, deterministic, no I/O. Owns GameState, step(), systems, RNG,
                command validation (the applyTool rules move here). postcard for snapshots.
  sim_protocol  shared wire types: SimCommand, FromSim messages, TileKind↔u8, tile buffer
                layout. serde + postcard. Generates / is mirrored by src/game/protocol/*.ts.
  sim_wasm      cdylib; wasm-bindgen host; writes tiles into SharedArrayBuffer.
  sim_tauri     Tauri v2 backend; structured as a proper plugin (Builder + managed State)
                so the sim owns its GameState cleanly and commands are namespaced.
                Streams tile buffer via Tauri Channel. Stays in this repo.
  burgomaster   Pure Rust TUI (Ratatui + crossterm). No Tauri dependency — reads and
                writes save files directly via std::fs. Inspect, convert, edit, validate,
                diff saves. See issue #31. Builds in Phase 3+ once GameState is stable.
  (benches live as `#[bench]`/criterion in sim_core initially, not a 6th crate.)
```

`city-sim-core` stays free of serde/wasm/tauri so it compiles tiny and tests fast; only
`city-sim-protocol` and the binding crates touch serialization.

### Tauri plugin catalogue (Phase 4)

Wire these into the desktop app shell. Available locally in
`~/source/tauri-plugins-workspace/plugins/`:

| Plugin | Use |
|---|---|
| `tauri-plugin-store` | Persistent key-value store for settings + save metadata |
| `tauri-plugin-dialog` | Native open/save file dialogs for save and replay files |
| `tauri-plugin-deep-link` | Open `.csr` replay files from the OS (double-click → game launches + plays) |
| `tauri-plugin-single-instance` | Prevent two windows fighting over the same save file |
| `tauri-plugin-window-state` | Persist window size/position between sessions |
| `tauri-plugin-updater` | Ship desktop app updates |
| `tauri-plugin-notification` | Surface sim alerts as OS notifications when window is backgrounded |

### SimBridge — Tauri first principles

Build `TauriSimBridge` from the Tauri v2 docs directly, not from the `tauri-city-sim-example`
experiment. Key primitives:
- `invoke()` for commands (JS → Rust, async request/response with typed errors)
- `listen()` for events (Rust → JS, fire-and-forget notifications)
- `Channel` for the tile buffer stream (high-throughput binary, new in v2)
- `isTauri()` / `window.__TAURI__` check for runtime bridge selection

## 8. Determinism strategy (corrected)

Two *different* guarantees, don't conflate them:

1. **Rust-to-Rust exact determinism** (replays, cross-platform, multiplayer-future):
   - Seeded RNG (SplitMix64 init + xoshiro128** stream, per the brainstorm — it's good).
   - Per-system derived RNG from `(seed, tick, system_id)` so adding/removing systems
     doesn't shift unrelated streams.
   - **Integer/fixed-point** for all hashed state. Stable iteration order (tile index
     ascending; sort buildings by id).
   - Golden-hash test + tick-by-tick hash log for binary-searching divergence.
   - **This is the real acceptance gate.**

2. **TS↔Rust behavioural parity** (migration confidence, *not* bit-exact):
   - First, make the **TS sim seeded** (replace the 2 `Math.random` calls with the same
     seeded PRNG) so it's run-to-run stable — do this in the *current* codebase now.
   - Capture a handful of golden scenarios (seed + command log) and record TS outcomes
     (population, money trajectory, tile-kind counts, abandonment) as **tolerance-banded
     regression fixtures**.
   - Rust must land inside the bands. Don't chase bit-parity against float TS.

## 9. Fate of the TS sim

- During migration the TS sim was wrapped as `LocalSimBridge` and used as the dev-time
  oracle / fallback (Phase 1–4).
- **P5-4 (done):** `LocalSimBridge` deleted. `simulation.ts` demoted to a test-only
  parity oracle — still imported by `tools.test.ts`, `regression.test.ts`, and
  `stateHash.test.ts` but marked off-limits to production code. WASM is now the required
  browser runtime; no pure-TS fallback exists.
- **Completed 2026-07-30:** `simulation.ts` and the cross-engine parity harness that
  checked it against Rust (`app/src/game/parity/`, `stateHash.test.ts`,
  `regression.test.ts`, `budgetPolicy.test.ts`) were removed outright — the Rust engine
  had been the sole production engine since P5-4, so the oracle no longer had a second
  engine to keep honest. Its last version is preserved at commit `1f8140a`.
- **Saves**: JSON `GameState` in localStorage is still supported via the existing
  `deserialize` back-fill path. Postcard binary snapshots (`get_snapshot`/`load_snapshot`)
  are the new primary save format on Tauri/WASM.

## 10. Phased plan (vertical-slice-first)

Each phase ends green on `cargo test && npm test`. Conventional Commits, atomic.

**Phase 0 — Make TS deterministic & build the oracle (in current codebase).**
Replace the 2 `Math.random` calls with a seeded PRNG; add `seed` to `GameState`.
Define golden scenarios (seed + command log) and record tolerance-banded fixtures.
Deliverable: TS sim is run-to-run deterministic; regression harness exists.

**Phase 1 — Monorepo + protocol + the bridge seam (no real sim yet).**
Scaffold the 4 crates. Define `city-sim-protocol` (SimCommand, FromSim, TileKind↔u8, tile
buffer layout). Introduce `SimBridge` in TS and route the *existing* TS sim through
`LocalSimBridge` so `main.ts` no longer touches `Simulation` directly. Deliverable: app
runs exactly as today, but behind the bridge.

**Phase 2 — End-to-end pipe with a STUB Rust sim.**
`city-sim-wasm` + Worker + `SharedArrayBuffer` tile mirror; a trivial `step()` that just
flips a few tiles. Prove: Init → tick → renderer shows tiles from the mirror → one
command round-trips → events arrive. **This de-risks the hardest integration before any
system logic.** Verify COOP/COEP on GitHub Pages here; wire the `postMessage` fallback.

**Phase 3 — Port systems into `step()`, oracle-checked after each.**
Order by dependency & risk: RNG → tiles/state accessors → power BFS → water (real model,
not the stub) → zone growth (RNG) → building state machine → demand → economy →
education → services. Move `applyTool` rules into `city-sim-core` command validation. Run the
Phase-0 regression fixtures after each system.

**Phase 4 — Tauri v2 transport.**
`tauri-plugin-city-sim` backend; `TauriSimBridge` over invoke + Channel; runtime detection picks the
bridge. Same core, same renderer, tile buffer over the channel instead of shared memory.

**Phase 5 — Artifacts & polish.**
Command-log replays (the real artifact — deltas-long-term is correctly rejected by the
brainstorm's doc 07). Map/seed export. Snapshot save/load. Optional delta ring buffer
for undo (last ~50 s ≈ 6 MB) *only if* an undo feature is wanted. Benchmarks, CI for
both targets, docs/manual sync.

## 11. Open questions / risks

### Resolved in planning

- **Map size** — no fixed ceiling; design is agnostic (width/height passed at `Init`,
  tile buffer is a runtime-sized flat array). 512×512 is plausible so `SharedArrayBuffer`
  is worth committing to now. ✅
- **Water model** — fully implemented in TS (`water.ts`); port as-is, same pattern as
  power. ✅
- **Budget `*ByType` maps** — resolved as a two-level `BuildingKind` enum hierarchy;
  `Vec<(KindId, i32)>` sorted by id. No `HashMap`. ✅
- **Zone density** — near-term feature; 2-bit field in tile flags, orthogonal to
  `TileKind`. Implement in Rust directly, not in the TS sim. ✅
- **Utility network abstraction** — power and water share one generic BFS in `city-sim-core`,
  parameterised by `UtilityKind`. Future resources (sewage etc.) are new variants. ✅

### Still open

- **COOP/COEP on GitHub Pages** for `SharedArrayBuffer` — verify in Phase 2. If
  unavailable, transferable-`ArrayBuffer` diff path is the fallback (slightly slower,
  fine at current sizes).
- **Fixed-point conversion of happiness/demand** — tune against the oracle; accept it
  won't be bit-identical to today's float behaviour.
- **Save break scope** — handled by **Burgomaster** (`crates/burgomaster`, issue #31).
  The `burgo convert` operation reads old JSON `GameState` and writes the new postcard
  binary, carrying settings through (player preferences are part of the save, not
  separate). Best-effort field mapping with clear warnings on anything dropped.
- **Sewage as a 3rd utility** — natural next resource after power + water (CS1-style:
  zones produce sewage, treatment plants consume it, pollution if mishandled). Not in
  scope for the port but the `UtilityKind` enum is ready for it.

---

*Brainstorm ideas kept wholesale:* seeded RNG design (doc 05), command-log replays over
long-term deltas (doc 07), the transport-agnostic bridge, golden-hash harness (rescoped
to Rust-to-Rust). *Dropped/rescoped:* JSON-first protocol, per-tick JSON tile deltas,
bit-exact TS↔Rust parity, the 5th benches crate, big-bang integration order, treating
power and water as separate systems (they share one generic BFS).
