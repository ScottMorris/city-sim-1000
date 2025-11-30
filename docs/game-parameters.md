# City Sim 1000 — Systems Outline

- **Core Loop**: Build infrastructure → zone → wait for growth → read feedback (demand, budget, utilities) → adjust. Convert resources (money, land, utilities) into capacity (population, jobs, happiness) while staying solvent.
- **Pillars**: Movement (roads/rail enabling adjacency and service reach), utilities (power/water networks gating growth), land use (zoning plus terrain shaping), economy (budget tick: revenue vs upkeep), and feedback (RCI bars, utility meters, overlays, warnings).
- **People as Outcome and Fuel**: Population and jobs are the payoff for capacity, but also drive revenue and unlock higher-value builds. They consume utilities and need access; deficits hurt happiness/demand, surpluses fund expansion. Jobs attract people; people fill jobs—keep both in balance.

## Interactions to Lock In
- **Adjacency rules**: What counts as connected for zones (road edge vs corner), rail freight/passenger bonus, power via lines only, water via pipes only. Zones can grow away from a road if they are orthogonally chained to a road-served zone.
- **Adjacency draft**:
  - Roads: 4-way orthogonal connectivity (no diagonal) for zoning reach, services, and traffic assumptions. Intersections auto-connect; roads and rail may cross with rules (rail over/under or shared tile if allowed).
  - Rail: 4-way network; gives freight/passenger bonus if a zone is road-adjacent to any rail tile within 1 tile (orthogonal) or directly orthogonal if sharing tiles is disallowed.
  - Power: 4-way flood fill through power lines and powered structures (plants, zones/buildings count as carriers if they have power); no diagonal hops.
  - Water: 4-way flood fill through pipes and water facilities; surface buildings do not conduct water unless explicitly a pipe.
  - Buildings count as “served” if any orthogonally adjacent tile satisfies the needed network (road for access, line for power, pipe for water).
- **Service gating**: Thresholds where power/water deficits halt growth or trigger decay; magnitude of happiness/demand penalties.
- **Maintenance vs revenue**: How upkeep scales relative to income; target cadence of build → wait → build.
- **Upgrade paths**: Pumps/towers → pipes; lines → plants; low → mid density; terraforming pricing that makes space trade-offs matter.
- **Space trade-offs**: Footprint of utilities/parks vs valuable zones; underground view to reduce surface clutter.

## Parameters to Decide Early
- Tile size and map size (cost for pathing/network recompute).
- Connection rules: roads 4-way or 8-way; rail interaction with roads; power only on lines; water only on pipes.
- Utility accounting: per-building power/water use and output, network loss (optional), maintenance per tile/building.
- Growth pacing: population/jobs per-tick caps; demand formulas; happiness effects on growth and decay.
- Budget model: base income, per-pop/job multipliers, upkeep curves, bulldoze refunds (if any).
- Tool costs: upfront vs ongoing; terraforming cheap or costly.

## Player Options in Terms of the Core
- **Terraform**: Unlocks buildable land and shapes flow; must be priced to matter.
- **Road/Rail**: Primary connectivity; rail as mid/late-game freight/passenger efficiency.
- **Power**: Plants with upkeep; lines as network graph; outages visibly stall zones.
- **Water**: Pumps/towers and pipes; underground view for clean management.
- **Zoning**: R/C/I with demand bars; growth tied to services and connectivity.
- **Amenities**: Parks/trees for happiness; future services can reuse road reach.

## Next Steps (Suggested)
1. Choose connection rules and deficit penalties (hard stop vs gradual decay) to guide balancing.
2. Rough in target economy numbers (income per pop/job, upkeep per tile/building) and simulate a 10–15 minute new-city arc.
3. Define overlays: road/rail connectivity, power, water, happiness so players can see what they are tuning.
