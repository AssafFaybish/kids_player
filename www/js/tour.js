// tour.js — the onboarding DECKS and the pure slide arithmetic behind them.
//
// Two decks share one view (`view-tour`) and one renderer:
//   TOUR_SLIDES      — first run. Opens with a landing page explaining what the
//                      app IS and who it is for, then the five screen tours.
//   ADD_GUIDE_SLIDES — "how do I actually add videos?", the question that decides
//                      whether a parent can use the app at all. Deliberately a
//                      SEPARATE chapter: a 14-page forced tour on first launch
//                      gets skipped wholesale, so the first run stays short and
//                      this opens from the last tour slide, from the parent
//                      screen, and from the About tab — whenever it is wanted.
//
// No imports on purpose: pure data + pure functions, so it sits anywhere in the
// import order and every navigation decision is unit-testable (the bounds
// arithmetic used to be copy-pasted across four places in app.js).

/* ---------------- decks ---------------- */

export const TOUR_SLIDES = [
  {
    img: 'assets/guide/intro-hero.svg', title: 'ברוכים הבאים ל"הסרטונים שלי"',
    text: 'יוטיוב הוא ים אינסופי של פרסומות, המלצות אקראיות וסרטונים שלא בחרתם. האפליקציה הזו הופכת את הכיוון: אתם מחליטים בדיוק מה קיים, והילד מקבל מסך בית קטן, נקי ובטוח — בלי פרסומות, בלי המלצות ובלי דרך לצאת החוצה.'
  },
  {
    img: 'assets/tour/01-profiles.jpg', title: 'לכל ילד פרופיל משלו',
    text: 'בכניסה בוחרים פרופיל — שם ותמונה. לכל פרופיל ספריית סרטונים, מתנות והתקדמות משלו.'
  },
  {
    img: 'assets/tour/02-home.jpg', title: 'מסך הבית של הילד',
    text: 'ערוצים כתיקיות עם הלוגו שלהם, "סרטונים נוספים" לכל השאר, חיפוש 🔍 למעלה — וסרטונים חדשים מגיעים עטופים כמתנה 🎁.'
  },
  {
    img: 'assets/tour/03-watch.jpg', title: 'צפייה בטוחה',
    text: 'בלי פרסומות, בלי המלצות, בלי יציאה ליוטיוב. הבית 🏠 ומחיקת סרטון 🗑️ (עם קוד הורים) — בפינות למעלה.'
  },
  {
    img: 'assets/tour/04-parent.jpg', title: 'מסך ההורים 🔒',
    text: 'נכנסים עם קוד. מוסיפים סרטון בודד או ערוץ שלם, מחברים קובץ מקורות בגוגל — וכל הוספה נרשמת בקובץ אוטומטית.'
  },
  {
    img: 'assets/tour/05-approve.jpg', title: 'הכול באישור שלכם',
    text: 'סרטונים חדשים בערוצים ממתינים לאישור. נקודה אדומה על כפתור ההורים אומרת שמשהו מחכה לכם.'
  }
];

