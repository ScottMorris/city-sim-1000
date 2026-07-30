# Shore-Adjacency Placement Rules — Hydro and Pump

**Status:** specified, never enforced. `SPEC.md` states the rules; the in-game hint has quietly downgraded them to "flavour".

## Purpose

Water-dependent generators must be placed where the water is: a hydro plant borders ≥2 water tiles, a water pump borders ≥1. Geography becomes a real siting constraint, which is most of what makes terrain matter — and the "hydro" name keeps its meaning (a hydro *plant* is water-powered; see the naming convention in project memory).

## The gap

* `SPEC.md` (§Placement): "Hydro: must border ≥2 water tiles / Pump: must border ≥1 water tile."
* `place_footprint_building` (`crates/city-sim-core/src/commands.rs:430-514`) checks bounds, overlap, and occupant conflicts only — no terrain adjacency of any kind. A hydro plant in the middle of a desert generates at full output.
* The only consumer of `POWER_PLANT_CONFIGS[Hydro].requiresWaterEdge` (`app/src/game/constants.ts:34`) is a tool hint (`toolInfo.ts:181`): "Place along water edges for flavour; placement rules will tighten with pipes." `manual.html` has followed the hint rather than the SPEC.

## Recovery

* Enforce at placement in `place_footprint_building`: count `Terrain::Water` tiles orthogonally adjacent to the footprint perimeter; refuse with a clear message ("Hydro plants need at least 2 water edges") below the threshold. Surface the refusal via the command-result path (`sim-feedback-channel.md` is a prerequisite for the message to reach the player).
* Decide the terraform interaction: if the player later drains the adjacent water, does the plant keep running (grandfathered) or go inactive (a runtime gate like the pump's, see `water-source-gating.md`)? Recommendation: runtime gate for the pump (it already needs one for production), grandfather the hydro plant initially — a retroactive hydro shutdown without the alerts channel would be another silent failure.
* Client-side preview: the placement ghost should show valid/invalid before the click, reusing the footprint-fit rendering.
* Realign the three sources of truth — `SPEC.md` (rule), `manual.html` (player promise), `toolInfo.ts` (hint) — in the same change.

## Codifying

* Engine unit tests + a parity scenario per building: desert placement refused, shoreline accepted, threshold edge (exactly 1 vs 2 water edges for hydro).

## Non-goals

* Water quality, flow direction, or intake/outflow modelling.
* Retroactive invalidation of existing saves' plants (grandfather everything on import).
