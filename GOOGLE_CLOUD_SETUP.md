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
4. **Scopes** ← Add or Remove Scopes ← סמן **בדיוק** את השניים:
   - `https://www.googleapis.com/auth/drive.file`
     ("See, edit, create, and delete only the specific Google Drive files you use with this app")
   - `https://www.googleapis.com/auth/spreadsheets` — נדרש מ-v1.0.6 כדי שסרטונים
     שנוספים באפליקציה יירשמו חזרה בגיליון (מקור אמת יחיד).
   ⚠️ אל תוסיף scopes נוספים מעבר לשניים האלה.
5. סיים את האשף ← בעמוד הסיכום לחץ **Publish App** ← Confirm.
   ⚠️ scope של Sheets מסווג אצל גוגל כ"רגיש": <b>עד שהאפליקציה תעבור verification</b>
   מסך ההסכמה יציג פעם אחת אזהרת "Google hasn't verified this app" — לוחצים
   **Advanced** ← **Go to הסרטונים שלי (unsafe)**. אחרי אימות (שלב 3א) האזהרה נעלמת
   לכל המשתמשים. בנוסף, חשבון ה-Google שמתחברים איתו חייב **הרשאת עריכה** על הגיליון
   — אחרת האפליקציה תציג "אין הרשאת עריכה לגיליון" והרישום לגיליון יידלג.

## שלב 3א — אימות האפליקציה (verification) — כדי שהמשפחות לא יראו אזהרה

### למה האזהרה בכלל מופיעה

גוגל מסווגת כל scope לאחת משלוש רמות, וזה **כל** ההסבר למסך המפחיד:

| scope שאנחנו מבקשים | סיווג | מפעיל אזהרה? |
|---|---|---|
| `drive.file` | **לא-רגיש** ("Recommended") | ❌ לא |
| `spreadsheets` | **רגיש** (Sensitive) | ✅ כן |

כלומר `spreadsheets` לבדו אחראי למסך. מסך האזהרה מופיע כשאפליקציה מבקשת scope
**רגיש או מוגבל** ולא עברה אימות — ורק אז.

נקודה חשובה שכדאי להכיר לפני שמשקיעים: האפליקציה **קוראת** את הגיליון בלי שום
הזדהות (ייצוא CSV ציבורי — ראו `sync2.js`). ה-scope הרגיש נחוץ אך ורק כדי
**לכתוב** חזרה לגיליון. תיאורטית אפשר לוותר עליו ולהישאר עם `drive.file` בלבד,
והאזהרה הייתה נעלמת מיד וללא כל הגשה — אבל אז הכתיבה תעבוד רק לגיליון
שהאפליקציה **יצרה בעצמה**, וגיליון שההורה יצר והדביק כלינק יהפוך לקריאה-בלבד
(גוגל מחזירה `403 appNotAuthorizedToFile`). בחרנו במסלול האימות כדי לשמור על
סנכרון דו-כיווני מלא בשני המקרים.

### מה נדרש בפועל (נכון ל-2026)

לטובת scope **רגיש** — בניגוד ל"מוגבל" — **אין צורך בביקורת אבטחה בתשלום**
(CASA). היא נדרשת רק ל-scopes מוגבלים, וגם חידוש שנתי לא נדרש כאן.

1. ✅ **דף בית ומדיניות פרטיות פומביים** — כבר עלו ופעילים:
   - דף בית: `https://devfassaf.github.io/kids_player/`
   - מדיניות פרטיות: `https://devfassaf.github.io/kids_player/privacy.html`

   (מקורם ב-`docs/` בריפו, מוגשים ב-GitHub Pages. הקבצים בשורש `docs/` בכוונה —
   כך אין `/site/` בכתובת.) גוגל דורשת שמדיניות הפרטיות תתארח **באותו דומיין**
   של דף הבית ותקושר ממסך ההסכמה — שני התנאים מתקיימים.

2. **אימות בעלות על הדומיין** — זה השלב שהכי קל לפספס ובלעדיו ההגשה נתקעת:
   נכנסים ל-[Google Search Console](https://search.google.com/search-console),
   מוסיפים את `devfassaf.github.io` כ-property ומאמתים. אחר כך ב-Cloud Console:
   **OAuth consent screen ← Edit App ← Authorized domains: `github.io`**.

3. **מסך ההסכמה** — ממלאים גם:
   - **Application home page** ו-**privacy policy link** — הכתובות מסעיף 1.
   - **App logo** — `www/assets/icon.svg` מומר ל-PNG.

4. **סרטון הדגמה** (חובה ל-scope רגיש). גוגל בודקת בו דברים ספציפיים, אז ודאו
   שכולם נראים בבירור:
   - הסרטון **באנגלית**.
   - שם האפליקציה במסך ההסכמה **זהה** לשם ב-Cloud Console.
   - **ה-OAuth client ID גלוי בשורת הכתובת** בזמן ההסכמה.
   - כל scope רגיש **מודגם בשימוש אמיתי** — כלומר צריך להראות גם הוספת סרטון
     שנרשמת בגיליון, לא רק את מסך ההתחברות.

5. **Submit for verification**. נוסח מוכן ל-Scope justification (הדביקו):
   > The app is a private, parent-managed video player for young children. It
   > uses `drive.file` to store a single backup file it creates (profiles and the
   > curated library), and `spreadsheets` to read and update the parent's own
   > source sheet that defines which videos/channels the child may watch. Reading
   > the sheet needs no OAuth at all (public CSV export); the `spreadsheets` scope
   > is required only so that videos added inside the app are written back to the
   > parent's own sheet, keeping a single source of truth. A narrower scope does
   > not work here because the parent may paste a link to a sheet they created
   > themselves, which `drive.file` cannot authorize. No data is shared with third
   > parties; everything stays in the user's own Google account and device.

6. **זמן טיפול: עד 10 ימים.** עד האישור הכול עובד — רק עם האזהרה החד-פעמית.

### ⚠️ המלכודת של מצב Testing

`Publishing status: Testing` + הוספת חשבונות ההורים תחת **Test users** אכן מסיר
את האזהרה עבורם **מיד**, וזה פתרון גישור לגיטימי עד שהאימות מאושר. אבל שימו לב
למחיר האמיתי:

- מוגבל ל-**100 משתמשים**.
- **ההרשאה פגה אחרי 7 ימים** — לא רק ה-refresh token, אלא ההסכמה עצמה. כלומר כל
  הורה יצטרך להתחבר מחדש **מדי שבוע**. באנדרואיד אנחנו עובדים מול
  AuthorizationClient שאין בו refresh token בכלל, אז אין שום דרך לעקוף את זה.

לכן Testing מתאים רק כפתרון זמני; להפצה למשפחות — אימות.

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
