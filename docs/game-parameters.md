# City Sim 1000 — Systems Outline

- **Core Loop**: Build infrastructure → zone → wait for growth → read feedback (demand, budget, utilities) → adjust. Convert resources (money, land, utilities) into capacity (population, jobs, happiness) while staying solvent.
- **Pillars**: Movement (roads/rail enabling adjacency and service reach), utilities (power/water networks gating growth), land use (zoning plus terrain shaping), economy (budget tick: revenue vs upkeep), and feedback (RCI bars, utility meters, overlays, warnings).
- **People as Outcome and Fuel**: Population and jobs are the payoff for capacity, but also drive revenue and unlock higher-value builds. They consume utilities and need access; deficits hurt happiness/demand, surpluses fund expansion. Jobs attract people; people fill jobs—keep both in balance.

## Interactions to Lock In
- **Adjacency rules**: What counts as connected for zones (road edge vs corner), rail freight/passenger bonus, power via lines only, water via pipes only. Zones can grow away from a road if they are orthogonally chained to a road-served zone; otherwise only frontier tiles (touching empty land) can start without a road.
- **Adjacency draft**:
  - Roads: 4-way orthogonal connectivity (no diagonal) for zoning reach, services, and traffic assumptions. Intersections auto-connect; roads and rail may cross with rules (rail over/under or shared tile if allowed).
  - Rail: 4-way network; gives freight/passenger bonus if a zone is road-adjacent to any rail tile within 1 tile (orthogonal) or directly orthogonal if sharing tiles is disallowed.
  - Power: 4-way flood fill through power lines and powered structures (plants, zones/buildings count as carriers if they have power). Roads and rail also conduct power; power lines can overlay road/rail without breaking access. No diagonal hops.
  - Water: 4-way flood fill through pipes and water facilities; surface buildings do not conduct water unless explicitly a pipe. (Temporarily disabled in simulation—water balance is fixed high while plumbing is built out.)
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
- **Power**: Plants with upkeep; lines as network graph; outages visibly stall zones. Roads/rail can conduct power; power lines can overlay roads/rail.
- **Water**: Pumps/towers and pipes; underground view for clean management. (Temporarily disabled in sim until pipes arrive.)
- **Zoning**: R/C/I with demand bars; growth tied to services and connectivity.
- **Amenities**: Parks/trees for happiness; future services can reuse road reach.

## Next Steps (Suggested)
- **Visuals**: Build a sprite atlas (road/rail crossings, power-over-road, zone variants, construction states); add subtle animations (water tiles, lit windows at night).
- **Pipes & Underground**: Finish water network with pipes + underground view toggle; water deficit penalties; overlay for pressure/flow; restore water sim (remove stub).
- **Economy & Demand**: Tune upkeep vs revenue; add service costs; consider tax sliders or policy modifiers; introduce happiness-driven decay for underserved zones.
- **Feedback/Overlays**: Add road/rail connectivity overlay, power overlay, happiness/land-value heatmap; show build timers; add on-tile icons for “no road/power”.
- **Transport Depth**: Rail freight bonus for industrial; intersections sprites; bridges/tunnels later; maybe one-way roads or avenue upgrade.
- **Zoning Depth**: Density upgrade paths; abandoned/derelict states; small construction delay visuals; prevent isolated clusters from staying forever if cut off.
- **Services/Amenities**: Parks impact radius; add fire/health placeholders; basic pollution/happiness modifiers for industrial proximity.
- **Persistence/UX**: Manual modal (done), add hotkeys/help overlay, autosave cadence toggle; seed maps (random vs flat); settings panel for input options (e.g., invert keyboard pan).
- **Performance/Testing**: Deterministic utility network tests; profiling for large maps; consider web worker for sim step if needed.

## Controls & Hotkeys
- Movement: `WASD` or arrow keys for panning; scroll wheel/pinch to zoom.
- Inspect: `I`.
- Terraform: Raise `E`, Lower `Q`.
- Painting: Water `F`, Trees `T`.
- Transport & Utilities: Road `R`, Rail `L`, Power Lines `P`, Hydro Plant `H`, Water Pump `U`, Water Tower `Y`.
- Zoning & Amenities: Residential `Z`, Commercial `X`, Industrial `C`, Park `K`.
- Bulldoze: `B`.
