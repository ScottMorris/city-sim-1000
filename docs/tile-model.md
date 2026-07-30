# Tile model — a stratum-based design note

**Status:** implemented, both sides. `crates/city-sim-core`'s `Tile` moved off `kind` onto `terrain` + `underground`/`surface`/`overhead` occupant sets in #177/#181. The wire protocol and every TypeScript consumer — the gap this note's own Migration section originally left open — closed in a nine-phase follow-up (PR stack `legacy-wire-fork` → `docs`, 2026-07): the live wire buffer carries occupant bits directly (no more per-tick precedence derivation), `app/src/game/gameState.ts`'s `Tile` mirrors the Rust shape field-for-field, and the `kind`/`roadUnderlay`/`railUnderlay`/`powerOverlay`/`legacyUnderground` shim that bridged the two during the migration is deleted. Kept below for the reasoning, which is still the reasoning; see *Migration* for what each step actually shipped as.

This note proposes replacing the single `kind` field with a set of *strata*, each holding a set of *occupants*. It exists because the same class of bug has now been found four times in three separate systems, and each time it was found by accident rather than by a test.

## The evidence

Look at how the three physical layers of the map are modelled today, and how often each has broken:

| layer | occupants | do they coexist? | how it's modelled | bugs found |
| --- | --- | --- | --- | --- |
| underground | water pipes | yes | its own `underground` field | none, ever |
| surface | trees, road, rail, zones, structures | mostly no | `kind` | none of this class |
| overhead | power lines | **yes, with everything** | a bolt-on `powerOverlay` flag | all of them |

The underground layer is boring precisely because it is right: it never competes for `kind`, so every reader looks in exactly one place. Water pipes have never been mis-billed, mis-scored, or mis-drawn.

Hydro is the only overhead occupant in the game, and *overhead* was never modelled. It got a boolean bolted onto a single-valued slot, and every consumer then had to remember a special case. The ones that forgot:

- **`economy.rs`** — a `match tile.kind` billed one feature per tile, so stringing a line over a road took upkeep *down* from 0.10 to 0.08. Fixed in #172.
- **`wilderness.rs`** — reads `kind` alone, so a line over a road changes the tile's ecological damage from −2.0 to −1.0 and moves the whole figure from the `transport` category to `power`. Ten roads with lines on them score 1.6 points *better* than ten bare roads. Open, tracked separately.
- **`tileRenderUtils.ts`** — the carriageway test read the underlay flags but not `kind`, so a line laid before its road drew a pole in the middle of the road. Fixed in #172.
- **`commands.rs`** — road and rail cleared the overlay flag while power set it, so the same two actions in either order produced different tiles. Fixed in #172.