export const ADD_GUIDE_SLIDES = [
  {
    img: 'assets/guide/intro-hero.svg', title: 'איך מוסיפים סרטונים?',
    text: 'זה הלב של האפליקציה — בלי זה מסך הבית של הילד יישאר ריק. יש שלוש דרכים, וכולן מגיעות לאותו מקום. נעבור עליהן אחת-אחת.'
  },
  {
    img: 'assets/guide/share-01-open.svg', title: 'דרך 1: שיתוף מיוטיוב — הכי מהיר',
    text: 'מצאתם ביוטיוב סרטון או ערוץ שמתאים לילד? פותחים אותו באפליקציית יוטיוב ולוחצים על כפתור השיתוף.'
  },
  {
    img: 'assets/guide/share-02-choose.svg', title: 'בוחרים "הסרטונים שלי"',
    text: 'ברשימת האפליקציות שנפתחת בוחרים את "הסרטונים שלי". אם היא לא מופיעה — גוללים ימינה ברשימה או לוחצים "עוד".'
  },
  {
    img: 'assets/guide/share-03-approve.svg', title: 'מקישים את קוד ההורים ומאשרים',
    text: 'האפליקציה נפתחת, מבקשת את קוד ההורים ומראה לכם מה עומד להתווסף. מאשרים — והסרטון כבר אצל הילד. ביטול שומר אותו ברשימת ההמתנה במקום למחוק אותו.'
  },
  {
    img: 'assets/guide/add-01-inapp.svg', title: 'דרך 2: הדבקת לינק בתוך האפליקציה',
    text: 'במסך ההורים יש שדה להדבקת לינק. עובד גם לסרטון בודד וגם לערוץ שלם — ערוץ מביא אוטומטית את כל הסרטונים שלו, וכל סרטון חדש שיעלה בו יגיע לאישורכם.'
  },
  {
    img: 'assets/guide/sheet-01-what.svg', title: 'דרך 3: קובץ הרשימה בגוגל דרייב',
    text: 'האפליקציה יוצרת לכם קובץ בגוגל דרייב, בתיקייה "רשימת השמעה לאפליקציה הסרטונים שלי". כל שורה בו = סרטון אחד או ערוץ אחד. נוח כשרוצים להוסיף הרבה בבת אחת מהמחשב. הקובץ פרטי לחשבון שלכם — רק אתם רואים אותו.'
  },
  {
    img: 'assets/guide/sheet-02-paste.svg', title: 'פשוט מדביקים לינק בשורה חדשה',
    text: 'במסך ההורים ← מקורות יש כפתור "העתקת הלינק לרשימה". פותחים את הקובץ בדפדפן, מדביקים לינק מיוטיוב בשורה ריקה בעמודה הראשונה — וזהו. אפשר להוסיף שם לסרטון בעמודה השנייה, אבל זה לא חובה.'
  },
  {
    img: 'assets/guide/sheet-01-what.svg', title: 'הקובץ והאפליקציה מסונכרנים',
    text: 'מה שתוסיפו בקובץ יופיע באפליקציה בסנכרון הבא, ומה שתוסיפו באפליקציה יירשם בקובץ אוטומטית. גם מחיקה עוברת בשני הכיוונים, כך שהרשימה תמיד זהה בכל המכשירים.'
  },
  {
    img: 'assets/tour/05-approve.jpg', title: 'ואתם תמיד מאשרים לפני הילד',
    text: 'סרטון חדש שעולה בערוץ שעוקבים אחריו לא מגיע לילד לבד — הוא ממתין לכם במסך ההורים עם נקודה אדומה. אפשר גם להגדיר ערוץ מסוים כ"מאושר אוטומטית" אם אתם סומכים עליו.'
  }
];

/* ---------------- pure slide arithmetic ---------------- */

/** Clamped move. `delta` is +1 (next) or -1 (previous). */
export function nextIndex(idx, len, delta) {
  const n = Number(idx || 0) + Number(delta || 0);
  const last = Math.max(0, Number(len || 0) - 1);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > last ? last : n;
}

/** Everything the chrome needs for one position — no DOM, no globals. */
export function slideState(idx, len) {
  const total = Math.max(0, Number(len || 0));
  const i = Math.min(Math.max(0, Number(idx || 0)), Math.max(0, total - 1));
  const last = total > 0 && i >= total - 1;
  return {
    index: i,
    isFirst: i <= 0,
    isLast: last,
    nextLabel: last ? '✔' : '◀',   // RTL: ◀ points forward
    prevDisabled: i <= 0,
    dots: Array.from({ length: total }, (_, n) => n === i)
  };
}

/**
 * Hardware back: step back, or FINISH on the first slide. Back must never exit
 * the app from inside the tour, and must never leave a half-shown deck behind.
 */
export function backAction(idx) {
  return Number(idx || 0) > 0 ? 'prev' : 'finish';
}
