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
  - Water: 4-way flood fill through pipes and water facilities (Pumps/Towers). Roads and rail also conduct water; zones/buildings count as carriers if they have water. Underground pipes connect sources to the network.
  - Buildings count as “served” if any orthogonally adjacent tile satisfies the needed network (road for access, line for power, pipe/road for water).
- **Service gating**: Thresholds where power/water deficits halt growth or trigger decay; magnitude of happiness/demand penalties.
- **Feedback hooks**: Sticky warnings fire when utilities go negative (power/water) and a follow-up toast confirms recovery once the balance returns above zero. Budget panel surfaces a monthly net projection with colour-coded surplus/deficit plus a month/day readout to keep solvency visible. A Budget screen (from the HUD) adds quarterly totals, per-month net, and runway hints, with revenue (base stipend + residents/commercial/industrial) and expense breakdowns (transport vs buildings).
- **Tool clarity**: Tool info card sits with the tile inspector; it shows cost/upkeep/output plus hints and can be pinned always-on. Tile inspector only appears while the Inspect tool is active.
- **Maintenance vs revenue**: How upkeep scales relative to income; target cadence of build → wait → build.
- **Upgrade paths**: Pumps/towers → pipes; lines → plants; low → mid density; terraforming pricing that makes space trade-offs matter.
- **Space trade-offs**: Footprint of utilities/parks vs valuable zones; underground view to reduce surface clutter.

## Recent Playtest Notes (Dec 3, 2025)
- Debug panel is visible in the production build (Show overlay/Copy state/penalties). Hide or gate it behind a dev toggle so players do not see QA affordances.
- Headless Chromium fell back to software WebGL; confirm hardware-accelerated WebGL in normal browsers and consider a graceful warning if acceleration is missing.
- Landing flow drops players into a blank map with no onboarding. Add a first-run cue (“Place a road and connect power, then paint Residential”) plus a quick link to the manual.
- Demand bars start partially filled without explanation; add tooltips or a short hint about what drives each bar (jobs, vacancies, happiness, power).
- Starting cash is $0; double-check that the base stipend lets players place early essentials without stalling, or seed a small upfront budget/task reward.
- Save/Download/Upload wording should clearly reflect LocalStorage versus file saves and stay disabled until a city exists.

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
- **Water**: Pumps/towers and pipes; underground view for clean management. Roads/rail conduct water to simplify early expansion; pipes connect distant sources.
- **Zoning**: R/C/I with demand bars; growth tied to services and connectivity.
- **Amenities**: Parks/trees for happiness; future services can reuse road reach.

## Demand & Over-zoning
- Starter demand is seeded at 50/30/30 when the city is empty so pre-painted zones can begin to grow before normal formulas take over.
- Base demand terms:  
  - Residential: `70×(1 - fillR)` + `60×vacancyRate` − `80×unemploymentRate`. Empty housing and open jobs lift R demand; jobless workers cool it.  
  - Commercial: `50×(1 - fillC)` + `30×unemploymentRate` + `20×(population / resCapacity)` for customer pressure.  
  - Industrial: `55×(1 - fillI)` + `80×unemploymentRate` + `20×(max(0, 0.95 - fillI))` − `20×vacancyRate` so slight underfill keeps a trickle even when vacancies are present.  
  (fillR/C/I are capped 0–1; unemployment/vacancy are aggregate rates from labour stats.)
- Soft over-zoning: pending zones apply a mild penalty (Res -0.45 each, Com/Ind -0.35 each) capped to the lower of 35 or 60% of the current base term. High pressure (base > 60) shaves half of that penalty so strong demand can punch through.
- Trickle floor: when a zone type is under 92% full, demand is floored at 8 before utility penalties so large painted areas grow slowly instead of stalling at 0. Power deficits still subtract 15 (7.5 for Com/Ind) after the floor.

## Decay & Abandonment
- Each zone building tracks `troubleTicks`. Low demand (<10), no power, or unhappy tiles (<0.4 happiness) add pressure; healthy conditions bleed it down.
- When `troubleTicks` passes the abandon threshold, the building is cleared and marked abandoned: capacity drops to 0 so demand can rebound, and the zoned tile is left ready to regrow automatically. A future option toggle/downgrade path can replace auto-regrow later.

## Services & Amenities Draft (Stub)
- **Scope**: Police, fire, and health share the same pattern for now. Each has a coverage radius that travels along roads, a per-building capacity (how many tiles/people can be “served”), build cost, and upkeep. No dispatch sim yet—just reach + capacity.
- **Service definitions**: Add a `ServiceType` shape with id/name, build cost, upkeep, coverage radius (in tiles), capacity, and a base happiness/decay modifier when served vs unserved. Keep numbers modest (e.g., radius 6–10 tiles, upkeep scaled to early-game budgets).
- **Map state hooks**: Track per-tile `serviceScores` (0–100) keyed by service id plus a boolean `isServed`. Coverage is road-flood-fill within radius until capacity runs out; powered/road-connected stations only. Scores feed overlays and growth gating.
- **Building state hooks**: Service buildings maintain `slotsUsed` (load) vs capacity. Zones track whether each service is available for growth/decay calculations. Parks stay as a pure happiness bonus; do not consume capacity.
- **Effects for now**: Served tiles avoid a small decay penalty and gain a small happiness boost; unserved tiles incur a mild penalty. Industrial tiles add a small fire risk multiplier that can later drive incidents.
- **UI hooks**: Overlays per service reading `serviceScores`; build tooltip shows cost, upkeep, radius, capacity. A shared “underserved” icon can appear on tiles/zones missing required coverage.
- **Future depth (later)**: Incident spawning by density/hazard, dispatch travel time on roads, queues per station, staffing/budget sliders, and specialised buildings (clinic vs hospital). These plug into the same data shapes without reshaping state.

