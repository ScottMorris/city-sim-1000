# AGENTS.md

## Commit Guidelines

- When generating commits, use the Conventional Commits spec.
- Ensure commit messages are clear and descriptive of the changes made.
- Write commit messages in the imperative mood (e.g., "fix bug" instead of "fixed bug" or "fixes bug").
- Include body text in commit messages when necessary to provide additional context.

## Tips

- Remember to update the readme or documentation if your changes affect usage or functionality.
- Commits should be atomic; each commit should represent a single logical change or complete context.
- Commit often to avoid large, unwieldy commits.
- Test your changes thoroughly before committing to ensure stability and reliability.
- Use `npm test -- --pool=threads --poolOptions.threads.singleThread=true` (vitest multi-thread crashes here).
- Manual is available in-game via the “Open manual” button (modal iframe at `public/manual.html`); keep the manual in sync with behaviour changes.

## Project Notes

- Water simulation is temporarily stubbed to a high balance; only power deficits gate growth until pipes/underground view ship.
- Roads and rail conduct power; power lines can overlay roads/rail without breaking access. Zoning cannot overwrite transport—bulldoze first. Transport tools clear existing buildings they overwrite.
- Docs to keep aligned:
  - `README.md`
  - `docs/game-parameters.md`
  - `public/manual.html`

## Canadian English Spelling

Documentation, code comments and variables use Canadian English:

- colour (not color)
- centre (not center)
- licence (not license - noun)
- organise (not organize)
- behaviour (not behavior)
- favour (not favor)

Code identifiers follow web standards (e.g., `color` in CSS, `center` in alignment).
