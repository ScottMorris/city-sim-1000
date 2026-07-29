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
- Do not mention internal planning documents, local worksheet names, or internal-only process artefacts (e.g. milestone codes like `M0-3`) in PR titles.

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

When a PR spans multiple kinds of change, use this fixed vocabulary for `###` sub-sections instead of ad hoc headings:

- `### User-facing changes`
- `### Maintainer-facing changes`
- `### Packaging`
- `### Workflow and infrastructure`
- `### Documentation`
- `### Known limitations`

If verification is incomplete, say so plainly under `## Test plan` rather than folding it into prose elsewhere.

## Pull Request Labels

Every PR must have at least one label. Primary categories:

`enhancement`, `bug`, `documentation`, `infrastructure`, `chore`, `refactor`

Use `gh pr edit <number> --add-label "<label>"` immediately after `gh pr create`.

## Git Workflow

- Do not push or force-push unless explicitly requested by the user.
- Do not commit local planning or scratch files unless the user explicitly asks for them to become part of the repository.

### Never destroy the undo path

**Do not run `git reflog expire`, `git gc --prune`, or `git prune`.** Not as cleanup, not to tidy up after a rewrite, not for any reason. These are repo-wide and irreversible: they destroy the undo path for *every* branch, not just the one being worked on, and they can orphan a stash — `git stash list` reads a reflog, so expiring it makes stashes vanish even though `refs/stash` still points at live objects.

This has already cost this repository its reflog once, during a `filter-branch` that did not need either command.

When rewriting history (which requires the branch to be unpushed, and should be verified as such first):

- Cut a backup branch before starting, and leave it until the user says otherwise.
- Leave `refs/original/` in place after `filter-branch`. It is the recovery path; deleting it is the user's call, not the agent's.
- Verify and report: same commit count, same subjects in the same order, same authors and both dates, and `git diff <old-head> HEAD` empty.
- Never let a history rewrite delete or repack objects as a side effect.

## Markdown Formatting

- Do not manually hard-wrap prose in markdown files (no inserting line breaks mid-paragraph to keep lines under some width). Let paragraphs run as single long lines and rely on the renderer/editor to soft-wrap.

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
