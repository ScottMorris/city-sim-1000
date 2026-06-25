# AGENTS.md

## Coding Standards

- **Spelling:** Use Canadian English for everything except web-standard identifiers. Examples: `colour`, `centre`, `behaviour`, `organise`, `licence` (noun). CSS/DOM properties (`color`, `center`) keep their standard spelling.
- **Commit messages:** Use Conventional Commits (e.g., `feat: add scanner`, `fix: typo in header`).

## Commit Messages

**Format:** Conventional Commits — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, etc.

- Use `test:` for test-related changes, including fixes to tests (not `fix:` unless it fixes application code).
- Scope is optional but useful for large repos: `feat(sim_core):`, `fix(ui):`.

**Body requirements:**

- Explain what and why (not how)
- Use markdown: **bold**, _italics_, `code`, bullet lists
- **No markdown headings** — use **bold labels** for sections instead (not always required)
- Backtick all code references: type names, function names, file paths, flags, CLI commands

**Shell interpolation safety:**

Commit bodies often contain backticks and special characters. Always use a single-quoted heredoc and commit with `-F`:

```bash
cat > /tmp/msg.txt << 'EOF'
feat: add `TickEvent` streaming

Adds `build_tick_event()` in `commands.rs`. Streams `TileKind` u8 buffer
plus stats over `tauri::ipc::Channel` at 20 Hz.
EOF
git commit -F /tmp/msg.txt
```

Never pass markdown-heavy bodies via `git commit -m "..."` — backticks trigger shell substitution. After committing, verify with `git log -1 --pretty=fuller` and amend immediately if interpolation altered content.

## Pull Request Titles

**Requirement:** PR titles must be human-readable summaries — **no Conventional Commit prefixes**.

- Start with a capital letter (or a code term if that's the natural subject).
- Do not start with `feat:`, `fix:`, `chore:`, etc.
- Describe the outcome or behaviour change.
- Keep title style consistent across every open PR in the same stack.

Examples:
- ✅ `TauriSimBridge — native Rust simulation via Tauri IPC Channel`
- ✅ `Switch package manager from npm to bun`
- ❌ `feat(p4-2): TauriSimBridge — native sim via Tauri IPC Channel`

## Pull Request Merge Format

**Requirement:** Always merge with `--no-ff`. Never squash.

```bash
# Preferred: merge locally with proper message, then push
git merge --no-ff --no-edit <branch>
git commit --amend -F /tmp/merge-msg.txt
git push --force-with-lease origin <base-branch>

# Or via gh CLI (only when --merge is explicitly used):
gh pr merge <number> --merge
```

The merge commit message format matches GitHub's "Pull request title and description" setting:

```
PR title (#N)

PR body / description
```

Write the message to a temp file (single-quoted heredoc) before amending to avoid backtick interpolation.

## Pull Request Description Format

- `## Summary` section with flat bullets; use `###` sub-sections when grouping helps
- Use **bold lead-ins** for scanability: `- **`src/commands.rs`** — adds \`apply_tool()\``
- `## Test plan` section with checklist bullets (`- [x]` / `- [ ]`) and concrete commands
- Keep the summary focused on outcomes and behaviour, not commit history

## Pull Request Labels

Every PR must have at least one label. Primary categories:

`enhancement`, `bug`, `documentation`, `infrastructure`, `chore`, `refactor`

Use `gh pr edit <number> --add-label "<label>"` immediately after `gh pr create`.

## Licence and Copyright

New `.rs` and `.ts`/`.tsx` source files should include a header before `use`/`import` statements:

```rust
// Brief one-line summary of what this file does.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
```

- One blank line between the header and the first code line.
- Do not add headers to generated files, config files (`.toml`, `.json`, `.yml`), or markdown.
- Preserve existing valid headers when already present.

## Testing

- Run `bun run test` from the repo root after any TypeScript changes.
- Run `cargo test --workspace` after any Rust changes.
- After modifying Rust in `crates/`, run `bun run build:wasm` to regenerate `app/src/wasm/` before testing in the browser (gitignored; CI rebuilds it).

## Project Notes

- Water simulation is temporarily stubbed to a high balance; only power deficits gate growth until pipes/underground view ship.
- Roads and rail conduct power; power lines can overlay roads/rail without breaking access. Zoning cannot overwrite transport — bulldoze first.
- Docs to keep aligned with behaviour changes, in the same commit:
  - `README.md`
  - `docs/game-parameters.md`
  - `app/public/manual.html`
  - `SPEC.md`
