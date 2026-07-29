#!/usr/bin/env bash
# release.sh — one-command release for kids_player (macOS/Linux; Windows: see
# INSTALL_AND_RELEASE.md for the manual path).
#
#   ./release.sh              build + publish the CURRENT package.json version
#   ./release.sh patch        bump 1.0.3 -> 1.0.4 first (also: minor / major / X.Y.Z)
#   ./release.sh patch "מה חדש: תיקוני באגים"   optional release notes as 2nd arg
#
# Steps: sync main -> (optional bump+commit) -> tests -> signed build -> signature
# verification -> conventionally-named APK -> GitHub release (or clear manual
# instructions when the current gh login lacks write access).
set -euo pipefail

REPO="devfassaf/kids_player"
cd "$(dirname "$0")"

BUMP="${1:-}"
NOTES="${2:-}"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

# ---- guards ----------------------------------------------------------------
command -v node >/dev/null || die "Node.js לא מותקן"
[ -f "$HOME/.keystores/kids-player.properties" ] || die "אין קובץ חתימה ב-~/.keystores — ראו INSTALL_AND_RELEASE.md (העברת מפתח החתימה)"
[ -f "www/js/keys.local.js" ] || die "חסר www/js/keys.local.js (מפתח YouTube API) — ראו INSTALL_AND_RELEASE.md"
[ -z "$(git status --porcelain)" ] || die "יש שינויים לא שמורים בגיט — עשו commit או stash קודם"

# ---- sync main (fetch from the public repo needs no credentials) ------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ]; then
  say "מסנכרן את main מול GitHub…"
  git fetch origin
  git merge --ff-only origin/main || die "ה-main המקומי סטה מ-GitHub — יישרו ידנית קודם"
else
  say "אזהרה: אתם על הענף '$BRANCH' (לא main) — הגרסה תיבנה מהקוד המקומי הזה"
fi

# ---- optional version bump ---------------------------------------------------
if [ -n "$BUMP" ]; then
  say "מקדם גרסה ($BUMP)…"
  npm version "$BUMP" --no-git-tag-version >/dev/null
  V="$(node -p "require('./package.json').version")"
  git add package.json package-lock.json 2>/dev/null || git add package.json
  git commit -q -m "release v$V"
  say "נוצר commit של הקידום — זכרו לדחוף אותו (PR או push ישיר)"
else
  V="$(node -p "require('./package.json').version")"
fi
TAG="v$V"
APK="kids-player-$TAG.apk"

# ---- tests -------------------------------------------------------------------
say "מריץ טסטים…"
npm test >/dev/null 2>&1 || die "טסטים נכשלו — לא משחררים גרסה שבורה (הריצו npm test לפרטים)"

# ---- signed build + verification ----------------------------------------------
say "בונה APK חתום ($TAG)…"
npm run apk:release >/dev/null 2>&1 || die "הבנייה נכשלה — הריצו npm run apk:release לפרטים"
npm run apk:verify 2>/dev/null | grep -q '^Verifies' || die "אימות החתימה נכשל — לא מפרסמים!"
cp android/app/build/outputs/apk/release/app-release.apk "$APK"
say "נבנה ואומת: $APK ($(du -h "$APK" | cut -f1 | tr -d ' '))"

# ---- publish -------------------------------------------------------------------
[ -n "$NOTES" ] || NOTES="גרסה $V"
say "מפרסם release ל-GitHub…"
if gh release create "$TAG" "$APK" --repo "$REPO" -t "$TAG" -n "$NOTES" 2>/dev/null; then
  printf '\n\033[1;32m✓ פורסם! המכשירים יראו את העדכון בכפתור "בדיקת עדכון".\033[0m\n'
else
  cat <<EOT

⚠  אין הרשאת פרסום לחשבון ה-gh הנוכחי. פרסמו ידנית (2 דקות):
   1. https://github.com/$REPO/releases/new
   2. Tag: $TAG  ← להקליד ידנית במקלדת אנגלית!
   3. לגרור את הקובץ:  $(pwd)/$APK
   4. Publish release

   (או: gh auth login עם חשבון devfassaf ואז להריץ שוב)
EOT
fi
