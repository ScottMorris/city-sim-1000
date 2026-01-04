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

## Player Fantasy

“Carve out ecosystems for nature and balance it with industry/pollutants/hard surfaces.”

Examples:

* Plant forests, build parks, place a duck pond → **more wilderness**.
* Add industry, roads/rail/power corridors → **less wilderness**.

---

## Core Output

* **Global Wilderness Score**: `0–100`.
* **Local Wilderness Field** (per-tile or per-chunk): a heatmap value used for overlays and neighbourhood effects.
* **Trend Indicator**: short moving average (e.g., last 30–90 in-game days) used to show ↑/↓.

---

## Data Model

### Concept: two blended forces

Think of Wilderness as two things blended into one score:

1. Natural capital (forests, parks, water edges, wetlands, open land)
2. Urban pressure (industry, roads/rail, power infrastructure, dense zoning, future pollution)

### Tile Contributions

Each tile contributes a base “eco value” (positive or negative), then receives neighbourhood adjustments.

**Base Eco Value** is derived from the tile type and (later) building properties.

Suggested starter weights (tune later):

| Category         |          Tile/Building | Base Eco |
| ---------------- | ---------------------: | -------: |
| Strong positive  |         Forest / Trees |       +6 |
| Medium positive  |                   Park |       +4 |
| Small positive   |           Natural land |       +1 |
| Special positive | Duck pond (park+water) |       +5 |
| Neutral          | Water (see edge bonus) |  0 to +2 |
| Mild negative    |            Residential |       -1 |
| Negative         |             Commercial |       -2 |
| Strong negative  |             Industrial |       -5 |
| Negative         |                   Road |       -2 |
| Negative         |                   Rail |       -2 |
| Mild negative    |             Power line |       -1 |

Notes:

* Keep these values in a central tunables object so you can iterate fast.
* If zoning/buildings are not tile types yet, map them to per-tile footprint contributions.

### Neighbourhood Adjustments

To encourage *ecosystems* (not “spam trees”), apply bonuses/penalties:

1. **Patch Bonus (Contiguity)**

* Contiguous clusters of nature tiles (forest/park/pond) become more valuable.
* Implementation: flood-fill or union-find to compute cluster size and a bonus curve.

2. **Water Edge Bonus**

* Nature tiles adjacent to water gain extra value (wetland vibe).
* Encourages riverfront parks / ponds.

3. **Fragmentation Penalty**

* Small isolated nature islands are less effective.
* Implementation: if a nature tile has fewer than `k` nature neighbours (4- or 8-neighbourhood), subtract a penalty.

---

## Score Definition

### Step 1: Compute per-tile eco contribution

For each tile:

* `eco = baseEco(tileKind)`
* `eco += patchBonus(clusterSize)` (nature tiles only)
* `eco += edgeBonus(if nature and adjacent to water)`
* `eco -= fragmentationPenalty(if nature and too few nature neighbours)`

Store result in `ecoField[tileIndex]`.

### Step 2: Aggregate

* `ecoTotal = sum(ecoField)`

### Step 3: Normalization to 0–100

Normalize against a theoretical maximum for the current map:

* `ecoMax = (countBuildableTiles * baseEcoBestNature)`
* `score = clamp01(ecoTotal / ecoMax) * 100`

Notes:

* Use **countBuildableTiles** to avoid water-heavy maps skewing the score.
* If `ecoTotal` can go negative, decide whether:

  * clamp at 0 before normalizing, or
  * allow negative totals but clamp after normalization.

Recommendation (simple): clamp `ecoTotal` to `[0, ecoMax]` before scaling.

---

## Update Frequency

MVP:

* Recompute wilderness every `N` simulation ticks (e.g., every 10 ticks) to keep it simple.

Later optimisation:

* Incremental updates using dirty rectangles / changed tiles.
* Maintain cluster IDs to avoid full flood-fill each update.

---

## Consequences

Wilderness must affect at least **two** core loops.

### 1) Happiness & Growth

* Add a **local happiness modifier** based on the local wilderness field.

  * Example: `happiness += f(localWilderness)` where `f` is small (e.g., -2..+2).
