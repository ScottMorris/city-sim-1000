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

## Branch Naming

**Requirement:** Every new branch name starts with a type prefix — the same types as Conventional Commits — followed by a slash and a short kebab-case description.

- Allowed prefixes: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, `infra/`.
- ✅ `fix/bulldoze-underground-view`, `docs/feature-recovery`, `refactor/live-wire-flip`
- ❌ `shim-removal`, `ts-migration-docs`, `feature-recovery-docs` (real examples — the tile-model stack and its docs branch predate this rule and are grandfathered; everything after them must carry a prefix)
- Pick the prefix that matches what the branch's PR will be labelled: a bug fix is `fix/`, docs-only is `docs/`, and so on. Stacked branches each carry their own prefix; there is no stack-wide exception.

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

## Issue Linking and Closing

**A single PR that fully resolves a tracked issue** uses a closing keyword in its body — `Fixes #N` / `Closes #N` — so merging it auto-closes the issue. No follow-up needed.

**A multi-PR stack against the same issue**: every PR before the last one references the issue without a closing keyword (`Part of #N`) — a keyword there would close the issue while the rest of the stack is still open. **The final PR in the stack does use the closing keyword**, so merging it auto-closes the issue the normal way; no manual close step needed in the common case.

- If you don't yet know a PR is the last one when you open it, don't guess — leave the keyword off and close manually once you confirm nothing else is left, per the fallback below.
- Fallback (keyword missed, or a manual close is genuinely called for): `gh issue close <N> --comment "<summary of every PR that merged, and anything explicitly deferred to a separate tracked issue>"`.
- Either way, verify the issue actually closed — `gh issue view <N> --json state` — don't assume a closing keyword did its job, and don't assume a manual close command succeeded either.

This applies to every multi-PR task, not just ones with an explicit "PR 1/2, PR 2/2" plan — if a task's last commit lands and there's a tracked issue for it, closing that issue is part of finishing the task, not a separate step to remember later.

## Pull Request Drafts

Open PRs ready for review by default — do not pass `--draft` to `gh pr create` unless the user explicitly asks for a draft.

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

Every `.rs`, `.ts`/`.tsx`, and `.sh` file — including extensionless shebang scripts like git hooks — carries a header. This applies whenever such a file is created *or* edited: if it's missing the header, add it as part of that same change, not just on brand-new files.

Rust/TypeScript headers go before `use`/`import` statements:

```rust
// Brief one-line summary of what this file does.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
```

Shell script headers go after the `#!` line:

```bash
#!/usr/bin/env bash
# Brief one-line summary of what this script does.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT
```

- One blank line between the header and the first code line.
- Do not add headers to generated files, config files (`.toml`, `.json`, `.yml`), or markdown.
- Preserve existing valid headers when already present.

## Testing

- Run `bun run test` from the repo root after any TypeScript changes.
- Run `cargo test --workspace` after any Rust changes.
- After modifying Rust in `crates/`, run `bun run build:wasm` to regenerate `app/src/wasm/` before testing in the browser (gitignored; CI rebuilds it). `bun run test` no longer needs it: the cross-engine parity harness that required it was retired with the TS oracle, and no test file touches the built WASM artifacts.
- `docs/testing.md` is the map: the three architecture harnesses (golden city, visual regression, soak), what each does and does not cover, every command, and the remaining gaps.
- **Regenerating a committed baseline is a deliberate act.** `golden_city.expected` and the screenshots under `app/e2e/__screenshots__/` are derived artefacts, so a wrong derivation and a stale expectation look identical from the outside. Never regenerate to make a build pass; name and justify every line or image that moved, in the same commit as the behaviour change that moved it. See `docs/testing.md`.

### Test names

Don't put issue numbers in test names (`fn` names, `it(...)`/`describe(...)` titles) — `#200` in a name goes stale the moment the code around it is refactored or the fix is folded into something bigger, and it reads as though the *test* belongs to the issue rather than to the behaviour. Name the test after the behaviour it pins; put the issue number in a comment or doc comment above it instead, where there's room for the actual context (what regressed, why this shape of test proves it).

### Prove a test has teeth

**When you add or change a test, break the thing it covers and confirm the test goes red. Then revert, and state the mutation and its result.** A test that cannot fail is worse than no test: it reports safety that does not exist, and it is invisible without this step.

This is not optional diligence, it is the deliverable. Real examples from this repo, all found only because someone mutated the source:

- `a_line_in_the_overlay_flag_alone_carries_power` passed `Some(1)` for `building_id`, which short-circuits `Tile::conducts` before the occupant set is read. Setting `OCCUPANT_DEFS[PowerLine].conducts` to `NET_NONE` left it green while the power grid went dark.
- The soak advertised "Allocation stays bounded" as an enforced property. Both checks only pushed strings into a report the test printed and passed.
- A visual regression test set `maxDiffPixels: 0` and documented an exact match, but left Playwright's per-pixel `threshold` at its default `0.2` — so it could not see the colour shift it existed to catch.

**Choose the mutation to match the failure mode, not just to be red.** A mutation that passes is only evidence about the mutation you picked. The soak's allocation check was proved to have teeth with a leak sized by the tick counter, went red, and was written up as sound — but the check compares a *rate*, so it was blind to a leak of constant size by construction. A never-drained `Vec` taking peak heap from 0.05 MiB to 100.05 MiB kept the ratio at 1.01× and passed, while the doc comment above it advertised "bounded heap". Ask what the check is *shaped* to miss, then mutate that.

