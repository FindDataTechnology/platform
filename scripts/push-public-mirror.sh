#!/usr/bin/env bash
# ── Push the open-source snapshot to the public image repo, keeping its workflows ──
#
# WHY THIS EXISTS (2026-11-10 incident)
# ------------------------------------
# `make-public-snapshot.mjs` deliberately excludes internal-TCR workflow files —
# `.github/workflows/image.yml` and `.github/workflows/image-publish.yml` — from the
# published snapshot (see its EXCLUDE list). The image-verify mirror repo, however,
# keeps `image-publish.yml` ON ITS OWN BRANCH: that file is what builds and pushes the
# platform image. A snapshot push is a whole-tree `--force` (the snapshot shares no
# history with the mirror), so every push DELETES that workflow unless it is carried
# over. On 2026-11-10 a push of 1499a38 did exactly that: `image` stopped firing while
# `CI` and `image-build-check` still ran green — a silent "pipeline still exists?" gap.
#
# WHAT IT DOES
# ------------
# 1. Fetches the mirror's current `main`.
# 2. Copies any file under `.github/workflows/` that exists on the mirror but is
#    absent from the snapshot (i.e. host-maintained workflows the scrubber strips).
# 3. Force-pushes the snapshot.
# 4. Re-reads `main` from the mirror and asserts every carried workflow is still
#    there — a push that loses one fails loudly instead of shipping a dead pipeline.
#
# The mirror stays the single source of truth for those workflows: nothing is cached
# locally, so they cannot drift.
#
#   scripts/push-public-mirror.sh dist-opensource/platform [--remote mirror] [--dry-run]

set -euo pipefail

SNAPSHOT_DIR="${1:?usage: push-public-mirror.sh <snapshot-dir> [--remote <name>] [--dry-run]}"
shift || true
REMOTE="mirror"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="${2:?--remote needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$SNAPSHOT_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: $SNAPSHOT_DIR" >&2; exit 2; }
git remote get-url "$REMOTE" >/dev/null 2>&1 || { echo "no remote '$REMOTE' in $SNAPSHOT_DIR" >&2; exit 2; }

echo "→ fetching $REMOTE/main"
git fetch -q "$REMOTE" main
MIRROR_MAIN="$(git rev-parse "$REMOTE/main")"

# Host-maintained workflow files: on the mirror, stripped from the snapshot.
carried=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ ! -f "$f" ]; then
    mkdir -p "$(dirname "$f")"
    git show "$MIRROR_MAIN:$f" > "$f"
    carried+=("$f")
    echo "  carry $f  (mirror $MIRROR_MAIN)"
  fi
done < <(git ls-tree -r --name-only "$MIRROR_MAIN" -- .github/workflows)

if [ ${#carried[@]} -gt 0 ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "→ dry-run: would commit ${#carried[@]} file(s) and push"
    git checkout -- . 2>/dev/null || true
    exit 0
  fi
  git add -- "${carried[@]}"
  # Author default is a ROLE identity, not a person. This script lands commits
  # in the PUBLIC mirror, so a personal handle/address here would publish
  # identity data with every such commit — and the public-snapshot gate agrees:
  # its forbidden-pattern scan classifies the maintainer's account digits as
  # "personal identifier" and only allowlists the two spec-mandated public
  # surfaces (the facet footer and its spec). Callers who want their own
  # identity can still set GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL.
  # (Do not quote the account digits here to explain the rule: this file is
  # scanned too, and a comment that names them trips the very pattern.)
  git -c user.name="${GIT_AUTHOR_NAME:-fd-mirror-ci}" -c user.email="${GIT_AUTHOR_EMAIL:-ci@finddatatech.cloud}" \
    commit -q -m "ci: 保留镜像仓自维护的 workflow（快照强推前带上）"
  echo "→ committed carried workflow(s)"
else
  echo "→ nothing to carry (snapshot already matches mirror's workflow set)"
fi

if [ "$DRY_RUN" = "1" ]; then echo "→ dry-run: not pushing"; exit 0; fi

echo "→ pushing --force to $REMOTE main"
git push --force "$REMOTE" HEAD:main

echo "→ asserting post-push"
git fetch -q "$REMOTE" main
POST="$(git rev-parse "$REMOTE/main")"
missing=0
for f in $(git ls-tree -r --name-only "$MIRROR_MAIN" -- .github/workflows); do
  if ! git cat-file -e "$POST:$f" 2>/dev/null; then
    echo "  ✗ MISSING on $REMOTE/main: $f" >&2
    missing=$((missing + 1))
  fi
done
if [ "$missing" -gt 0 ]; then
  echo "✗ push lost $missing host-maintained workflow file(s) — image pipeline will not fire" >&2
  exit 1
fi
echo "✓ $REMOTE/main = $POST, all host-maintained workflows present"
echo "  next: gh run list -R <owner/repo> --limit 3   # expect an 'image' run"