Four systems, one root cause. Precedence rules (what #172 introduced) fix the *two-spellings* problem but not the *check-two-places* problem, which is the one that bites.

## What's actually wrong

`kind` is doing three jobs, and they do not have the same cardinality:

| job | how many per tile |
| --- | --- |
| what land use occupies the ground | exactly one |
| what networks pass through | **many** — a level crossing is the point |
| what the tile contributes to scoring | derived from the union of the above |

Networks are inherently multi-valued and are being recorded in a single-valued slot, with the overflow spilling into ad-hoc booleans. Any consumer that checks the slot but not the overflow silently under-counts, and nothing tells you.

## The proposed model

```
Tile
├── terrain      Land | Water, + elevation
├── underground  set of Occupant     — pipes, subway, fibre
├── surface      set of Occupant     — trees?, road, rail, zone, structure
├── overhead     set of Occupant     — power lines, street trees?
└── development  Option<BuildingId>
```

Same shape at every stratum, so adding a layer or an occupant is additive rather than archaeological.

**Terrain is not just a sprite.** It sets placement policy (most things need land; docks, marinas and bridges need water), it is what the bulldozer restores a tile to, and it survives terraforming. It has to be a distinct field for bulldoze to be expressible at all — under the current model, "what was here before" is not recoverable, which is why bulldoze hand-clears a list of flags and why it broke when it forgot one.

### Concretely

```rust
// AUTHORED — what the player built. This is what the snapshot persists.
struct Tile {
    terrain:     Terrain,            // Land | Water, + elevation (exists today)
    underground: OccupantSet,        // pipes, subway, fibre
    surface:     OccupantSet,        // road, rail, zone, structure
    overhead:    OccupantSet,        // power lines, tree canopy
    development: Option<BuildingId>,
}

type OccupantSet = u16;              // bitset — an occupant is a flat tag

enum Occupant {
    Trees, Road, Rail, PowerLine, Pipe, Subway, Fibre,
    ZoneResidential, ZoneCommercial, ZoneIndustrial,
    Structure,                       // which structure lives in the BuildingInstance
}
```

Zones get one tag each rather than a payload, because they are mutually exclusive anyway. `Structure` needs no payload because `development` already points at an instance that knows what it is.

The occupant table is data, not code:

```rust
struct OccupantDef {
    stratum:   Stratum,
    eco:       f32,
    upkeep:    f32,
    conducts:  NetworkSet,           // Road conducts {Traffic, Power}; Zone conducts {Power}
    conflicts: OccupantSet,          // exceptions only; same-stratum conflict is the default
    on_water:  WaterRule,            // Forbidden | Plain | Variant(bridge, pylon, …)
}
```

**Two orderings exist today, and they are inverted.** This is worth naming because it is confusing and the model deletes half of it:

| ordering | question it answers | current precedence |
| --- | --- | --- |
| data | who owns `kind` | zone > hydro > road/rail |
| visual | who is the base, who adapts | road/rail > hydro |

Hydro *wins* the data slot (roads and rails yield, because they have underlay flags to fall back on) but *loses* the visual contest (roads draw first and ignore everything; hydro's pole has to dodge). The data ordering was never a layering decision — it came from which occupant had somewhere else to be recorded, which is an implementation accident.

Under strata the data ordering **disappears entirely**, because nothing is contested. Only the visual one survives, and it is just the physical stack: underground → surface → overhead. One ordering, and it means what it says.

**Network membership is a property, not a slot.** This is the correction to an earlier sketch that had `networks` as a sibling of `cover`: a road is surface cover that *happens to conduct*. So is a zone — `is_power_carrier` already returns true for roads, rails and zones, that fact just isn't written down anywhere as data.

```
Occupant → { eco, upkeep, conducts: set<Network>, stratum, … }
```

## Compatibility is mostly derivable

The permutation matrix already exists in the codebase — smeared across hand-written guards in `Tool::Road`, each zone tool, `place_footprint_building` and `Tool::PowerLine`. Every guard is a row of a table nobody has ever seen whole, which is exactly why two of them disagreed about the road/hydro interaction.

Strata make most of the table fall out — but **the default is per stratum, not global**, because the strata differ physically in whether space is scarce:

| stratum | default | why |
| --- | --- | --- |
| surface | **conflict** | the ground is the scarce resource; two things cannot occupy it |
| overhead | **conflict** | canopy and conductors genuinely fight — utilities trim trees away from lines |
| underground | **coexist** | depth is free; a main and a tunnel are simply at different depths |

With those defaults the exception list is calculable. Enumerating every pair from the occupants named so far:

**Surface** — Road, Rail, ZoneR, ZoneC, ZoneI, Structure → 15 pairs.

- Road + Rail — **coexist.** The level crossing. *Exception.*
- Road/Rail + any zone — conflict; the zone tools already refuse road and rail.
- Road/Rail + Structure — conflict; `place_footprint_building` already refuses both.
- Zone + Zone — conflict; land use is exclusive.
- Zone + Structure — conflict; a park placed on a zone replaces it.
- Structure + Structure — conflict; footprint placement already refuses overlap.

**Overhead** — PowerLine, Trees → 1 pair, conflicting by default, **0 exceptions**.

**Underground** — Pipe, Subway, Fibre → 3 pairs, all coexisting by default, **0 exceptions**.

**Total: 19 pairs, exactly one exception — road + rail.** Derivation carries the entire table and the exception list is one line long.

### Trees belong overhead, and this is why

Trees were originally sketched as a surface occupant that "yields to everything". Putting them **overhead** instead is strictly better and costs nothing:

- The exception count is unchanged — still one.
- `Trees + Road` becomes a *cross-stratum* pair, so it coexists by default. **Street trees come out free**, with no rule written for them.
- `Trees + PowerLine` becomes a *same-stratum* pair, so it conflicts by default — physically correct, and again no rule.
- A bare forest is simply terrain `Land` with `overhead: {Trees}`. Nothing special-cased.

It also settles open question 2 below: overhead gets a second occupant, so it is a real stratum rather than a boolean wearing a costume.

What it does *not* settle is whether laying a road through forest should clear the canopy or leave it as street trees. That is a gameplay choice, not a modelling one, and the model expresses either.

Making the table explicit data means it can be *printed and exhaustively tested*, which is the trick that worked for `hydroCoverage.test.ts`: it enumerated a space nobody had written down and immediately found 103 holes in it. The same trick applied to placement rules instead of sprites.

## Placement can transform, not only permit

`(terrain, occupant)` has three outcomes, not two:

| | |
| --- | --- |
| road on water | → bridge |
| rail on water | → rail bridge |
| power on water | → pylon span |
| zone on water | → forbidden |

A bridge is a **variant of the road occupant**, not a new occupant, or every network doubles. Classic SimCity worked this way and it is why its drawing tools felt like magic — one tool, context-dependent result.

Placement predicates belong in the same table: a hydro plant's "must be adjacent to water" is `requires: adjacent(Water)` as data, not another hand-written guard in a tool handler.

## Buildings own their own stats

The tile stays a dumb container. `development: Option<BuildingId>` points at an instance; the instance's template carries output, upkeep, footprint, category and placement predicates. This is already how `BuildingInstance` + `get_building_template` work, and it is the property that lets a new building type be added without plumbing changes.

**Multi-tile footprints** need no special handling: every covered tile carries the same `development` id, the instance owns `origin`, and the template owns `footprint`. The renderer draws at the origin and skips the rest. That mechanism exists today and carries over unchanged.

## Bulldoze

The bulldozer works on **what you can see**: surface and overhead together, restoring the tile to its terrain. Underground occupants are only removable from the underground view — which **already exists** (`minimap.ts`, mode `underground`) and is how water pipes are laid today. So this is not a new interaction to design, it is an existing one the model has to keep expressible, and it is expressible only because terrain is a separate field.

## Scoring becomes a sum

```
eco(tile)    = eco(terrain) + Σ eco(o)    for o in all strata
upkeep(tile) =                Σ upkeep(o) for o in all strata
```

The `Σ` is the point. A fifth network — gas, fibre, a bus lane — is one occupant definition and one table row, and every consumer that already sums picks it up for free. Under the current model it is a new flag plus an archaeological dig through every `match tile.kind` in two languages, with no way to know whether the dig was complete.

## Predicting the sprite budget

A useful consequence: the compatibility table lets you cost the art *before* drawing it.

```
sprites(occupant) = connectivity variants × context variants
```

- **Connectivity variants** — the familiar 15 (straight, corner, T, cross, terminus per direction) plus `isolated` for a network occupant; 1 for something that doesn't connect.
- **Context variants** — the number of distinct arrangements of *other* occupants that change how this one is drawn.

Worked from what the game already ships:

| occupant | connectivity | context | total |
| --- | --- | --- | --- |
| road | 15 | 1 (ignores everything above it) | 15 |
| rail | 15 | +2 level crossings | 17 |
| hydro | 16 | × 3 carriageway classes, + 2 two-pole crossings | 50 |

**The design lever is context, not connectivity.** Hydro costs three times what road costs because its pole has to dodge whatever is beneath it. An overhead occupant that draws the same regardless of what is below stays at 16. So a cheap rule of thumb: *a cross-stratum visual dependency multiplies your sprite count; only take one when the art genuinely demands it.*

## Not yet designed: flow

The sketch above treats occupants as static. Several wanted mechanics need **per-tile, per-network dynamic state** — traffic volume on a road, load on a power line, water pressure — and that changes the data layout (a set of enums is cheap; a set of small structs is not).

**Flow is derived, not authored** — and that resolves the layout question. Load on a line is simulation output recomputed each tick from topology, exactly like `powered` and `happiness` today. It is not something the player edits, so it does not belong *inside* the occupant:

```rust
// DERIVED — recomputed per tick from topology. Not authored, not player-editable.
struct NetworkField { load: Vec<f32>, capacity: Vec<f32> }   // indexed by tile
struct Networks { power: NetworkField, traffic: NetworkField, water: NetworkField }
```

So occupants stay **bare tags in a bitset**, and flow lives in per-network arrays alongside the tile grid — structure-of-arrays, matching how the tile buffer already crosses the WASM boundary. Adding a network adds one field to `Networks`, not a float to every `Tile`.

The topology is stratum data; the flow over it is network logic. See #176 for the mechanic driving this, and the backlog issue for the rest.

### Scalar load is not enough for traffic

A capacity mechanic needs only *how much* — a scalar per tile. Drawing moving cars needs *which way*, so a network that wants visualisation carries **directed** flow: outflow per edge, four values per tile.

```rust
struct NetworkField {
    load:     Vec<f32>,               // scalar — enough for capacity and overload
    capacity: Vec<f32>,
    flow:     Option<Vec<[f32; 4]>>,  // N/E/S/W outflow — only for networks that draw motion
}
```

Power needs the scalar and not the direction — nobody animates electrons. Roads need both.

### Traffic is a field, not a population

Cars are **not agents**. An agent has identity, an origin, a destination and a route it committed to. A car here has none of those, and giving it them means per-vehicle pathfinding for something the player reads as texture.

The middle ground is a particle **advected by the flow field**: a car is spawned on a tile, reads that tile's directed flow, moves along it, and at a junction picks an outgoing edge with probability proportional to that edge's share of the outflow. No pathfinding, no origin-destination pair, no memory, no lifetime beyond the viewport.

The behaviour that makes it look right is emergent rather than authored — cars thicken on busy corridors, thin out on quiet streets, and turn at junctions in the proportions the solver already computed. **The realism comes from the solver, not from the cars.** That is why this is cheaper than it sounds, and why it is worth making the solver produce direction rather than only magnitude.

The line between the two categories:

| | identity | route | cost |
| --- | --- | --- | --- |
| train | yes — it is *that* train | committed, follows specific track | agent |
| car | none | picks per junction from the field | particle |


## What is *not* a tile occupant

Anything that **moves** is an agent, not tile data. The tile model describes static infrastructure; agents travel over it and reference the network for routing.

| thing | where it lives |
| --- | --- |
| runway, terminal, airport | `Structure` occupant on the surface |
| **aeroplane** | agent — continuous position, no tile |
| track | `Rail` occupant |
| **train** | agent |
| road | `Road` occupant |
| **vehicle, ship** | agent |

Aeroplanes in particular sit *entirely* outside the tile layer — they are not even constrained to the grid — so adding them needs an agent system, not another stratum. Worth stating because "trains animating on the tracks" reads like tile work and is not: the track is tile data, the train is an agent.

## Migration

Strangler, not big bang. Feature work continued throughout, on both sides of the wire, in that order.

**Rust (#177/#181, landed first).** `city-sim-core`'s `Tile` moved off `kind` onto `terrain` + per-stratum `OccupantSet`s. `display.rs`'s `wire_kind`/`wire_flags`/`wire_underground` reconstructed a v4-shaped projection from the new strata for the wire, so the flip was invisible outside the crate at first — TS kept reading the same flattened bytes it always had.

**TS and the wire (nine-phase follow-up, 2026-07)** closed the gap that left open: the wire protocol and every TypeScript consumer converting from the flattened `kind`+flags spelling to strata, mirroring the Rust-side steps this section originally sketched —

1. Fork the legacy save-import wire layout off the live one (`legacy_tile_buffer.rs`), so the byte format backing old `.citysim` saves could be frozen without also freezing the live wire.
2. Flip the live wire buffer to carry occupant bits directly, deleting `display.rs`'s precedence derivation — the live format goes from 8 to 9 bytes/tile (one byte per stratum rather than packed, deliberately: see *Compatibility is mostly derivable* for why two concepts sharing a slot is the thing this whole model exists to avoid).
3. Decode the new wire into TS `Tile`'s `terrain`/`underground`/`surface`/`overhead` fields, behind a temporary shim that kept `kind`/`roadUnderlay`/`railUnderlay`/`powerOverlay`/`legacyUnderground` populated for not-yet-converted consumers.
4–7. Convert every consumer — shared predicates (`adjacency.ts`), the renderer, the UI layer and `mcpBridge.ts`, then the TS-only test oracle (`tools.ts`, `simulation.ts`, `stateHash.ts`, the parity harness) — one phase at a time, each independently tested.
8. Delete the shim fields from `Tile` and let `tsc --noEmit` prove every consumer had actually converted.
9. This doc.

`kind` narrows to what `legacyKind`/`legacyFlags` in `protocol/legacyProjection.ts` still need it for: importing old `.citysim` saves, and exporting the current strata back into the byte-exact-forever legacy format the frozen importer expects. Nothing else reads it — there is no field left to read.

Two originally-anticipated bugs came bundled with the TS-side conversion, both fixed as part of the rendering-layer phase: an undeveloped zoned lot crossed by a power line drew a debug "P" glyph instead of the wire (the renderer bailed out of compositing an overlay before a base sprite existed), and a power pole rendered straight through an already-built house instead of severing at the tile edge.

Step 8's compiler sweep is where the payoff showed up in practice: every remaining `tile.kind`/`.roadUnderlay` reference became a compile error, not a screenshot found six months later — including a genuine oracle-fidelity bug in `tools.ts` (an errant happiness bump on every terraform/infrastructure tool) that had nothing to do with the shim removal itself and would have been easy to miss without it forcing a full re-read of every call site.

The same re-read cut the other way once, and it is worth recording honestly. `tools.ts`'s `Tool.Bulldoze` handler used to clear the buried pipe only when the `underground` minimap mode was open; the oracle rewrite dropped that gating to match `commands.rs`'s current `bulldoze()`, which clears underground unconditionally, and the change was recorded at the time as a drift-bug fix. It was the opposite: the view-gated clearing was the deliberate behaviour (see *Bulldoze* above), and `commands.rs`'s view-blind version is itself a known regression, tracked in `docs/features/layer-scoped-bulldozer.md`. The oracle faithfully mirrored the engine — which was its job — but it mirrored the regression too; `tools.ts` and the rest of the TS shadow engine were removed 2026-07-30 (the oracle's last version is preserved at commit `1f8140a`), so it is now solely `crates/city-sim-core/src/commands.rs`'s `bulldoze()` that needs another pass when the `stratum`-scoped fix proposed in that doc lands.

## Open questions

All three raised in the first revision are now resolved. Kept with their answers, because the reasoning is the useful part.

1. ~~**Do occupants need per-tile state?**~~ **Resolved:** no. Flow is derived rather than authored, so it lives in per-network arrays beside the grid and occupants stay bare tags. See *Not yet designed: flow*.
2. ~~**Is `overhead` real, or is it just hydro?**~~ **Resolved: real.** Tree canopy is the second occupant, and putting it overhead rather than on the surface gives street trees for free while making trees-versus-conductors conflict by default. Both fall out of the stratum defaults with no rule written.
3. ~~**How many same-stratum exceptions are there really?**~~ **Resolved: exactly one** — road + rail, out of 19 pairs — provided the default is set per stratum rather than globally. See *Compatibility is mostly derivable*.
