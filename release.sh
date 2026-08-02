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

# v1.0.26: REFUSE A VERSION NO DEVICE CAN RECEIVE. update.parseVersion reads exactly three
# components, so "1.0.26.1" compares EQUAL to an installed "1.0.26" and every app answers
# "up-to-date". Four such releases have been published and not one reached a single
# device — the last carried a field-reported fix. Checked BEFORE the build, so a typo
# costs a second rather than a whole release cycle.
if ! node -e "import('./www/js/update.js').then(m => process.exit(m.versionIsDeliverable(process.argv[1]) ? 0 : 1))" "$V"; then
  die "Version '$V' can never reach a device: update.parseVersion reads three components, so it is indistinguishable from '$(printf '%s' "$V" | cut -d. -f1-3)'. Use a real third-component bump (e.g. 1.0.27)."
fi

APK="$APK_DIR/kids-player-$TAG.apk"
# v1.0.19: a SECOND asset under a version-less name. GitHub resolves
# /releases/latest/download/<name> only for an exactly-named asset, so a stable name
# is what lets the website's download button hit the newest APK directly — no GitHub
# page, no JavaScript, no API call. The versioned copy stays for humans and for
# update.js's pickApkAsset exact match (it prefers kids-player-<tag>.apk, and only
# falls back to "any .apk", so two assets never confuse it).
APK_LATEST="$APK_DIR/kids-player.apk"

# ---- tests -------------------------------------------------------------------
say "Running tests…"
npm test >/dev/null 2>&1 || die "Tests failed — never release a broken build (run npm test for details)"

# ---- signed build + verification ----------------------------------------------
say "Building signed APK ($TAG)…"
npm run apk:release >/dev/null 2>&1 || die "Build failed — run npm run apk:release for details"
npm run apk:verify 2>/dev/null | grep -q '^Verifies' || die "Signature verification failed — do NOT publish!"
mkdir -p "$APK_DIR"
cp android/app/build/outputs/apk/release/app-release.apk "$APK"
cp android/app/build/outputs/apk/release/app-release.apk "$APK_LATEST"
say "Built and verified: $APK ($(du -h "$APK" | cut -f1 | tr -d ' '))"

# ---- publish -------------------------------------------------------------------
# The release body is what PARENTS read in the app's what's-new screen (v1.0.13):
# Hebrew, user-facing, one bullet per change. The app extracts exactly this section,
# so keep technical detail in the PR — not here.
[ -n "$NOTES" ] || NOTES="שיפורים ותיקונים כלליים"
BODY="## מה חדש

$NOTES"
say "Publishing GitHub release…"
if gh release create "$TAG" "$APK" "$APK_LATEST" --repo "$REPO" -t "$TAG" -n "$BODY" 2>/dev/null; then
  printf '\n\033[1;32m✓ Published! Devices will see the update via the "check for update" button.\033[0m\n'
else
  cat <<EOT

⚠  The current gh account has no publish permission. Publish manually (2 minutes):
   1. https://github.com/$REPO/releases/new
   2. Tag: $TAG  <- type it by hand with an ENGLISH keyboard (invisible bidi
      marks from a Hebrew-context copy-paste broke version detection once)
   3. Drag BOTH files:  $(pwd)/$APK
                        $(pwd)/$APK_LATEST   <- the website's download button
                        needs this exact name, or it 404s
   4. Publish release

   (or: gh auth login with the devfassaf account and run again)
EOT
fi
