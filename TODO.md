Here are two ready-to-use prompts to resume later:

1. “Pick up the utilities re-org plan: when adding pipes/underground view, split domain data from UI costs (economy.ts vs configs), move building templates/state into buildings/templates.ts and buildings/state.ts, and create a utilities/ folder (power.ts, water.ts, future network/). Keep tool enums in toolTypes.ts and UI labels in ui/toolbarLabels.ts. Apply to current water tower/pump setup and prep for pipe network logic.”

2. “Implement pipes + underground view and finish the utilities structure. Add a functional pipes tool/network to feed water, adjust simulation water accounting, and hook rendering/selection into an underground layer. While doing this, reorganize files per the plan above. Run tests with npm test -- --pool=threads --poolOptions.threads.singleThread=true (default vitest multi-thread crashes here). Update docs/manual for the new view and pipes.”

- Underground utilities view with pipes and water network logic.
- road/rail intersections with power lines crossing above.
- road/rail connections to zones
- Power through water buildings
-
