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

/**
 * The detailed add-content guide (v1.0.20). 18 slides, grouped into CHAPTERS via the
 * optional `chapter` field — a deck this long shows a chapter chip and a
 * "שלב N מתוך M" counter instead of 18 unreadable dots (see deckChrome).
 *
 * Images: every APP screen is a real 1280x800 screenshot (assets/guide/app-*.jpg,
 * share-04/05) staged through the real UI; only what is NOT ours — YouTube's share
 * button, Android's app chooser, the spreadsheet, the Drive folder — is a drawing.
 * That mix is deliberate: a parent hunting for a real button needs to recognise it.
 */
export const ADD_GUIDE_SLIDES = [
  {
    img: 'assets/guide/map-00-three-ways.svg', chapter: 'לפני שמתחילים',
    title: 'שלוש דרכים להוסיף תוכן',
    text: 'אפשר לשתף סרטון מיוטיוב, להדביק לינק במסך ההורים, או לכתוב אותו בקובץ הרשימה בגוגל דרייב. שלושתן מגיעות לאותו מקום — מסך הבית של הילד. נעבור עליהן אחת-אחת.'
  },

  /* ---- דרך 1: שיתוף מיוטיוב ---- */
  {
    img: 'assets/guide/share-01-open.svg', chapter: 'דרך 1 · שיתוף מיוטיוב',
    title: 'פותחים ביוטיוב ולוחצים "שיתוף"',
    text: 'זו הדרך המהירה. מצאתם ביוטיוב סרטון או ערוץ שמתאים לילד? לוחצים על כפתור השיתוף — מתחת לסרטון, או ליד שם הערוץ בעמוד הערוץ.'
  },
  {
    img: 'assets/guide/share-02-choose.svg', chapter: 'דרך 1 · שיתוף מיוטיוב',
    title: 'בוחרים "הסרטונים שלי"',
    text: 'ברשימת האפליקציות שנפתחת בוחרים את "הסרטונים שלי". אם היא לא מופיעה — גוללים ימינה ברשימה או לוחצים "עוד". האפליקציה תיפתח בעצמה.'
  },
  {
    img: 'assets/guide/share-04-pin.jpg', chapter: 'דרך 1 · שיתוף מיוטיוב',
    title: 'מקישים את קוד ההורים',
    text: 'לפני שמשהו נכנס לילד — האפליקציה מבקשת את קוד ההורים. ככה גם אם הטאבלט בידיים של הילד, שיתוף מיוטיוב לא יכול להוסיף תוכן בלעדיכם.'
  },
  {
    img: 'assets/guide/share-05-confirm.jpg', chapter: 'דרך 1 · שיתוף מיוטיוב',
    title: 'רואים מה מתווסף — ומאשרים',
    text: '"הוספה" — והסרטון כבר אצל הילד. "לא עכשיו" לא מוחק אותו: הוא נשמר ברשימת ההמתנה שבמסך ההורים. שיתוף של ערוץ שלם עובד בדיוק אותו הדבר.'
  },

  /* ---- דרך 2: במסך ההורים ---- */
  {
    img: 'assets/guide/app-01-empty-home.jpg', chapter: 'דרך 2 · במסך ההורים',
    title: 'נכנסים למסך ההורים',
    text: 'המסך של הילד ריק? מכאן מתחילים. לוחצים על 🔒 "הורים" בפינה למעלה ומקישים את קוד ההורים — לשם הילד לא מגיע.'
  },
  {
    img: 'assets/guide/app-02-parent-tabs.jpg', chapter: 'דרך 2 · במסך ההורים',
    title: 'חמש הלשוניות של מסך ההורים',
    text: 'אודות · ממתינים · הוספה · מקורות · הגדרות. להוספת תוכן לוחצים על "הוספה". הנקודה האדומה על "ממתינים" אומרת שיש סרטונים שמחכים לאישור שלכם.'
  },
  {
    img: 'assets/guide/app-03-add-paste.jpg', chapter: 'דרך 2 · במסך ההורים',
    title: 'מדביקים לינק ולוחצים "הוספה"',
    text: 'מעתיקים לינק מיוטיוב — מהדפדפן או מכפתור השיתוף — ומדביקים בשדה. תחת "אפשרויות" אפשר לתת לסרטון שם משלכם או תמונה, אבל זה לא חובה.'
  },
  {
    img: 'assets/guide/app-04-add-done.jpg', chapter: 'דרך 2 · במסך ההורים',
    title: 'נוסף! ✅',
    text: 'ההודעה הירוקה מאשרת שהסרטון נכנס, והוא מופיע ברשימה שמתחת עם התמונה שלו. השם מגיע אוטומטית מיוטיוב — לפעמים אחרי כמה שניות.'
  },
  {
    img: 'assets/guide/app-05-add-channel.jpg', chapter: 'דרך 2 · במסך ההורים',
    title: 'ערוץ שלם בלינק אחד',
    text: 'מדביקים לינק של ערוץ (למשל youtube.com/@SuperSimpleSongs) — והאפליקציה מביאה את הסרטונים שלו ופותחת לו תיקייה עם הלוגו במסך של הילד. מכאן זה אוטומטי: בכל פתיחה של האפליקציה היא בודקת מה חדש בערוץ ומושכת אותו לבד, ולא צריך לעשות שוב כלום. נמשכים רק סרטונים מלשוניות "סרטונים" ו"פלייליסטים" — בלי Shorts ובלי שידורים חיים. כל סרטון חדש יחכה לאישור שלכם.'
  },
  /* v1.0.33 — the YouTube search inside the add tab. Two slides, appended at the END
     of this chapter (chapters must stay contiguous, tour.test.mjs), and they bring the
     deck to EXACTLY the 20-slide cap — the next slide anyone adds must raise the cap
     and re-justify "finishable in one sitting". Both are REAL screenshots (the test
     rejects drawn app screens). */
  {
    img: 'assets/guide/app-12-search.jpg', chapter: 'דרך 2 · במסך ההורים',
    title: 'או מחפשים ישר מתוך האפליקציה',
    text: 'בראש לשונית ההוספה יש שורת חיפוש של יוטיוב: מקלידים כמו ביוטיוב — מופיעות הצעות השלמה תוך כדי הקלדה — ולוחצים 🔍. לא צריך לצאת לאפליקציית יוטיוב ולהעתיק לינקים.'
  },
  {
    img: 'assets/guide/app-13-search-results.jpg', chapter: 'דרך 2 · במסך ההורים',
    title: 'מוסיפים מהתוצאות בלחיצה אחת',
    text: 'התוצאות הן בדיוק מה שיוטיוב מציג — סרטונים, ערוצים ופלייליסטים (בלי Shorts), עם כפתורי סינון לפי סוג. לחיצה על התמונה פותחת צפייה מקדימה כדי להחליט, ולחיצה על ➕ מוסיפה לספרייה — סרטון נכנס מיד, ערוץ או פלייליסט עוברים את אותו מסך אישור מוכר.'
  },

  /* ---- דרך 3: קובץ הרשימה ---- */
  {
    img: 'assets/guide/app-07-sources-create.jpg', chapter: 'דרך 3 · קובץ הרשימה',
    title: 'יוצרים קובץ רשימה בדרייב',
    text: 'לשונית "מקורות" ← "✨ יצירת רשימה חדשה", והאפליקציה יוצרת בשבילכם גיליון בגוגל דרייב שלכם. הדרך הזו נוחה כשרוצים להוסיף הרבה סרטונים בבת אחת מהמחשב.'
  },
  {
    img: 'assets/guide/app-08-sources-connected.jpg', chapter: 'דרך 3 · קובץ הרשימה',
    title: 'מעתיקים את הלינק לקובץ',
    text: '"📋 העתקת הלינק לרשימה" מעתיק את כתובת הקובץ — שולחים אותה לעצמכם ופותחים במחשב. "🔄 רענון עכשיו" מביא מיד את מה שהוספתם, בלי לחכות לסנכרון.'
  },
  {
    img: 'assets/guide/sheet-03-columns.svg', chapter: 'דרך 3 · קובץ הרשימה',
    title: 'שורה אחת = סרטון אחד',
    text: 'בעמודה A מדביקים את הלינק, וזה כל מה שחייבים. בעמודה B אפשר לכתוב שם שיוצג לילד, ובעמודה C לרשום auto כדי שסרטונים חדשים מערוץ ייכנסו בלי אישור. שורה שמתחילה ב-# היא הערה שהאפליקציה מדלגת עליה.'
  },
  {
    img: 'assets/guide/sheet-04-drive-folder.svg', chapter: 'דרך 3 · קובץ הרשימה',
    title: 'הקובץ פרטי — והסנכרון דו-כיווני',
    text: 'הקובץ יושב בתיקייה "רשימת השמעה לאפליקציה הסרטונים שלי" בדרייב שלכם, ורק אתם רואים אותו. מה שתוסיפו בקובץ יופיע באפליקציה, ומה שתוסיפו באפליקציה יירשם בקובץ — וגם מחיקות עוברות בשני הכיוונים.'
  },

  /* ---- אישור ומחיקה ---- */
  {
    img: 'assets/guide/app-06-channel-auto.jpg', chapter: 'אישור ומחיקה',
    title: 'ערוץ שאתם סומכים עליו',
    text: 'בלשונית "מקורות", ליד כל ערוץ, יש "אישור אוטומטי לסרטונים חדשים". מסמנים — וסרטונים חדשים מהערוץ יגיעו לילד בלי לחכות לכם. משאירים כבוי = הכול עובר דרככם.'
  },
  {
    img: 'assets/guide/app-09-pending.jpg', chapter: 'אישור ומחיקה',
    title: 'רשימת ההמתנה',
    text: 'כל מה שמחכה לאישור נמצא בלשונית "ממתינים": ✅ מאשר, 🗑️ דוחה, ויש גם "אישור הכול". סרטון שדחיתם לא יחזור — גם לא בסנכרון הבא.'
  },
  {
    img: 'assets/guide/app-10-delete.jpg', chapter: 'אישור ומחיקה',
    title: 'מוחקים סרטון',
    text: 'בלשונית "הוספה" יש רשימה של כל הסרטונים, עם 🗑️ ליד כל אחד. אפשר למחוק גם בזמן צפייה, מהפינה למעלה, עם קוד ההורים. המחיקה נשמרת — הסרטון לא חוזר בסנכרון.'
  },
  {
    img: 'assets/guide/app-11-kid-home.jpg', chapter: 'אישור ומחיקה',
    title: 'וזה מה שהילד רואה',
    text: 'תיקייה לכל ערוץ, "סרטונים נוספים" לכל השאר, וסרטונים חדשים שמחכים עטופים כמתנה 🎁. בלי פרסומות, בלי המלצות, בלי דרך לצאת ליוטיוב — רק מה שאתם בחרתם.'
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

/** Above this many slides, dots stop being countable and become a step counter. */
export const DOTS_MAX = 8;

/**
 * The chrome for ONE position in ANY deck (v1.0.20). Long decks (the add-content
 * guide) get a chapter chip + "שלב N מתוך M"; the short onboarding deck keeps its
 * dots and shows no chapter, so nothing about the first run changes.
 * Pure: takes the deck, returns strings — app.js only writes them into the DOM.
 */
export function deckChrome(deck, idx) {
  const list = Array.isArray(deck) ? deck : [];
  const total = list.length;
  const i = Math.min(Math.max(0, Number(idx || 0)), Math.max(0, total - 1));
  const slide = list[i] || {};
  return {
    chapter: typeof slide.chapter === 'string' ? slide.chapter : '',
    stepLabel: total ? `שלב ${i + 1} מתוך ${total}` : '',
    useDots: total > 0 && total <= DOTS_MAX
  };
}

/**
 * Chapter table for a deck: [{ title, from, to, count }] in slide order.
 * Only the tests and future navigation need it, but deriving it from the deck
 * itself is what keeps the chapter labels from drifting out of sync with the
 * slides (a hand-maintained second list is the bug this avoids).
 */
export function chapters(deck) {
  const out = [];
  (Array.isArray(deck) ? deck : []).forEach((s, i) => {
    const title = (s && typeof s.chapter === 'string') ? s.chapter : '';
    if (!title) return;
    const last = out[out.length - 1];
    if (last && last.title === title) { last.to = i; last.count++; return; }
    out.push({ title, from: i, to: i, count: 1 });
  });
  return out;
}

/**
 * Hardware back: step back, or FINISH on the first slide. Back must never exit
 * the app from inside the tour, and must never leave a half-shown deck behind.
 */
export function backAction(idx) {
  return Number(idx || 0) > 0 ? 'prev' : 'finish';
}