* Add a **global demand modifier**:

  * Residential demand increases with wilderness.
  * Optionally: industrial productivity slightly increases when wilderness is low (cheaper land / fewer regs), or keep industry neutral.

Design intent:

* Players feel wilderness in everyday city behaviour (not just a number).

### 2) Budget & Upkeep

Pick one or more of these (recommended: start with 1):

**A. Tourism/Grant Dividend (High wilderness reward)**

* If Wilderness ≥ threshold, add monthly income (“tourism”, “provincial grant”).

**B. Healthcare/Cleanup Cost (Low wilderness penalty)**

* If Wilderness ≤ threshold, add a monthly expense multiplier.

**C. Maintenance Scaling**

* Parks/forests have upkeep, but reduce other costs when abundant.

### 3) Unlocks & Restrictions (Milestones)

Optional for MVP; good for a later patch.

Examples:

* Wilderness ≥ 60: unlock “Nature Reserve” policy (boosts patch bonus, reduces fragmentation penalty).
* Wilderness ≤ 20: unlock “Environmental Crisis” events (soft debuffs, not game-over).
* “Green Industry” upgrade: reduced wilderness damage at higher cost.

### 4) Soft Events

Optional, low-effort flavour that reinforces consequence:

* “Smog day” (low wilderness) → temporary happiness debuff.
* “Spring festival” (high wilderness) → temporary income bump.

---

## UI/UX

### HUD

* Display `Wilderness: 72 (↑)` with a trend arrow.
* Hover/tooltip: show top contributors:

  * “Forests +18”, “Parks +9”, “Industry -22”, “Roads -11”, “Fragmentation -6”.

### Overlays

Add a Wilderness overlay mode:

* Heatmap from high (lush) to low (grey).
* Optional: toggle to show fragmentation hotspots.

### Tile Inspector

When selecting a tile:

* Show “Local wilderness” score for the surrounding area.
* If the tile is nature: show cluster size + bonuses.

---

## LLM Storytelling Hook (Optional)

Use Wilderness as a **storytelling signal** for in-game news/ticker.

Constraints:

* The LLM must only narrate **facts the sim already knows**.
* Output is non-authoritative flavour, toggleable.

Example prompts/outputs:

* High wilderness and rising: “Ducks return to Maple Pond; locals report clearer water.”
* Low wilderness and falling: “Squirrels petition City Hall about the new rail spur through Oldwood.”

Suggested format:

* 3–5 headlines + 1 “Mayor’s recommendation” derived from wilderness + recent building changes.

---

## Engineering Plan

### Public API

Add a module/service that computes wilderness:

* `computeWilderness(mapState, tunables) -> { score, ecoField, localField, breakdown }`

Where:

* `score: number (0–100)`
* `ecoField: Float32Array` per tile
* `localField: Uint8Array` (optional) per tile/local neighbourhood score 0–100
* `breakdown: { [category: string]: number }` for UI tooltips

### Tunables

Centralize constants:

* Base eco weights
* Patch bonus curve
* Fragmentation thresholds
* Edge bonus value
* Consequence thresholds

### Performance Notes

* Flood-fill clusters is O(tiles) per update; fine for MVP.
* If it becomes hot, switch to:

  * chunk-based cluster estimation, or
  * maintain union-find incrementally.

---

## Testing

* Unit tests for:

  * base eco weights
  * edge bonus detection
  * fragmentation penalty
  * cluster bonus curve
  * normalization/clamping

* Scenario tests:

  1. Empty natural land → mid score
  2. Large forest patch → higher than scattered trees
  3. Add industrial strip through forest → score drops + fragmentation penalty increases
  4. Add pond next to park → score increases with edge bonus

---

## MVP Scope

Ship the following first:

* Base weights + basic bonuses (edge bonus, fragmentation penalty)
* Full recompute every N ticks
* Global score in HUD with simple breakdown tooltip
* Wilderness overlay heatmap
* One consequence path (recommended: happiness + small monthly budget modifier)

Defer:

* Unlocks/policies
* Soft events
* Incremental cluster maintenance
* LLM headlines (keep it as a planned hook)
