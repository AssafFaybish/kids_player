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

## שלב 2 — הפעלת ה‑APIs

תפריט ☰ ← **APIs & Services** ← **Library**, ואז חפש והפעל (**Enable**) אחד־אחד:

- **YouTube Data API v3**
- **Google Drive API**

> **Google Sheets API אינו נדרש כלל, ומ-v1.0.44 גם לא בפרויקט קיים.** קוד המיגרציה
> שקרא את הגיליון פעם אחרונה נמחק, ואינווריאנט בסוויטה נכשל אם קריאה ל-Sheets API חוזרת
> לעץ. **בפרויקט קיים: כבו אותו** (APIs & Services ← Enabled APIs ← Google Sheets API ←
> Disable). זו הפחתת חשיפה בלבד — ה-scope `spreadsheets` הוסר עוד ב-v1.0.19, ולכן
> הכיבוי אינו משנה דבר עבור המשפחות.

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

### למה רק `drive.file`

`drive.file` היא ההרשאה היחידה שהאפליקציה מבקשת, והיא מוגבלת **בהגדרתה** לקבצים
שהאפליקציה עצמה יצרה. היא **אינה רגישה** — ולכן אין מסלול אימות, אין מסך
"גוגל לא מכירה את האפליקציה", ואין תקרת 100 משתמשים.

מגרסה 1.0.38 האובייקט היחיד שהאפליקציה נוגעת בו בדרייב הוא קובץ הגיבוי
`kids-player-db.json`. בחלון המיגרציה (עד 10.9.2026) היא גם **מוחקת** את קובצי
הגיליון שהיא עצמה יצרה בעבר — ורק אותם. התיקייה שלהם אינה נמחקת: תחת `drive.file`
אי אפשר לראות קבצים שההורה שם שם בעצמו, ולכן אי אפשר להוכיח שהיא ריקה, ומחיקת
תיקייה ב-Drive מוחקת גם את תוכנה.

היסטורית: עד v1.0.19 האפליקציה ביקשה גם `spreadsheets` — גישה ל**כל** גיליונות
החשבון — כדי לכתוב חזרה לרשימת המקורות. אימות scope רגיש כזה דורש **Domain Property
ברמת DNS** ב-Search Console, ואנחנו על `github.io`, דומיין של GitHub שאין לנו גישה
ל-DNS שלו. ההרשאה הוסרה אז, ובגרסה 1.0.38 רשימת המקורות עצמה הוסרה מהמוצר.

> ⚠️ **לא להחזיר את `spreadsheets`.** זה מחזיר את מסך האזהרה לכל משפחה, בשביל מנגנון
> שהמוצר כבר לא משתמש בו. `test/invariants.test.mjs` נכשל אם ה-scope חוזר לקוד.

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

## שלב 5 — מפתח API (יוטיוב + דרייב ציבורי)

1. **Credentials** ← **Create Credentials** ← **API key**.
2. לחץ על המפתח שנוצר ← **Edit API key**:
   - Name: `kids-player youtube`
   - **API restrictions** ← Restrict key ← סמן **שני** ה‑APIs: `YouTube Data API v3`
     **וגם** `Google Drive API`.
   - **Application restrictions: None** ⚠️ **חשוב! אל תבחר "Android apps"** — ההגבלה הזו נאכפת דרך headers שהאפליקציה שלנו (WebView) לא שולחת, והמפתח פשוט יפסיק לעבוד.
3. **Save** ← העתק את המפתח (מתחיל ב‑`AIza...`).

> **למה גם Drive API (v1.0.56):** כשהורה מוסיף קובץ שמע/וידאו מגוגל דרייב, האפליקציה
> קוראת את **שם הקובץ וסוגו** דרך `files.get` — לינק דרייב לא מכיל שם קובץ, ובלי זה
> האריח של הילד נשאר בלי כותרת ו‑mp3 מתנגן כמלבן שחור. זו קריאה ל**קובץ ציבורי בלבד**
> (משותף "לכל מי שיש לו הקישור") — אין כאן OAuth ואין גישה לקבצים פרטיים: ה‑scope היחיד
> של האפליקציה נשאר `drive.file`. **מפתח שנשאר מוגבל ל‑YouTube בלבד לא ישבור כלום** —
> הקריאה תיכשל ב‑403 והאפליקציה תיפול ל‑scrape של דף הקובץ הציבורי (בדיוק כמו בבנייה
> ללא מפתח): מצב מנוון, לא שבור.

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