The same trap applies to where you run it: `threshold: 0` in the visual harness was verified locally, three parallel repeats green, and still failed CI — reproducible on one machine is not identical across machines. A property that only holds on your hardware has not been proved.

`cargo mutants` automates this for Rust (see **Mutation testing** below); it does not replace doing it deliberately for the specific property you just claimed to pin.

### Mutation testing

`cargo mutants` changes one thing in the Rust source — an operator, a return value, a whole function body — and reruns the tests. If they still pass, that line is covered in the sense that something executed it and in no sense that anything checked it.

Run it on your own change before pushing, which is the same slice CI runs:

```bash
git diff origin/main...HEAD > mutants.diff
cargo mutants --in-diff mutants.diff --baseline run --timeout 20
```

Configuration lives in `.cargo/mutants.toml`, which records why each exclusion is there. Preview what it selects with `cargo mutants --list-files` and `cargo mutants --list`. `mutants.out/` is the run report and is gitignored.

Two CI jobs use it. Both are configured `continue-on-error`, so neither can fail a merge:

- **`rust-mutants-diff`** in `.github/workflows/ci.yml`, on every pull request. `--in-diff` mutates only code the pull request touched, so the cost tracks the change rather than the codebase. Surviving mutants land in the job summary, as GitHub annotations on the diff, and as a count in the CI summary comment.
- **`rust-mutants-full`** in `.github/workflows/mutants-full.yml`, weekly and on `workflow_dispatch`. Whole workspace, uploaded as an artefact — a work queue, not a verdict.

The advisory setting is deliberate rather than timid, for two reasons that both have to stop being true before `rust-mutants-diff` becomes a gate. `--in-diff` covers whole functions the diff touched, not only the lines, so a one-line edit inside a thinly tested function surfaces that function's pre-existing gaps as if they were yours. And equivalent mutants are common enough here to fail honest work: `DERIVED_FLAG_MASK` in `state.rs` is three disjoint bits joined with `|`, and rewriting that `|` as `^` produces the identical byte, so no test can ever distinguish it. Combining disjoint flag bits is a shape this codebase uses in a dozen places, and every one of them is a survivor by construction. Flip it to blocking when a full-run triage has emptied the inherited backlog and the equivalent-mutant families are excluded by name in `.cargo/mutants.toml`, not before.

**A surviving mutant is a question, not a defect.** Before writing a test, work out which kind you have:

- *A real gap* — the mutated behaviour is one a reader would expect a test to pin. Write the test.
- *An equivalent mutant* — the mutation cannot change behaviour, so no test can ever kill it. `FLAG_A | FLAG_B` mutated to `FLAG_A ^ FLAG_B` over disjoint bits is the same value. Say so in the pull request rather than adding a test that proves nothing.

Answering in the pull request is the deliverable either way; a silent survivor is indistinguishable from an unexamined one.

Two limits worth knowing, because they change what MISSED means:

- Mutants are judged by the crate's unit tests only (`--lib`). Behaviour covered solely by an integration test or a doctest will be reported MISSED.
- Diffs that only change test code produce no mutants at all, so this cannot tell you a new test is weak — that is what breaking the code by hand is for.

## Claims must be checkable

Prose describing code is written from *intent*, and nothing makes it meet the code again afterwards. Reviews of this repo have repeatedly found more wrong explanations than wrong code — a comment asserting a safety mechanism the code did not have, a test named for a property it did not check, figures that reproduced only under a different scenario than the one described. A confident wrong comment is worse than no comment, because it tells the next reader not to check.

Prefer claims the build can check over claims a reader must trust.

- **Put load-bearing behaviour in a doctest, not a paragraph.** A ` ```rust ` block in a doc comment runs under `cargo test`, so it cannot drift. Reach for one whenever you catch yourself explaining *what happens when*.
- **Measured numbers belong in generated artefacts, never in prose.** If a figure came from running something, it goes in a fixture that is regenerated — like `golden_city.expected` — so it cannot disagree with itself. A hand-copied number is stale the moment the code moves, and nothing will tell you.
- **Never cite a commit hash in code or docs.** Rebases delete them: nine references to one hash died in a single day. Cite the commit *subject*, a tag, or the behaviour itself.
- **Never write a "current status" section.** "The soak is currently red", "this test fails at the moment" — these rot within the hour and then actively mislead. State the invariant, not the weather. If a status genuinely must be recorded, generate it or date it explicitly.
- **When you change behaviour, grep for what described it.** The nearby comment is the one you will remember; the doc file, the test name, and the comment 1,700 lines away are the ones that drift.

## Project Notes

- Water simulation is temporarily stubbed to a high balance; only power deficits gate growth until pipes/underground view ship.
- Roads and rail conduct power; power lines can overlay roads/rail without breaking access. Zoning cannot overwrite transport — bulldoze first.
- Docs to keep aligned with behaviour changes, in the same commit:
  - `README.md`
  - `docs/game-parameters.md`
  - `app/public/manual.html`
  - `SPEC.md`
