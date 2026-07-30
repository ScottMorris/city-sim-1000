# Growth Gating — Hard Promises, Soft Multipliers

**Status:** doc/implementation split. The manual describes hard requirements; the engine implements soft probabilities. One of them needs to move.

## The gap

* `app/public/manual.html`: "Growth needs power/water ≥ 0 and a road chain." `SPEC.md`: "Simulation spawns lots when demand is positive and utilities are available."
* Actual (`crates/city-sim-core/src/zones.rs`):
  * Road: `has_road || road_chain || is_frontier_zone` (`zones.rs:96-100`) — a zone touching any non-zone tile counts as frontier and can grow with no road anywhere.
  * Utilities: missing power/water and negative balances are probability multipliers (×0.15, ×0.35, floor 0.05 — `zones.rs:205-217`), not gates. Unpowered, roadless lots still develop, pay tax, and consume.
* `docs/game-parameters.md` documents the frontier rule correctly — the manual is the outlier — but the *utility softness* is documented nowhere player-visible.

## Decision to make

* **Option A — document the soft model (recommended).** The multipliers are arguably better game design than hard gates: early cities bootstrap without a perfect grid, and failure is gradual rather than binary. If kept, the manual must say so ("lots grow much slower without power, water, or roads"), and the numbers belong in `game-parameters.md` beside the frontier rule. Cheap; no sim change; no save impact.
* **Option B — harden the gates to match the manual.** Growth requires non-negative utility balances and a genuine road chain; frontier survives only as an explicit early-game bootstrap (e.g. first N buildings or until the first road exists), and that exception is documented. More legible, but changes the early-game feel and every golden fixture.

Either way the current state — a manual that gives players a false mental model of their own city — should not persist. Note the interaction with `sim-feedback-channel.md`: soft penalties are only fair if the player can *see* the penalty (icons/alerts), which is currently also broken.

## Codifying

* Golden-city scenarios pinning whichever model wins: roadless frontier growth rate, unpowered growth rate, and the documented multipliers/gates as literal asserted numbers.

## Non-goals

* Demand-model changes, tax tuning, or traffic — only the gating semantics and their documentation.
