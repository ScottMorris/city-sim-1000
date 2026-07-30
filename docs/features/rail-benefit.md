# Rail Benefit — Make Rail Worth Its Price

**Status:** promised, never implemented. The manual sells rail as functional; the engine gives it no effect at all.

## The gap

* `app/public/manual.html`: "Road / Rail: lay transport networks for citizens and freight." `docs/game-parameters.md` (under the *Adjacency draft* heading): "Rail: 4-way network; gives freight/passenger bonus if a zone is road-adjacent to any rail tile within 1 tile."
* Actual: no rail term exists in `demand.rs`, `economy.rs`, or `education.rs`. `Occupant::Rail` conducts power and water but explicitly not traffic (`crates/city-sim-core/src/occupants.rs:865-871`), so rail does not even grant zone road-access. Net: 15 to build (road is cheaper), 0.2/day upkeep (2× road), −2 eco score — for literally zero benefit. It is a strictly-worse road that also hurts the wilderness score.
* The `game-parameters.md` entry is honest about being a draft; `manual.html` states it to the player as fact.

## Recovery

Decide the mechanic, then implement — the draft rule is a reasonable start:

* **Freight/passenger bonus** (per the draft): zones road-connected to a rail tile within 1 tile get a demand and/or tax multiplier — industrial weighted toward freight, residential/commercial toward passengers. Small, legible, cheap to compute with the existing adjacency queries (`adjacency.ts` / the Rust reachability pass).
* Alternatives worth weighing before committing: rail as a traffic-capacity relief valve (needs a traffic model that doesn't exist yet — likely too early), or rail as an industrial-only freight requirement at scale (sharper, but punishes existing saves).
* Whichever lands: the bonus must be visible (tile inspector line, demand tooltip) or it will read as superstition.
* Interim mitigation if deferred: fix `manual.html` to stop promising freight value, and reconsider rail's upkeep/eco costs so it isn't a strictly-worse road.

## Codifying

* Golden-city scenario: identical zone layouts with and without rail adjacency diverge in demand/tax as specified.
* Promote the `game-parameters.md` draft row to a documented rule with the shipped numbers.

## Non-goals

* Trains as entities, stations, routing, or a traffic simulation — this is an adjacency bonus, in keeping with everything else in the sim.
* Subway (underground rail) — that arrives via the reserved `Occupant::Subway` bit and the view-layer model (`view-layers.md`), and should reuse whatever bonus shape ships here.