## Next Steps (Suggested)
- **Visuals**: Build a sprite atlas (road/rail crossings, power-over-road, zone variants, construction states); add subtle animations (water tiles, lit windows at night).
- **Pipes & Underground**: Finish water network with pipes + underground view toggle; water deficit penalties; overlay for pressure/flow; restore water sim (remove stub).
- **Economy & Demand**: Tune upkeep vs revenue; add service costs; consider tax sliders or policy modifiers; introduce happiness-driven decay for underserved zones.
- **Feedback/Overlays**: Add road/rail connectivity overlay, power overlay, happiness/land-value heatmap; show build timers; add on-tile icons for “no road/power”.
- **Transport Depth**: Rail freight bonus for industrial; intersections sprites; bridges/tunnels later; maybe one-way roads or avenue upgrade.
- **Zoning Depth**: Density upgrade paths; abandoned/derelict states; small construction delay visuals; prevent isolated clusters from staying forever if cut off.
- **Services/Amenities**: Parks impact radius; add fire/health placeholders; basic pollution/happiness modifiers for industrial proximity.
- **Education**: Elementary and High Schools sit under a new Education submenu. Coverage flood-fills along roads within 8–9 tiles, consumes seats based on nearby zone capacity, and powers a blended education score. Low coverage trims Residential demand and nudges decay trouble upward; poor high-school reach adds a workforce penalty to Commercial/Industrial demand. Schools require power and add upkeep to the civic budget bucket.
- **Persistence/UX**: Manual modal (done), add hotkeys/help overlay, autosave cadence toggle; seed maps (random vs flat); settings panel for input options (e.g., invert keyboard pan).
- **Performance/Testing**: Deterministic utility network tests; profiling for large maps; consider web worker for sim step if needed.
- **UI/Navigation**: Minimap anchored to the bottom-right HUD for quick orientation on large maps. Base view is live (terrain/zones/roads/rail/power lines/buildings) with click-to-jump camera controls and a viewport rectangle; power, water, and alerts overlay modes are available and also tint the main map for quick at-a-glance feedback. Limit canvas size and coarsen sampling on huge maps to stay performant.

## Radio widget (toolbar)
- Sits on the toolbar to the left of the Budget button with emoji controls (⏮️/▶️/⏸️/⏭️) plus a playlist-icon button that opens the station dropdown.
- The dropdown lists entries from `public/audio/radio/stations.json`, each pointing at a subfolder and its `playlist.json`. Switching stations reloads the playlist/cover metadata without touching the rest of the UI.
- Hover/focus reveals a popover with full title/artist details and the cover preview when provided; missing covers stay hidden. While paused the marquee name stays in place, and it scrolls when the track is playing.
- Each station playlist lives at `public/audio/radio/<station>/playlist.json` with `{ version, tracks: [{ id, title, artist, src, cover?, duration?, loudnessLufs?, loop?, fallbackSrc? }] }`. Prefer Opus (48 kHz, ~64–96 kbps); add fallbacks (`.ogg`/`.mp3`) only if necessary and list them in `fallbackSrc`. Missing or empty playlists deliver “Radio offline” and disable controls until new files appear.
- Helper script: `npm run build:radio-playlist` now scans every station folder it finds, writes each station’s `playlist.json`, converts covers, and emits `public/audio/radio/stations.json`. Flags are unchanged: `--meta <file>` for per-track overrides, `--default-artist "Name"`, `--extract-embedded-covers`, `--force`, `--convert-opus` to transcode non-Opus sources, and `--dry-run`.

## Controls & Hotkeys
- Movement: `WASD` or arrow keys for panning; scroll wheel/pinch to zoom.
- Inspect: `I`.
- Minimap: `M` toggles the minimap panel.
- Terraform: Raise `E`, Lower `Q`.
- Painting: Water `F`, Trees `T`.
- Transport & Utilities: Road `R`, Rail `L`, Power Lines `P`, Hydro Plant `H`, Water Pump `U`, Water Tower `Y`.
- Zoning & Amenities: Residential `Z`, Commercial `X`, Industrial `C`, Park `K`.
- Bulldoze: `B`.
- Simulation Speed: `1` Slow (0.5x), `2` Fast (1x), `3` Ludicrous (3x).

### Settings Backlog (Input)
- A settings modal now exists (gear button in the toolbar) with the over-zoning penalty toggle, minimap controls, pan inversion/pan speed presets, Shift+scroll-to-pan, zoom sensitivity, radio volume, and a Gemini sprite toggle (off by default). Edge scroll, hotkey remapping UX, higher-contrast/reduced-motion, and SFX are stubbed but not wired yet.
- Toggle for keyboard pan inversion and pan speed preset.
- Hotkey remapping with conflict hints and reset-to-defaults.
- Edge scroll enable/disable and speed when added.
- Zoom sensitivity clamp and optional Shift+scroll to pan instead of zoom.
- Accessibility toggles: reduced motion and higher-contrast overlays/tooltips.
