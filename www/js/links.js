// links.js — THE single place to edit every external address the app uses.
//
// Nothing here is logic: it's configuration. If a payment link changes, an email
// changes, the repo moves, or the website moves — you edit THIS file only, and
// never hunt through the code. Every consumer imports from here:
//   donate.js  → donate         (the support buttons)
//   app.js     → contact, site  (mail to the developer, privacy policy)
//   update.js  → updateRepo     (where releases and the APK come from)
//
// Rules that keep this safe:
//  * Payment/website links MUST be https — platform.openExternal refuses anything
//    else, and the donation UI hides a method whose link is empty or malformed.
//  * An empty string means "not offered". Both donation links empty ⇒ the whole
//    donation block disappears (that is a supported state, covered by tests).

export const LINKS = {
  /** Voluntary donations. Empty string = that method isn't offered. */
  donate: {
    // PayBox collection ("קופה") — the familiar Hebrew flow for Israeli parents.
    paybox: 'https://links.payboxapp.com/Q1nryiT6b5b',
    // PayPal.me — credit card / international fallback.
    paypal: 'https://paypal.me/assaffaybish'
  },

  /** Where the About tab's "💡 שלח הצעות לשיפור" button sends the parent. */
  contact: {
    email: 'dev.fassaf@gmail.com',
    cc: 'fassaf.f@gmail.com',
    subject: 'הסרטונים שלי — הצעות לשיפור'
  },

  /**
   * The public site (GitHub Pages, served from docs/). Google's OAuth verification
   * requires a public homepage + privacy policy for the sensitive `spreadsheets`
   * scope; the About tab also links the privacy policy so parents can read it.
   */
  site: {
    home: 'https://devfassaf.github.io/kids_player/',
    privacy: 'https://devfassaf.github.io/kids_player/privacy.html'
  },

  /** owner/repo the in-app updater reads releases from (asset: kids-player-v<X.Y.Z>.apk). */
  updateRepo: 'devfassaf/kids_player'
};
