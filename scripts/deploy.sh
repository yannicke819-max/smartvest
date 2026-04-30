#!/usr/bin/env bash
# P18h.2 — Wrapper for `flyctl deploy` that auto-injects GIT_SHA + BUILD_TIME
# build args so /version stays populated even on manual deploys.
#
# WHY THIS EXISTS — root cause analysis (29/04/2026, sprint P18):
#   Direct `flyctl deploy` (no GitHub Actions) does NOT inject GIT_SHA /
#   BUILD_TIME because flyctl does not know them. Result : `/version`
#   returns `git_sha:null` + `build_time:null` in prod, breaking the
#   visibility guarantee that P18h shipped (verified 11:04 UTC, 13:38 CEST).
#
# THIS SCRIPT enforces the build args using:
#   - GIT_SHA   = `git rev-parse HEAD` (current commit, must match origin/main
#     for production deploys; warns if HEAD != origin/main)
#   - BUILD_TIME = ISO-8601 UTC at the moment of the deploy
#
# USAGE :
#   ./scripts/deploy.sh                 # deploy current HEAD
#   ./scripts/deploy.sh --strategy immediate
#   ./scripts/deploy.sh --help          # show flyctl deploy --help
#
# ANY ARGS PASSED ARE FORWARDED to `flyctl deploy` — defaults below cover the
# common case (matches what `.github/workflows/fly.yml` does).

set -euo pipefail

# ── Pre-flight checks ──────────────────────────────────────────────────────

if ! command -v flyctl >/dev/null 2>&1; then
  echo "❌ flyctl not found in PATH. Install via: curl -L https://fly.io/install.sh | sh" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "❌ git not found in PATH" >&2
  exit 1
fi

# Must run from inside the smartvest git repo
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "❌ Not in a git repo" >&2
  exit 1
fi

# Warn if HEAD is not synced with origin/main — usually a deploy mistake
GIT_SHA=$(git rev-parse HEAD)
ORIGIN_MAIN=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -n "$ORIGIN_MAIN" ] && [ "$GIT_SHA" != "$ORIGIN_MAIN" ]; then
  echo "⚠️  HEAD ($GIT_SHA) != origin/main ($ORIGIN_MAIN)"
  echo "   You are about to deploy a commit that is NOT on origin/main."
  read -r -p "   Continue? [y/N] " confirm
  case "$confirm" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Deploy ─────────────────────────────────────────────────────────────────

echo "🚀 Deploying smartvest to Fly with build args:"
echo "   GIT_SHA    = $GIT_SHA"
echo "   BUILD_TIME = $BUILD_TIME"
echo ""

# Pass build args first; user-provided args override defaults below if needed
flyctl deploy \
  --remote-only \
  --build-arg "GIT_SHA=$GIT_SHA" \
  --build-arg "BUILD_TIME=$BUILD_TIME" \
  --wait-timeout 300 \
  --strategy immediate \
  -a smartvest \
  "$@"

echo ""
echo "✅ Deploy submitted. Verify with:"
echo "   curl -s https://smartvest.fly.dev/version | jq"
echo "   Expected git_sha=$GIT_SHA"
