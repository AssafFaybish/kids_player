<div dir="rtl">

# הקמת Google Cloud — מדריך חד־פעמי (~10 דקות)

מדריך זה מקים את התשתית לשני דברים:
1. **מפתח YouTube Data API** — חילוץ כל הסרטונים, השם והלוגו של ערוצי יוטיוב.
2. **OAuth בסקופ `drive.file`** — גיבוי וסנכרון הספרייה לגוגל דרייב שלך.

הכול חינמי, בלי כרטיס אשראי, ובלי תהליך אימות (verification) של גוגל — בזכות הבחירה בסקופ הלא־רגיש `drive.file`.

---

## שלב 1 — יצירת פרויקט

1. היכנס אל [console.cloud.google.com](https://console.cloud.google.com) עם חשבון הגוגל שלך.
2. בסרגל העליון ← בורר הפרויקטים ← **New Project**.
3. שם: `Kids Player` ← **Create** ← ודא שהפרויקט החדש נבחר.

## שלב 2 — הפעלת שלושת ה‑APIs

תפריט ☰ ← **APIs & Services** ← **Library**, ואז חפש והפעל (**Enable**) אחד־אחד:

- **YouTube Data API v3**
- **Google Drive API**
- **Google Sheets API**

## שלב 3 — מסך ההסכמה (OAuth consent screen)

1. **APIs & Services** ← **OAuth consent screen**.
2. User Type: **External** ← Create.
3. מלא רק את שדות החובה:
   - App name: `הסרטונים שלי`
   - User support email + Developer contact: המייל שלך.
4. **Scopes** (היום: **Data Access**, `console.cloud.google.com/auth/scopes`) ←
   Add or Remove Scopes ← סמן **בדיוק אחד**:
   - `https://www.googleapis.com/auth/drive.file`
     ("See, edit, create, and delete only the specific Google Drive files you use with this app")

   ⚠️ **אל תוסיף `spreadsheets`** ואל תוסיף שום scope אחר. מ-v1.0.19 האפליקציה
   כותבת רק לקבצים שהיא עצמה יצרה, ו-`drive.file` מכסה אותם — כולל קריאה וכתיבה
   דרך Sheets API. הוספת `spreadsheets` תחזיר את מסך האזהרה לכל המשתמשים ללא
   שום תועלת. ההסבר המלא בשלב 3א.
5. סיים את האשף ← **Publish App** ← Confirm (היום: דף **Audience**).
   עם `drive.file` בלבד — **אין אזהרת "unverified"**, כי הוא scope לא-רגיש.

## שלב 3א — אין צורך באימות (v1.0.19)

**האפליקציה כבר לא מבקשת scope רגיש, ולכן מסך האזהרה לא אמור להופיע כלל.**

מ-v1.0.19 ה-scope היחיד הוא `https://www.googleapis.com/auth/drive.file`, שגוגל
מסווגת כ**לא-רגיש** ("Recommended"). scope לא-רגיש אינו מחייב אימות, ומסך
"Google hasn't verified this app" מופיע רק ל-scopes רגישים או מוגבלים.

מה שצריך לעשות בקונסולה, פעם אחת:

1. **Data Access** (`console.cloud.google.com/auth/scopes`) — לוודא ש**רק**
   `drive.file` מסומן. אם `spreadsheets` עדיין שם — להסיר אותו.
2. **Audience** (`console.cloud.google.com/auth/audience`) — **Publish app**
   (מעבר מ-Testing ל-In production). זה חשוב: במצב Testing ההרשאה פגה כל 7 ימים
   וכל הורה נאלץ להתחבר מחדש שבועית, וגם יש תקרה של 100 משתמשים.
3. **Branding** (`console.cloud.google.com/auth/branding`) — אופציונלי. אם רוצים
   ששם האפליקציה והלוגו יוצגו במסך ההסכמה צריך "brand verification" (אוטומטי,
   דקות עד 2-3 ימי עסקים). בלעדיו מסך ההסכמה פשוט לא יראה לוגו — **אין אזהרה**.

> ⚠️ הנתיב הישן `APIs & Services ← OAuth consent screen` כבר לא קיים. גוגל העבירה
> הכול לקטע עליון בשם **Google Auth Platform** באפריל 2025.

### למה ויתרנו על scope הגיליונות

`spreadsheets` שימש רק לכתיבה חזרה לגיליון. מסלול האימות נחסם: גוגל דורשת אימות
בעלות על הדומיין מסוג **Domain Property ברמת DNS** ב-Search Console, ואנחנו על
`github.io` — הדומיין של GitHub, שאין לנו גישה ל-DNS שלו.

לכן האפליקציה כותבת עכשיו **רק לקבצים שהיא עצמה יצרה**, וזה מה ש-`drive.file`
מתיר. השלכות שחשוב להכיר:

- **אי אפשר להדביק לינק לגיליון קיים.** קובץ שההורה יצר בעצמו מחזיר
  `403 appNotAuthorizedToFile`. האפשרות הוסרה מהאשף וממסך ההורים.
- **קריאה מאומתת.** הגיליונות כבר לא משותפים "לכל מי שיש את הקישור" — בעבר רשימת
  הסרטונים של כל משפחה הייתה גלויה לכל מי שהחזיק בכתובת.
- **חשבון גוגל אחר לא יוכל לכתוב** לרשימה (רק לקרוא). שיתוף בין פרופילים עובד
  כשמדובר באותו חשבון.
- כל הקבצים שהאפליקציה יוצרת נמצאים בתיקיית
  **"רשימת השמעה לאפליקציה הסרטונים שלי"** בגוגל דרייב. קובץ הגיבוי
  `kids-player-db.json` נשאר **מחוץ** לתיקייה בכוונה: שיתוף התיקייה היה חושף אותו.

> אם אי פעם יירכש דומיין משלנו, אפשר יהיה לשקול מחדש את `spreadsheets` + אימות —
> ואז גם הדבקת לינק לגיליון חיצוני תחזור להיות אפשרית.

## שלב 4 — שני OAuth Client IDs (אנדרואיד)

**APIs & Services** ← **Credentials** ← **Create Credentials** ← **OAuth client ID** ← Application type: **Android**.

צור **שניים**, עם הערכים המדויקים הבאים:

| # | Name | Package name | SHA‑1 |
|---|---|---|---|
| 1 | `kids-player release` | `com.assaf.kidsplayer` | `5B:86:55:F3:07:09:7D:26:BB:70:7D:3B:BD:73:F5:6E:61:96:3B:E0` |
| 2 | `kids-player dev` | `com.assaf.kidsplayer.dev` | `C4:BC:98:E2:AC:A7:F4:97:37:08:60:05:6F:ED:F7:64:6A:B6:EC:DC` |

הערות:
- אלו ה‑SHA‑1 **האמיתיים** שחולצו מהמחשב שלך (release keystore + debug keystore) — העתק־הדבק כמו שהם.
- ל‑OAuth client מסוג Android **אין client secret** — אין מה לשמור בסוד.
- אם אי־פעם תחליף מחשב/keystore של debug — תצטרך לעדכן את ה‑SHA‑1 של client ‎#2 (להפיק מחדש: `npm run signing:report`).

## שלב 5 — מפתח API ליוטיוב

1. **Credentials** ← **Create Credentials** ← **API key**.
2. לחץ על המפתח שנוצר ← **Edit API key**:
   - Name: `kids-player youtube`
   - **API restrictions** ← Restrict key ← סמן **רק** `YouTube Data API v3`.
   - **Application restrictions: None** ⚠️ **חשוב! אל תבחר "Android apps"** — ההגבלה הזו נאכפת דרך headers שהאפליקציה שלנו (WebView) לא שולחת, והמפתח פשוט יפסיק לעבוד.
3. **Save** ← העתק את המפתח (מתחיל ב‑`AIza...`).

הסיכון של מפתח "פתוח": מישהו שיחלץ אותו מה‑APK יוכל לכל היותר לשרוף את מכסת הקריאה היומית שלך (10,000 יחידות). אין לו גישה לשום מידע פרטי ואין יכולת כתיבה.

## שלב 6 — מסירת המפתח

שלח לי את המפתח (`AIza...`) ואצרוב אותו כברירת מחדל באפליקציה (החלטה 23 — מודל היברידי). לחלופין תוכל להזין אותו ידנית במסך ההורים אחרי ההתקנה.

---

## סיכום — מה יצרנו

| פריט | ערך | לשימוש |
|---|---|---|
| פרויקט | Kids Player | מסגרת להכול |
| Consent screen | Published, scope יחיד `drive.file` | דיאלוג ההרשאה של גוגל |
| OAuth client #1 | `com.assaf.kidsplayer` + SHA‑1 release | האפליקציה בטאבלט |
| OAuth client #2 | `com.assaf.kidsplayer.dev` + SHA‑1 debug | פיתוח ובדיקות |
| API key | `AIza...` מוגבל ל‑YouTube Data API | חילוץ ערוצים |

**מה לא צריך:** כרטיס אשראי, verification, client secret, service account.

</div>
