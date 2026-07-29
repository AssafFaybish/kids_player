# PUBLISHING.md — הפצה, חתימה, ולמה לא חנות Play

## סטטוס: לא מפורסם בחנות. הפצה פרטית (sideload) דרך GitHub Releases.

## למה לא Google Play — שלושת החוסמים האמיתיים

1. **תנאי השימוש של YouTube API.** הנגן משתמש ב-`controls:0` + שכבת מגע שקופה
   (`#tap-shield`) מעל ה-iframe — זה מסתיר את פקדי YouTube ואת המיתוג שלו וחוסם את
   ה-overlays/end-cards. תנאי YouTube API Services מחייבים שפקדי הנגן המוטמע
   והמיתוג יישארו גלויים ואוסרים לכסות את הנגן. זו בחירת עיצוב **מכוונת ונושאת-משקל**
   לילד בן 5, ואין דרך אמצע (הסתרת ה-chrome של YouTube היא הכול-או-כלום). זה מתקבל
   על הדעת לאפליקציה משפחתית פרטית; זה לא מתקבל בחנות.
2. **`REQUEST_INSTALL_PACKAGES`.** Play מגביל את ההרשאה לאפליקציות שייעודן התקנת
   אפליקציות, ו-self-updater אסור מפורשות — עדכונים חייבים לעבור דרך Play.
   פרסום = מחיקת פיצ'ר העדכון-מתוך-האפליקציה.
3. **מדיניות Families.** אפליקציה מכוונת-ילדים גוררת: טופס Data Safety (עם OAuth —
   הצהרת מזהי חשבון), שאלון דירוג תוכן, וכללי פרסומות Families. בסרטונים ממונטזים
   **הפרסומות של YouTube מתנגנות בתוך האפליקציה** — פרסומות שהאפליקציה לא שולטת בהן
   ולא יכולה לאשר כתואמות-ילדים. זה לבדו כנראה פוסל.

בנוסף: Play App Signing חותם מחדש את ה-APK — ה-SHA-1 של OAuth היה הופך לשל Play
ומחייב רישום מחדש של ה-clients.

## מה היה צריך להשתנות כדי לפרסם (מסקנה: לא)
לוותר על ה-tap-shield ועל `controls:0` (נטישת ליבת החוויה), למחוק את המעדכן,
להוסיף מדיניות פרטיות, ולחיות עם פרסומות YouTube. **לא שווה את זה.**

---

## חתימה — כללי הברזל

- ה-keystore: `~/.keystores/kids-player-release.jks` (PKCS12, תקף עד 2056).
  הסיסמאות: `~/.keystores/kids-player.properties`. **מחוץ ל-repo בכוונה.**
- 🔴 **אובדן ה-keystore או הסיסמה = אף עדכון עתידי לא יותקן לעולם** (חתימה שונה →
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; הפתרון היחיד הוא הסרה שמוחקת את כל הנתונים)
  + ה-SHA-1 של OAuth לא ניתן לשחזור. **גבו את שני הקבצים למנהל סיסמאות עכשיו.**
- debug builds מותקנים כ-`com.assaf.kidsplayer.dev` — לעולם לא מתנגשים עם ההתקנה
  האמיתית (מבנית אי אפשר לדרוס אותה עם build לא חתום).
- ה-guard ב-`release/android-release.gradle` מפיל build של release בלי חתימה —
  לעולם אל תעקפו אותו.

## גרסה — מקור אמת יחיד

`package.json → "version": "X.Y.Z"` ⟶ gradle גוזר `versionName`=X.Y.Z,
`versionCode`=X*10000+Y*100+Z ⟶ JS קורא את עצמו ב-`App.getInfo()`.
`versionCode` חייב לעלות מונוטונית (מובטח כל עוד לא מקטינים את הגרסה).

## צ'קליסט הוצאת גרסה

```bash
# 1) עדכון גרסה (מקור האמת)
npm version patch --no-git-tag-version     # או minor/major

# 2) טסטים
npm test

# 3) בניית release חתום
npm run apk:release

# 4) אימות חתימה — חובה, לפני כל פרסום
npm run apk:verify                          # חייב להציג CN=Kids Player

# 5) שם קובץ לפי המוסכמה שהמעדכן מחפש
cp android/app/build/outputs/apk/release/app-release.apk kids-player-v<X.Y.Z>.apk

# 6) פרסום ל-GitHub Releases (ה-repo הציבורי devfassaf/kids_player)
gh release create v<X.Y.Z> kids-player-v<X.Y.Z>.apk \
  --repo devfassaf/kids_player -t "v<X.Y.Z>" -n "מה חדש: ..."

# 7) commit + tag למקור
git add package.json && git commit -m "release v<X.Y.Z>" && git tag v<X.Y.Z> && git push --tags
```

המעדכן באפליקציה קורא את `releases/latest` (מדלג על drafts/prereleases — אפשר לפרסם
בטא עם `--prerelease` והמכשירים יתעלמו ממנה), משווה גרסאות נומרית, מוריד עם אימות
גודל, ומפעיל את מתקין המערכת. בטלפון נדרש אישור חד-פעמי של "התקנת אפליקציות לא
ידועות" לאפליקציה.

## התקנה ראשונה של גרסת release על טאבלט שמריץ debug ישן (חד-פעמי!)

1. מסך הורים ← הוספה ← **ייצוא** (גיבוי מלא ללוח — לשמור בקובץ!).
2. הסרת האפליקציה הישנה (מוחקת את כל הנתונים).
3. התקנת ה-APK החתום.
4. מסך הורים ← **ייבוא** של קובץ הגיבוי. הכול חוזר (כולל מחיקות ומתנות שנפתחו).
