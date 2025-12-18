Here are two ready-to-use prompts to resume later:

1. “Pick up the utilities re-org plan: when adding pipes/underground view, split domain data from UI costs (economy.ts vs configs), move building templates/state into buildings/templates.ts and buildings/state.ts, and create a utilities/ folder (power.ts, water.ts, future network/). Keep tool enums in toolTypes.ts and UI labels in ui/toolbarLabels.ts. Apply to current water tower/pump setup and prep for pipe network logic.”

2. “Implement pipes + underground view and finish the utilities structure. Add a functional pipes tool/network to feed water, adjust simulation water accounting, and hook rendering/selection into an underground layer. While doing this, reorganize files per the plan above. Run tests with npm test -- --pool=threads --poolOptions.threads.singleThread=true (default vitest multi-thread crashes here). Update docs/manual for the new view and pipes.”

- Underground utilities view with pipes and water network logic.
- road/rail intersections with power lines crossing above.
- road/rail connections to zones
- Power through water buildings
- Toolbar subnav border seam: investigate small blip at parent/subnav junction when submenu is open.
- TODO: Explore a districts system so bylaws (e.g., lighting standards like LEDs vs carbon arc lamps) can apply to targeted areas instead of the whole city.

## Co-worker suggestions

Kyle: carve out ecosystems for nature and balance it with industry/pollutants/hard surfaces.  This should be a wilderness metric 
- go plant a forest or place a duckpond for more wilderness
- place industrial and such for less wilderness
- what happens if the animals could speak?
- What are the consequences to the player?


Erin: Add people, they have lives, they have needs, they have families.  They know what they need to do, eg. go to market, go to school, go to job, die! They need health care, education, they need to do crime (murder most fowl), they need to self populate, they need markets to meet their needs and if not met then die...instance failure.  They need to figure that part out on their own...they need to be autonomous, they should be able to create space, but they don't know they need to do it to create space.  Wouldn't it be cool for them to do it on their own? They modify their environment, they plop buildings they run the city.  what if each agent was an LLM and they had the ability to think and take in data from around them in the simulation, and interact with the world.

- egotistical CEOs of companies that drive them to bankruptcy
- tech visionaries
- Scott: do research into statistics around population job distrobutions and understand how they connect together to create a mini virtual functioning society with semi-autonomous agents...
- IronG personalities - RNG‽
