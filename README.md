<div dir="rtl">

# 🌳 הסרטונים שלי — Kids Player

**נגן וידאו בטוח לילדים, בשליטת ההורים, לטאבלט אנדרואיד.**

אפליקציה לילדים בגיל הרך שמנגנת **אך ורק** סרטונים שההורה בחר — בלי המלצות, בלי גלישה ליוטיוב, בלי הפתעות. נבנתה כאפליקציית web ב‑JavaScript טהור (בלי framework) ועטופה ל‑APK עם **Capacitor**.

</div>

<div dir="rtl">

## ✨ למה זה קיים?

יוטיוב — גם YouTube Kids — מציע לילד תוכן שההורה לא בחר: המלצות, סרטונים קשורים, ופרסומות לתוכן אחר. האפליקציה הזו הופכת את המודל: **ההורה אוצר רשימה, והילד רואה רק אותה.**

## 🛡️ עקרונות בטיחות

| עיקרון | איך |
|---|---|
| אין יציאה ליוטיוב | קוד נייטיב בולע כל ניווט ל‑`youtube.com` / `youtu.be` |
| אין המלצות | נגן `youtube-nocookie.com` עם `rel=0`, יציאה אוטומטית לפני מסך הסיום |
| אין ממשק יוטיוב | `controls=0` + שכבת מגע שחוסמת את הלוגו וה‑end-cards |
| רק לינקים שאושרו | כל לינק עובר מסווג קפדני — YouTube ID אמיתי או קובץ וידאו `https` בלבד |
| מסך הורים נעול | קוד PIN בן 4 ספרות (נשמר כ‑hash) |

## 🧒 מה יש באפליקציה

- **פרופילים** — כל ילד/ה עם רשימה משלו, אווטאר חיה וצבע.
- **גלריה ידידותית** — רשת תמונות גדולות עם דפדוף בחצים, RTL מלא בעברית.
- **נגן מותאם ילדים** — בר התקדמות אדום עם גרירה, לחיצה כפולה לדילוג, מסך מלא אמיתי.
- **שני סוגי תוכן** — סרטוני YouTube וקבצי וידאו ישירים (למשל `.mp4` מגוגל דרייב, עם הורדה ושמירה מקומית כשההזרמה נכשלת).
- **ניהול מרחוק** — הרשימה נטענת מ‑Google Sheet משותף: ההורה עורך מכל מקום, האפליקציה מתעדכנת בכל פתיחה.

## 🗺️ בפיתוח (Roadmap)

שדרוג משמעותי בעבודה — ראו את מסמך התכנון המלא:

- 📁 **תיקיות ערוצים** — הוספת ערוץ יוטיוב שלם בשורה אחת בגיליון; האפליקציה מחלצת את כל הסרטונים, השם והלוגו (YouTube Data API + RSS).
- 🎁 **סרטונים חדשים עטופים כמתנה** — לחיצה ראשונה פותחת עם קונפטי וצליל.
- ⏳ **תור אישור הורים** — תוכן חדש מערוץ ממתין לאישור (עם טוגל auto‑approve לערוץ).
- ☁️ **סנכרון בין מכשירים** — גיבוי לגוגל דרייב (OAuth בסקופ מינימלי `drive.file`), כולל מחיקות.
- 📲 **שיתוף מיוטיוב** — כפתור Share באפליקציית יוטיוב מוסיף סרטון ישירות.
- 🚀 **ביצועים** — IndexedDB, טעינה מדורגת, מסך טעינה מונפש לילדים.
- 🔄 **עדכון גירסה מתוך האפליקציה** — דרך GitHub Releases.
- 📺 מסך תמיד דולק בזמן ניגון, כפתור יציאה ידידותי, כותרת סרטון, ועוד.

## 👨‍👩‍👧 התחלה מהירה להורה

1. פותחים **Google Sheet** חדש (לא קובץ Excel!).
2. בכל שורה, בעמודה A — לינק ליוטיוב (אפשר שם בעמודה B ותמונה בעמודה C).
3. **שיתוף ← כל מי שיש לו הקישור: צופה.**
4. מדביקים את קישור הגיליון במסך ההורים (🔒) באפליקציה.

עדכונים בגיליון מגיעים לאפליקציה תוך דקות, בכל פתיחה או ברענון ידני.

## 🔧 פיתוח

</div>

```bash
# web preview (UI only — native features work only in the APK)
npm run serve        # → http://localhost:5173 (fixed port)

# tests
npm test             # node:test

# build the APK
npm install
npx cap add android  # first time only — then apply native-reference/MainActivity.java
npm run apk          # cap copy + gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

<div dir="rtl">

דרישות: Node.js 18+, JDK 17, Android SDK.

> 🛠️ **למתחזקים ולפיתוח עתידי:**
> - [CLAUDE.md](CLAUDE.md) — פקודות, אינווריאנטים קשיחים, וזרימת אימות (נטען אוטומטית לסשן AI).
> - [ARCHITECTURE.md](ARCHITECTURE.md) — מפת מודולים, סכמת ה‑DB, וזרימות הסנכרון/נגן/עדכון.
> - [DEVELOPMENT.md](DEVELOPMENT.md) — הארכיטקטורה המקורית + תוספת המהפך (§14-§18) וה‑gotchas.
> - [INSTALL_AND_RELEASE.md](INSTALL_AND_RELEASE.md) — התקנה בטאבלט ושחרור גרסה, צעד-צעד בעברית.
> - [PUBLISHING.md](PUBLISHING.md) — כללי חתימה, למה לא חנות Play, וצ'קליסט release.
> - [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md) — הקמת OAuth ומפתח YouTube API (חד-פעמי).

## 📁 מבנה הפרויקט

</div>

```
www/                    the entire app (vanilla JS, ES modules, no bundler)
  index.html            all views in one document (RTL Hebrew)
  css/styles.css
  js/
    app.js              views, gallery, watch, PIN, parent screen
    player.js           YouTube IFrame + <video>, shared custom HUD
    store.js            data model, link classifier (the safety boundary), profiles
    sync.js             remote list mirroring (Google Sheet → CSV)
    media.js            stream → download+cache fallback for direct files
    platform.js         Capacitor shim with browser fallbacks
    pin.js              hashed parent PIN
test/                   node:test unit tests
native-reference/       canonical native tweaks (MainActivity.java)
dev-server.mjs          local dev server (no-store + CORS proxy)
capacitor.config.json
```

<div dir="rtl">

## ⚠️ מגבלות ידועות (בכנות)

- **פרסומות יוטיוב** בסרטונים ממונטזים אינן ניתנות לחסימה בשום שיטה תקנית — העדיפו ערוצים דלי-פרסומות.
- **end-cards** של יוטיוב עלולים להבהב לרגע לפני היציאה האוטומטית.
- הזרמת קבצים גדולים מגוגל דרייב לא יציבה — האפליקציה מורידה פעם אחת ושומרת מקומית.
- פורמט אמין: **mp4 (H.264/AAC)**.

## 🔒 נעילת הילד באפליקציה (מומלץ)

הפעילו **App pinning** באנדרואיד (הגדרות ← אבטחה ← הצמדת אפליקציה) והצמידו את האפליקציה — כך ילד קטן לא יכול לצאת ממנה.

## 📄 רישיון ושימוש

פרויקט משפחתי פרטי. מופץ בהתקנה ידנית (sideload) בלבד — לא בחנות. ראו הערות תאימות ל‑YouTube API ToS במסמכי הפרויקט.

</div>
