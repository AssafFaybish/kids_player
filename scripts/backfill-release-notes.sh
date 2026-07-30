#!/usr/bin/env bash
# backfill-release-notes.sh — add a Hebrew "## מה חדש" section to releases that were
# published with GitHub's auto-generated English body (v1.0.13).
#
# WHY: the app's what's-new screen shows exactly that section to PARENTS. Without it
# they'd read PR titles, @handles and compare-links. Newer releases get the section
# from release.sh automatically; this script fixes the ones published before v1.0.13.
#
# Requires WRITE access to the repo:  gh auth login   (as the repo owner)
# Safe to re-run: a release that already has the section is skipped, and the original
# body is always preserved below a --- divider.
set -euo pipefail
REPO="devfassaf/kids_player"

add() {
  local tag="$1" notes="$2" body new
  body="$(gh api "repos/$REPO/releases/tags/$tag" --jq '.body // ""' 2>/dev/null || true)"
  if [ -z "${body+x}" ]; then echo "skip $tag (no such release)"; return; fi
  case "$body" in *"## מה חדש"*) echo "skip $tag (already has Hebrew notes)"; return;; esac
  new="## מה חדש

$notes"
  [ -n "$body" ] && new="$new

---

$body"
  if gh release edit "$tag" --repo "$REPO" --notes "$new" >/dev/null 2>&1; then
    echo "ok   $tag"
  else
    echo "FAIL $tag — no write permission? run: gh auth login"
  fi
}

add "v1.0.9" "* תמיכה מלאה בטלוויזיות אנדרואיד — ניווט בשלט ותצוגה מותאמת למסך גדול
* תוקן: שאלת העדכון נעלמה לצמיתות אם נסגרה בטעות (למשל נגיעה של הילד במסך)"

add "v1.0.8" "* מסך הדרכה בהתקנה הראשונה, עם צילומי מסך אמיתיים של האפליקציה
* אשף חדש אחרי יצירת פרופיל: ליצור קובץ מקורות, לחבר קיים או לדלג
* טאב \"אודות\" חדש: גירסה, עדכון, הדרכה ויצירת קשר עם המפתח
* מסך \"מה חדש\" לפני כל עדכון
* חסימת יצירת שני פרופילים באותו שם"

add "v1.0.7" "* הוספת סרטון או ערוץ ישירות משיתוף ביוטיוב — עם קוד הורים ואישור
* חיפוש סרטונים במסך הבית
* בדיקת תוכן חדש בכל חזרה למסך הבית
* התקנת עדכון דורשת קוד הורים"

add "v1.0.6" "* קובץ המקורות הוא הרשימה הראשית: כל הוספה באפליקציה נרשמת בו אוטומטית
* תיקייה משותפת אחת לכל הסרטונים שנוספו ידנית (\"סרטונים נוספים\")
* אישור ערוץ מציע לאשר גם את הסרטונים שממתינים ממנו
* תמונה קבועה וייחודית לכל תיקיית ערוץ"

add "v1.0.4.1" "* שאלת עדכון גירסה בכניסה לאפליקציה
* הצעה לחיבור חשבון Google לגיבוי, לפני בחירת הפרופיל
* תיקיות ערוץ בעיצוב חדש שלא מתבלבל עם סרטון
* כפתור היציאה סוגר את האפליקציה באמת
* נקודה אדומה על כפתור ההורים כשמשהו ממתין לאישור"

add "v1.0.3" "* תוקן: תיקיית \"חדשים\" הופיעה ריקה למרות שהמונה הראה מתנות"

add "v1.0.2" "* מתנה בעיצוב תלת-ממדי
* מעבר אוטומטי למסך מלא בלחיצה על סרטון
* סיבוב חופשי של המסך (לאורך ולרוחב)"

echo
echo "Done. Verify in the app: מסך הורים ← אודות ← 🎉 מה חדש בגירסה"
