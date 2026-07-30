# Terraform and Elevation — Decide What the Tools Mean

**Status:** doc/implementation split that predates the stack but was never adjudicated. Elevation is dead data; two docs and a tool hint describe a system that doesn't exist.

## The gap

* `SPEC.md` (§Terraform): "Raise = height++ / Lower = height−− (min 0) / Water = convert to water tile only." `app/public/manual.html`: "Raise turns water back into land, Water floods land. They cost 10 and 12 a tile."
* Actual (`crates/city-sim-core/src/commands.rs:160-177`, mirrored in the oracle): `TerraformRaise → Terrain::Land`; **both** `TerraformLower` and `Tool::Water → Terrain::Water`. `tile.elevation` is serialized (`state.rs`, `import.rs`, `migrate.rs`) but written by no tool, read by no system.
* Consequences: Lower is a duplicate flood brush at cost 10 versus Water's documented 12, so every "digging a lake costs N" figure derived from the 12 (e.g. `docs/features/wilderness-score.md`'s 384) is actually the 10-credit path (320); and `toolInfo.ts`'s hint "use raise/lower to carve edges cleanly" describes nothing.

## Decision to make (then implement one branch)

**Option A — commit to flat terrain (recommended for now).** Land/Water is the terrain model; there is no height. Remove or repurpose `TerraformLower` (drop it, or make it the cheap flood brush *officially* and retire `Tool::Water`, keeping one price), drop the dead `elevation` field at the next snapshot-version bump (keep accepting it on legacy import), and fix `SPEC.md`/`manual.html`/tool hints to match. Cheap, honest, reversible later.

**Option B — implement elevation.** Height becomes real: rendering, water flow/adjacency, placement rules, pathing implications, save migration. This is a large feature, not a fix; if chosen it deserves its own design doc and should not block the doc-truth cleanup.

Either way, the current state — two tools that do the same thing at different prices, both contradicting the manual — should not survive.

## Codifying

* Whichever branch: golden-city coverage of every terraform tool's terrain result and cost, and a docs pass over `SPEC.md`, `manual.html`, `docs/game-parameters.md`, `toolInfo.ts` hints in the same change.

## Non-goals

* Bridges/docks/water gameplay (tracked by the tile model's building-over-water note), and the bulldozer's relationship to terrain — settled by #177 step 4 and untouched here.
