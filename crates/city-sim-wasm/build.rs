// Stamps the git revision into the WASM binary so the running engine can say
// which source it was built from.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use std::process::Command;

/// Run a git command from the crate directory, returning trimmed stdout.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8(out.stdout).ok()?.trim().to_owned())
}

fn main() {
    // Re-run when the checked-out commit moves. `--git-path` is used rather
    // than a hard-coded `../../.git/HEAD` because in a git worktree `.git` is a
    // *file* pointing elsewhere, and the real HEAD lives outside this tree.
    // Cargo already re-runs this script when any file in the package changes,
    // which covers editing the source; this covers committing or switching
    // branches without touching it.
    for path in ["HEAD", "index"] {
        if let Some(p) = git(&["rev-parse", "--git-path", path]) {
            println!("cargo:rerun-if-changed={p}");
        }
    }

    // `unknown` rather than a build failure: a tarball checkout, a container
    // without git, or a vendored build must still compile. A version string is
    // diagnostics, and diagnostics may never be the reason a build breaks.
    let sha = git(&["rev-parse", "--short=9", "HEAD"]).unwrap_or_else(|| "unknown".into());

    // A dirty tree is the normal state while iterating, and exactly when
    // "which engine am I running" gets asked — so say so, rather than implying
    // the binary is that commit.
    let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    let label = if sha == "unknown" {
        sha
    } else if dirty {
        format!("{sha}-dirty")
    } else {
        sha
    };

    println!("cargo:rustc-env=CITY_SIM_GIT_SHA={label}");
}
