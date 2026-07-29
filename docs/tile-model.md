# Tile model — a stratum-based design note

**Status:** proposal, not implemented. Written to be argued with.

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

Networks are inherently multi-valued and are being stored in a single-valued slot, with the overflow spilling into ad-hoc booleans. Any consumer that checks the slot but not the overflow silently under-counts, and nothing tells you.

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
    surface:     OccupantSet,        // trees, road, rail, zone, structure
    overhead:    OccupantSet,        // power lines, street trees
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

Hydro *wins* the data slot (roads and rails yield, because they have underlay flags to fall back on) but *loses* the visual contest (roads draw first and ignore everything; hydro's pole has to dodge). The data ordering was never a layering decision — it came from which occupant had somewhere else to be stored, which is an implementation accident.

Under strata the data ordering **disappears entirely**, because nothing is contested. Only the visual one survives, and it is just the physical stack: underground → surface → overhead. One ordering, and it means what it says.

**Network membership is a property, not a slot.** This is the correction to an earlier sketch that had `networks` as a sibling of `cover`: a road is surface cover that *happens to conduct*. So is a zone — `is_power_carrier` already returns true for roads, rails and zones, that fact just isn't written down anywhere as data.

```
Occupant → { eco, upkeep, conducts: set<Network>, stratum, … }
```

## Compatibility is mostly derivable

The permutation matrix already exists in the codebase — smeared across hand-written guards in `Tool::Road`, each zone tool, `place_footprint_building` and `Tool::PowerLine`. Every guard is a row of a table nobody has ever seen whole, which is exactly why two of them disagreed about the road/hydro interaction.

Strata make most of the table fall out:

- **same stratum → conflict by default**
- **different stratum → coexist by default**

The exceptions then become a short, readable list instead of the general case. Known exceptions so far:

- road + rail on one surface tile — the level crossing, deliberate
- trees yield to everything on their stratum

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

The tile stays a dumb storage unit. `development: Option<BuildingId>` points at an instance; the instance's template carries output, upkeep, footprint, category and placement predicates. This is already how `BuildingInstance` + `get_building_template` work, and it is the property that lets a new building type be added without plumbing changes.

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

Strangler, not big bang. Feature work continues throughout.

1. Add a derived accessor (`tile.occupants(stratum)`) computed from today's `kind` + flags. No behaviour change.
2. Convert consumers one at a time to the accessor. Each conversion is individually testable, and each gets a coverage-matrix-style test pinning its behaviour.
3. When no consumer reads `kind` for a multi-valued question, flip the storage: strata become authoritative and `kind` narrows to terrain. Snapshot version bumps here, and only here.

**Sizing the sweep**, measured rather than guessed: 180 references to `tile.kind` / `TileKind::` across nine non-test files in `city-sim-core` (`wilderness.rs` 49, `commands.rs` 42, `economy.rs` 23, `education.rs` 19, and the rest in single digits), plus 27 TypeScript files in `app/src/game` and `app/src/rendering`. Not all of them are multi-valued questions — many legitimately ask about terrain — but that is the search space, and step 2 is what shrinks it before anything breaks.

Step 3 is where the compiler earns its keep: narrowing `kind` makes every stale `TileKind::Road` comparison fail to compile, so the remaining wilderness-shaped bugs are found by `cargo check` rather than by a screenshot six months later.

## Open questions

1. ~~**Do occupants need per-tile state?**~~ **Resolved:** no. Flow is derived rather than authored, so it lives in per-network arrays beside the grid and occupants stay bare tags. See *Not yet designed: flow*.
2. **Is `overhead` real, or is it just hydro?** If nothing else ever goes up there, an honest `power: bool` is cheaper than a stratum. Street trees along a road would settle it — they are physically overhead, they genuinely conflict with power lines (utilities trim canopy away from conductors), and they would give the stratum a second occupant and a new sprite group. That is a game-design call, not an engineering one, and it decides the scope of this whole proposal.
3. **How many same-stratum exceptions are there really?** If road + rail is the only one, derivation carries the entire table. If there turn out to be five, the table wants to be explicit data regardless.
