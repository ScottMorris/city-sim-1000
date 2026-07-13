# Wilderness Score

## Purpose

Add a **Wilderness Score** to City Sim 1000 that measures how well the city preserves/creates natural ecosystems versus converting land into hard, industrialized, or polluting surfaces.

This metric must be:

* **Actionable**: players can intentionally raise/lower it via choices.
* **Legible**: the UI explains *why* the score changed.
* **Consequential**: it affects core loops (growth, happiness, budget), not just flavour.
* **Extensible**: future systems (pollution, land value, disasters, wildlife, LLM storytelling) can plug into it.

Non-goals:

* Simulating real ecology.
* Requiring complex agents/animals.
* Perfect realism in weights/thresholds (tuning comes later).

---

## Design Decisions (locked 2026-07-13)

These four decisions supersede the corresponding open questions in earlier drafts:

1. **Scoring**: natural capital (P) and urban pressure (U) are summed **separately** and combined as `score = 100 · P / (P + U + k)`. No clamp-and-scale against a theoretical all-nature maximum — that formula pinned built-up cities at 0 and scored an untouched map ~17, both dead zones where player action stops moving the number. The ratio form always responds to marginal change, an untouched map lands naturally mid-high, and the P/U split falls straight out as the top-level tooltip breakdown.
2. **Budget consequence (MVP)**: **tourism dividend only** — a monthly income line in the City Ledger when the score clears a threshold. Cleanup costs / environmental penalties are deferred to the Environmental Crisis follow-up (#9).
3. **Happiness consequence (MVP)**: **global-only** — one citywide happiness modifier derived from the global score. The per-tile local field is used for the overlay heatmap only; local neighbourhood happiness effects are a later phase.
4. **Parity**: wilderness is **excluded from the TS parity oracle** (`simulation.ts`). The oracle exists to verify ported pre-Rust behaviour; wilderness is Rust-first and its Rust unit/scenario tests are the spec. Wilderness-derived stats are carved out of parity assertions.

---

## Player Fantasy

“Carve out ecosystems for nature and balance it with industry/pollutants/hard surfaces.”

Examples:

* Plant forests, build parks, keep green riverbanks → **more wilderness**.
* Add industry, roads/rail/power corridors, coal plants → **less wilderness**.

---

## Core Output

* **Global Wilderness Score**: `0–100`.
* **Local Wilderness Field** (per-tile): a heatmap value used for the overlay (and, later, neighbourhood effects).
* **Trend Indicator**: short moving average over recent in-game days, shown as ↑/→/↓ beside the score.

---

## Data Model

### Concept: two blended forces

Wilderness is two sums blended into one score:

1. **Natural capital (P)** — forests, parks, water edges, open land, contiguity.
2. **Urban pressure (U)** — industry, roads/rail, power infrastructure, zoning, future pollution.

### Tile Contributions

Each tile contributes a base “eco value” (positive or negative), then receives neighbourhood adjustments. Positive results accumulate into P, negative into U (as a positive magnitude).

**Base eco weights**, mapped to the real `TileKind` enum (starter values — tune in play):

| `TileKind`         | Base Eco | Rationale |
| ------------------ | -------: | --------- |
| `Tree`             |       +6 | Strongest natural capital. |
| `Park`             |       +4 | Managed green space. |
| `Land`             |       +1 | Open natural land — small but citywide. |
| `Water`            |        0 | Neutral base; contributes via the water-edge bonus instead. |
| `Residential`      |       −1 | Mild footprint. |
| `Commercial`       |       −2 | |
| `Industrial`       |       −5 | Strong urban pressure. |
| `Road`             |       −2 | Hard surface + fragmentation vector. |
| `Rail`             |       −2 | |
| `PowerLine`        |       −1 | Corridor, but light footprint. |
| `CoalPlant`        |       −8 | Worst offender — creates the “pay more for cleaner power” pressure. |
| `HydroPlant`       |       −2 | Clean but disruptive (reservoir/dam footprint). |
| `WindTurbine`      |       −1 | Clean; land take only. |
| `SolarFarm`        |       −1 | Clean; land take only. |
| `WaterPump`        |       −1 | Small utility footprint. |
| `WaterTower`       |       −1 | |
| `ElementarySchool` |       −1 | Counts like residential footprint. |
| `HighSchool`       |       −1 | |
| `WaterPipe`        |        0 | **Underground layer — excluded.** Nature above a buried pipe is still nature. |

Notes:

* All weights live in a central `WildernessTunables` struct so iteration is fast.
* Only the surface `kind` is scored; the underground layer never contributes.

### Neighbourhood Adjustments

To encourage *ecosystems* (not “spam trees”), nature tiles (`Tree`, `Park`, `Land`) receive:

1. **Patch Bonus (Contiguity)**

* Contiguous clusters of nature tiles become more valuable per tile.
* Implementation: single flood-fill pass labels clusters and records size; per-tile bonus follows a saturating curve (grows with cluster size, capped) so one big forest beats many small woods but returns diminish past a reference size.

2. **Water Edge Bonus**

* Nature tiles 4-adjacent to `Water` gain a flat bump (wetland/riverfront vibe).

3. **Fragmentation Penalty**

* Nature tiles with fewer than `k` nature neighbours (8-neighbourhood) lose value — one tree surrounded by road is nearly worthless.

---

## Score Definition

### Step 1: Per-tile eco contribution

For each surface tile:

* `eco = baseEco(kind)`
* `eco += patchBonus(clusterSize)` (nature tiles only)
* `eco += edgeBonus` (nature tile 4-adjacent to water)
* `eco −= fragmentationPenalty` (nature tile with too few nature neighbours)

Store in `eco_field[tile]`.

### Step 2: Aggregate

* `P = Σ max(eco, 0)`
* `U = Σ max(−eco, 0)`

### Step 3: Score

```
score = 100 · P / (P + U + k)
```

where `k = k_per_tile × buildable_tiles` (starter: `k_per_tile = 0.5`). The constant:

* stops a two-tree hamlet from scoring 100,
* scales with map size so the formula is map-agnostic,
* keeps an untouched map (mostly `Land` at +1, plus generated tree patches) in the mid-to-high band.

No clamping is needed — the ratio is inherently 0–100 and responds to every marginal change.

### Trend

A ring buffer of recent daily scores lives in `GameState` (so it serializes). The indicator compares the recent-window mean against the prior-window mean: ↑ / → / ↓.

---

## Update Frequency

* Recompute fully every `N` simulation ticks (starter: `N = 10`) from the Rust tick loop.
* The compute is a couple of O(tiles) passes over byte arrays in Rust — microseconds at current map sizes. Incremental cluster maintenance (#11) stays deferred indefinitely.

---

## Consequences (MVP)

### 1) Happiness & Growth

* **Global happiness modifier**: small additive citywide adjustment derived from the score (roughly −2..+2 on the internal scale, zero near the neutral band). Tunable.
* **Residential demand term**: additive term in the demand model, `(score − 50) / 50 × demand_weight` (tunable weight). High wilderness pulls people in; low wilderness suppresses residential demand. Commercial/industrial stay neutral in the MVP.

### 2) Budget

* **Tourism dividend**: when `score ≥ dividend_threshold` (starter: 60), a monthly income line scaled by population and by how far the score clears the threshold. Appears as its own line in the City Ledger.
* No penalty path in the MVP (see locked decision 2).

### 3) Unlocks, Restrictions, Soft Events

Deferred — see follow-up issues #9 (policies/unlocks) and #10 (soft events).

---

## UI/UX

### HUD

* Status-ribbon chip: `Wilderness: 72 ↑`.
* Tooltip: top contributors from the breakdown, e.g. “Forests +18 · Parks +9 · Industry −22 · Roads −11 · Fragmentation −6”.

### Overlay

* New `wilderness` overlay mode (minimap + main map tint, same pattern as power/water/education overlays): heatmap from lush (green) to depleted (grey), driven by the per-tile field in the tile buffer.

### Tile Inspector

* Deferred alongside local effects.

---

## LLM Storytelling Hook (Deferred — #12)

Wilderness score + trend + breakdown become narrative signals for the ticker via the existing event/snapshot pipeline. The LLM only narrates facts the sim already knows; output is non-authoritative flavour, toggleable.

---

## Engineering Plan

Production simulation is Rust (`crates/city-sim-core`) — the compute lives there, not in TS.

### Module

`crates/city-sim-core/src/wilderness.rs`:

```rust
pub struct WildernessTunables {
    pub base_eco: [f32; TileKind::COUNT],
    pub patch_bonus_cap: f32,
    pub patch_reference_size: f32,
    pub edge_bonus: f32,
    pub fragmentation_penalty: f32,
    pub min_nature_neighbours: u8,
    pub k_per_tile: f32,
    pub recompute_interval_ticks: u32,
    pub dividend_threshold: f32,
    // consequence weights…
}

pub struct WildernessOutput {
    pub score: f32,             // 0–100
    pub eco_field: Vec<f32>,    // per tile
    pub breakdown: WildernessBreakdown, // fixed struct, not a string map
}
```

`WildernessBreakdown` is a fixed struct (forests, parks, open land, water edge, patch bonus, fragmentation, industry, transport, power, zoning) — wire-friendly and matches the tooltip design.

### Wiring

* `sim.rs` calls the recompute every `N` ticks; score/trend/breakdown stored in `GameState` (serde defaults for save compatibility; TS `persistence.ts` back-fills on deserialize).
* Consequences applied where they belong: demand term in `demand.rs`, dividend line in `economy.rs::compute_daily_budget`, global happiness modifier in the happiness pass.
* Score/trend/breakdown ride the existing stats snapshot to the UI (TS protocol mirror updated in step).

### Tile buffer (overlay phase)

The per-tile field ships to the renderer as a new `wilderness[N]` u8 array in the SoA tile buffer (quantised 0–255, same pattern as `happiness[N]`): `BYTES_PER_TILE` 7 → 8, offsets struct + TS mirror (`tileBuffer.ts`) + parity fixtures updated together. WASM and TS ship together, so no cross-version concern.

### Phasing

1. `wilderness.rs` + tunables + unit/scenario tests (pure Rust, no protocol changes).
2. State + tick wiring + consequences (demand, happiness, dividend) + persistence back-fill.
3. Stats snapshot → HUD chip with trend + tooltip; City Ledger dividend line.
4. Tile-buffer field + overlay heatmap.
5. Deferred: policies (#9), soft events (#10), incremental clustering (#11), LLM headlines (#12), tile inspector, local happiness.

---

## Testing

Rust unit tests (`wilderness.rs` — these are the spec; no TS oracle mirror):

* base eco weights (including `WaterPipe`/underground exclusion)
* edge bonus detection
* fragmentation penalty
* cluster/patch bonus curve
* `P/(P+U+k)` scoring bounds and monotonicity

Scenario tests on hand-built grids:

1. Untouched natural map → mid-to-high score.
2. Large forest patch → scores higher than the same tree count scattered.
3. Industrial strip / road cut through forest → score drops by more than the converted tiles alone (fragmentation).
4. Pond beside park → higher than pond far from park (edge bonus).

Integration: demand/dividend/happiness hooks covered by existing module tests extended with wilderness inputs.

---

## MVP Scope

Ship first (this epic, #8):

* Base weights + patch/edge/fragmentation adjustments, full recompute every N ticks.
* `P/(P+U+k)` score + trend + breakdown in `GameState` and the stats snapshot.
* HUD ribbon chip with trend + breakdown tooltip.
* Wilderness overlay heatmap (tile-buffer field).
* Consequences: global happiness modifier, residential demand term, tourism dividend ledger line.

Defer: unlocks/policies (#9), soft events (#10), incremental clustering (#11), LLM headlines (#12), tile inspector, local happiness effects.
