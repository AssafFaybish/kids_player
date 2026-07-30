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

2. ⛔ **אימות בעלות על הדומיין — כאן המסלול נחסם עם `github.io`.**

   גוגל דורשת במפורש **Domain Property (ברמת DNS)** ב-Search Console, ולא
   "URL prefix": *"You must verify the Domain Property (DNS-level), rather than a
   'URL prefix' or 'Site,' property."* Domain Property מחייב רשומת **TXT ב-DNS**
   של הדומיין — ו-`github.io` הוא דומיין של GitHub. **אין לנו גישה ל-DNS שלו,
   ולכן אי אפשר לאמת אותו.**

   מצטבר לזה: `github.io` הוא דומיין משותף (Public Suffix List), וגוגל ממליצה
   במפורש נגד אירוח דף הבית "on a third-party platform where you can't verify
   that you own your subdomain". יש דיווחים מ-2025-2026 של מפתחים שאימתו
   `*.github.io` ב-Search Console ועדיין נדחו עם *"The website of your home page
   URL is not registered to you"*.

   > הערה: גם ההוראה הקודמת כאן ("Authorized domains: `github.io`") הייתה שגויה —
   > היחידה הנכונה היא `devfassaf.github.io`. זה ממילא לא עוזר כל עוד אין DNS.

   **הפתרון: דומיין משלנו.** קונים דומיין זול (~40-60 ₪ לשנה), מפנים אותו
   ל-GitHub Pages (קובץ `CNAME` בריפו + רשומות DNS אצל הרשם). האחסון נשאר חינם,
   אבל עכשיו יש DNS אמיתי לרשומת ה-TXT, והאתר נחשב "first-party". אחרי המעבר
   צריך לעדכן את `site.home` ו-`site.privacy` ב-[www/js/links.js](www/js/links.js).

   ⚠️ החשבון שמאמת ב-Search Console חייב להיות **Owner** על ה-property **וגם**
   Owner על פרויקט ה-Cloud. "Full User" לא מספיק.

3. **מסך ההסכמה.** ⚠️ מאפריל 2025 גוגל העבירה את כל הדף הזה למקום חדש בשם
   **Google Auth Platform** — הנתיב הישן `APIs & Services ← OAuth consent screen`
   כבר לא קיים. כתובות ישירות (הכי בטוח לגשת דרכן):

   | דף | כתובת | למה הוא משמש |
   |---|---|---|
   | Branding | `console.cloud.google.com/auth/branding` | שם, לוגו, דף בית, פרטיות, Authorized domains |
   | Audience | `console.cloud.google.com/auth/audience` | Testing / In production, test users |
   | Data Access | `console.cloud.google.com/auth/scopes` | הוספה והסרה של scopes |
   | Verification Center | `console.cloud.google.com/auth/verification` | ההגשה עצמה ומעקב אחריה |
   | Clients | `console.cloud.google.com/auth/clients` | ה-OAuth Client IDs |

   בדף **Branding** ממלאים: **Application home page** ו-**privacy policy link**
   (הכתובות מסעיף 1), ו-**App logo** — ריבוע 120×120 פיקסלים, עד 1MB
   (`www/assets/icon.svg` מומר ל-PNG). חשוב: **מוסיפים Authorized domains לפני**
   שממלאים את כתובות דף הבית והפרטיות, אחרת הן נדחות.

   ⚠️ **האימות הוא שני מסלולים נפרדים, וזה מה שרוב המדריכים מפספסים:**
   - **Brand verification** — כפתור **"Verify Branding"** בדף Branding. אוטומטי
     ברובו (דקות; אם עובר לבדיקה ידנית — 2-3 ימי עסקים).
   - **Data access verification** (ה-scope הרגיש) — ב-**Verification Center**.
     **חייבים לסיים את ה-brand verification קודם** — אחרת אי אפשר בכלל להגיש.

4. **סרטון הדגמה** (חובה ל-scope רגיש). מעלים אותו ל-**YouTube כ-Unlisted**
   ומוסרים **לינק** — לא מעלים קובץ. גוגל בודקת בו דברים ספציפיים, אז ודאו
   שכולם נראים בבירור:
   - הסרטון **באנגלית** (כולל החלפת שפת מסך ההסכמה לאנגלית — הבורר בפינה
     השמאלית התחתונה של המסך).
   - שם האפליקציה במסך ההסכמה **זהה** לשם ב-Cloud Console.
   - **ה-OAuth client ID גלוי בשורת הכתובת** בזמן ההסכמה.
   - כל scope רגיש **מודגם בשימוש אמיתי** — לא מספיק מסך ההתחברות: צריך להראות
     סרטון שמתווסף באפליקציה ואז **נרשם בפועל בגיליון**.

   תסריט מוצע (2-3 דקות): פתיחת האפליקציה → מסך ההורים → חיבור לגוגל → מסך
   ההסכמה (עוצרים עליו כמה שניות עם ה-client ID גלוי) → הדבקת לינק לסרטון →
   מעבר לגיליון בדפדפן ומראים את השורה החדשה שנוספה.

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
