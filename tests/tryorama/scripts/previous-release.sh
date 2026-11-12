#!/usr/bin/env bash
# Builds the DNA of an earlier release, for tests that move an account from
# it to this version (cross-version.test.ts): checks the release's commit
# out in a worktree of its own, builds its zomes, packs its DNA, and keeps
# it as tests/tryorama/fixtures/previous-release/, with where it came from.
#
#   scripts/previous-release.sh <commit> <version>
#
# Run it when a release ships, with that release's commit: the next version
# is tested moving from it.
set -euo pipefail
commit="$1"
version="$2"
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
work="$(mktemp -d)/release"
git -C "$repo" worktree add --detach "$work" "$commit" >/dev/null
trap 'git -C "$repo" worktree remove --force "$work"' EXIT
(cd "$work" && cargo build --quiet --release --target wasm32-unknown-unknown && hc dna pack dnas/handshake/workdir >/dev/null)
out="$here/fixtures/previous-release"
mkdir -p "$out"
cp "$work/dnas/handshake/workdir/handshake.dna" "$out/handshake.dna"
printf '{ "version": "%s", "commit": "%s" }\n' "$version" "$(git -C "$repo" rev-parse "$commit")" > "$out/release.json"
echo "kept $version ($commit): $(du -h "$out/handshake.dna" | cut -f1)"
