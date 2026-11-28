#!/bin/sh
# Run the full CI gate for THIS checkout on GitHub's runners
# (openspec: fix-catalog-preset-roster-convergence's outgrowth — the fast lane
# outgrew local capacity).
#
# Why a script instead of three remembered commands: the three steps each have a
# way to go wrong silently, and every one of them was wrong at least once on
# 2026-11-14 —
#   * the push target: public remotes take only `main` (a branch push there
#     bypasses the snapshot gates; the pre-push hook refuses it, but reaching for
#     `--no-verify` is what people do next),
#   * `gh run watch` defaults to the LOCAL origin, which is gitee — it 404s,
#   * `gh workflow run` picks the branch's LAST run when you ask for the newest,
#     so "watch" can attach to the previous, already-finished run.
#
# The private mirror is the right place for this: public repos are unlimited but
# only accept cropped `main`; the mirror runs the same workflows on the metered
# 2000 min/month, which is plenty for on-demand gate runs (~50 min each).
#
# Usage:
#   scripts/ci-remote.sh                 # push HEAD, dispatch, print the run URL
#   scripts/ci-remote.sh --watch         # ...and attach to the run it just made
#   scripts/ci-remote.sh --branch v2     # custom ref name on the mirror
#   scripts/ci-remote.sh --dry-run       # print the commands, change nothing
#
# Refuses a dirty working tree: the mirror runs a COMMIT, so an unstaged edit
# would be silently absent from the run you are about to trust.
set -eu

REMOTE=scs001
REPO=scs001/platform
WORKFLOW=ci.yml
WATCH=0
DRY=0
REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1 ;;
    --dry-run) DRY=1 ;;
    --branch)
      shift
      [ $# -gt 0 ] || { echo "ci-remote: --branch needs a name" >&2; exit 2; }
      REF="$1"
      ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ci-remote: unknown argument '$1' (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "ci-remote: not inside a git checkout" >&2
  exit 2
}
cd "$ROOT"

git remote get-url "$REMOTE" >/dev/null 2>&1 || {
  echo "ci-remote: no '$REMOTE' remote in $ROOT." >&2
  echo "          add the private mirror first: git remote add $REMOTE git@github.com:$REPO.git" >&2
  exit 2
}

# Uncommitted work is the one thing this must not tolerate: the run tests a
# commit, so a dirty tree means the run does not describe what you are looking at.
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  echo "ci-remote: working tree has uncommitted changes — commit or stash them first:" >&2
  printf '%s\n' "$DIRTY" | sed 's/^/          /' >&2
  exit 1
fi

# Untracked SOURCE files are the same lie in a different costume: a brand-new
# test that was never `git add`ed simply does not exist in the commit the mirror
# builds, so "the lane is green" says nothing about it. The dirty check above
# deliberately excludes untracked files because this worktree collects generated
# artifacts (site-plaza/, dist/, graphs) — so refuse only the paths CI would
# actually run, and let scratch files elsewhere through.
UNTRACKED_SRC=$(git ls-files --others --exclude-standard \
  | grep -E '^(scripts|e2e|server|lib|web|openspec|dsh-profile-template|gateway|facet|app)/|^[^/]+\.(js|mjs|cjs|ts|tsx|json)$' || true)
if [ -n "$UNTRACKED_SRC" ]; then
  echo "ci-remote: these source files are NOT tracked, so they would be absent from the run:" >&2
  printf '%s\n' "$UNTRACKED_SRC" | sed 's/^/          /' >&2
  echo "          git add them first — a new test that never reached the commit is a test nobody ran." >&2
  exit 1
fi

SHA=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
if [ -z "$REF" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  # One sanitised component: refs may not contain spaces, "..", or a leading -.
  SAFE=$(printf '%s' "$BRANCH" | sed -e 's#[^A-Za-z0-9._-]#-#g' -e 's#--*#-#g' -e 's#^-##')
  REF="ci/${SAFE}-${SHORT}"
fi

echo "ci-remote: $REF → $REMOTE ($REPO), HEAD $SHORT"
if [ "$DRY" = "1" ]; then
  echo "  git push $REMOTE $SHA:refs/heads/$REF"
  echo "  gh workflow run $WORKFLOW --ref $REF -R $REPO"
  echo "  gh run list -R $REPO -L 1 --json databaseId,status,conclusion,headSha"
  [ "$WATCH" = "1" ] && echo "  gh run watch <id> -R $REPO"
  exit 0
fi

git push "$REMOTE" "$SHA:refs/heads/$REF"

gh workflow run "$WORKFLOW" --ref "$REF" -R "$REPO"

# The dispatch endpoint returns no id. Find THIS commit's run rather than the
# newest one: on a busy branch the newest may be the previous run.
echo "ci-remote: waiting for the run to register…"
RUN_ID=""
i=0
while [ "$i" -lt 30 ]; do
  RUN_ID=$(gh run list -R "$REPO" -L 10 --json databaseId,headSha,event \
    --jq "[.[] | select(.headSha == \"$SHA\" and .event == \"workflow_dispatch\")][0].databaseId" 2>/dev/null || true)
  [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && break
  i=$((i + 1))
  sleep 3
done

if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "ci-remote: dispatched, but could not find the run for $SHORT yet." >&2
  echo "          check: https://github.com/$REPO/actions?query=branch%3A$REF" >&2
  exit 1
fi

echo "ci-remote: run $RUN_ID → https://github.com/$REPO/actions/runs/$RUN_ID"
if [ "$WATCH" = "1" ]; then
  # -R is not optional here: without it gh watches the local origin (gitee) and 404s.
  gh run watch "$RUN_ID" -R "$REPO" --exit-status
else
  echo "ci-remote: watch it with:  gh run watch $RUN_ID -R $REPO"
fi
