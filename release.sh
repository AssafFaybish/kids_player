#!/usr/bin/env bash
# release.sh — one-command release for kids_player (macOS/Linux; Windows:
# use release.ps1, the PowerShell port of this script).
#
#   ./release.sh              build + publish the CURRENT package.json version
#   ./release.sh patch        bump 1.0.3 -> 1.0.4 first (also: minor / major / X.Y.Z)
#   ./release.sh patch "מה חדש: תיקוני באגים"   optional release notes as 2nd arg
#
# Steps: sync main -> (optional bump+commit) -> tests -> signed build -> signature
# verification -> conventionally-named APK in apk_versions/ -> GitHub release (or
# clear manual instructions when the current gh login lacks write access).
set -euo pipefail

REPO="devfassaf/kids_player"
APK_DIR="apk_versions"   # built releases are collected here (gitignored)
cd "$(dirname "$0")"

BUMP="${1:-}"
NOTES="${2:-}"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

# ---- guards ----------------------------------------------------------------
command -v node >/dev/null || die "Node.js is not installed"
[ -f "$HOME/.keystores/kids-player.properties" ] || die "No signing properties at ~/.keystores — see INSTALL_AND_RELEASE.md (moving the signing key)"
[ -f "www/js/keys.local.js" ] || die "Missing www/js/keys.local.js (YouTube API key) — see INSTALL_AND_RELEASE.md"
[ -z "$(git status --porcelain)" ] || die "Uncommitted git changes — commit or stash first"

# ---- sync main (fetch from the public repo needs no credentials) ------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ]; then
  say "Syncing main with GitHub…"
  git fetch origin
  git merge --ff-only origin/main || die "Local main has diverged from GitHub — reconcile manually first"
else
  say "Warning: you are on branch '$BRANCH' (not main) — the release will be built from this local code"
fi

# ---- optional version bump ---------------------------------------------------
if [ -n "$BUMP" ]; then
  say "Bumping version ($BUMP)…"
  npm version "$BUMP" --no-git-tag-version >/dev/null
  V="$(node -p "require('./package.json').version")"
  git add package.json package-lock.json 2>/dev/null || git add package.json
  git commit -q -m "release v$V"
  say "Bump commit created — remember to push it (PR or direct push)"
else
  V="$(node -p "require('./package.json').version")"
fi
TAG="v$V"
APK="$APK_DIR/kids-player-$TAG.apk"

# ---- tests -------------------------------------------------------------------
say "Running tests…"
npm test >/dev/null 2>&1 || die "Tests failed — never release a broken build (run npm test for details)"

# ---- signed build + verification ----------------------------------------------
say "Building signed APK ($TAG)…"
npm run apk:release >/dev/null 2>&1 || die "Build failed — run npm run apk:release for details"
npm run apk:verify 2>/dev/null | grep -q '^Verifies' || die "Signature verification failed — do NOT publish!"
mkdir -p "$APK_DIR"
cp android/app/build/outputs/apk/release/app-release.apk "$APK"
say "Built and verified: $APK ($(du -h "$APK" | cut -f1 | tr -d ' '))"

# ---- publish -------------------------------------------------------------------
[ -n "$NOTES" ] || NOTES="Version $V"
say "Publishing GitHub release…"
if gh release create "$TAG" "$APK" --repo "$REPO" -t "$TAG" -n "$NOTES" 2>/dev/null; then
  printf '\n\033[1;32m✓ Published! Devices will see the update via the "check for update" button.\033[0m\n'
else
  cat <<EOT

⚠  The current gh account has no publish permission. Publish manually (2 minutes):
   1. https://github.com/$REPO/releases/new
   2. Tag: $TAG  <- type it by hand with an ENGLISH keyboard (invisible bidi
      marks from a Hebrew-context copy-paste broke version detection once)
   3. Drag the file:  $(pwd)/$APK
   4. Publish release

   (or: gh auth login with the devfassaf account and run again)
EOT
fi
