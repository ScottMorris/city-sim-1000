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
- Use `bun run test` from the repo root (root `package.json` proxies to `app/`; singleThread flag is baked into the script); or `cd app && bun run test` directly.
- After modifying any Rust in `crates/`, run `bun run build:wasm` to regenerate `app/src/wasm/` before testing the browser. This directory is gitignored; CI rebuilds it automatically.
- Manual is available in-game via the “Open manual” button (modal iframe at `app/public/manual.html`); keep the manual in sync with behaviour changes.
- When docs/specs change, commit those updates alongside the related code change.
- Label every PR with at least one label: `bug`, `enhancement`, `documentation`, `infrastructure`, or `chore`. Use `gh pr edit <number> --add-label “<label>”` immediately after `gh pr create`.

## Project Notes

- Water simulation is temporarily stubbed to a high balance; only power deficits gate growth until pipes/underground view ship.
- Roads and rail conduct power; power lines can overlay roads/rail without breaking access. Zoning cannot overwrite transport—bulldoze first. Transport tools clear existing buildings they overwrite.
- Docs to keep aligned:
  - `README.md`
  - `docs/game-parameters.md`
  - `app/public/manual.html`
  - `SPEC.md`

## Canadian English Spelling

Documentation, code comments and variables use Canadian English:

- colour (not color)
- centre (not center)
- licence (not license - noun)
- organise (not organize)
- behaviour (not behavior)
- favour (not favor)

Code identifiers follow web standards (e.g., `color` in CSS, `center` in alignment).
