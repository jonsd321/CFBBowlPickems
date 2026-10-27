// League settings. This is the only file you should need to edit.
export const CONFIG = {
  leagueName: 'CFB Bowl Pickems',

  // ESPN's "season" for the bowls: 2026 = the 2026-27 bowl season (Dec 2026 - Jan 2027).
  // Override in the browser with ?season=2025 to preview a finished season.
  season: 2025,

  // ESPN group filter. 80 = FBS. Set to null to include every postseason game ESPN lists.
  espnGroup: 80,

  // How often (seconds) to re-pull scores from ESPN while the page is open.
  refreshSeconds: 60,

  // Extra or replacement bowl logos, keyed by the bowl name shown on the site.
  // e.g. { 'Brand New Bowl': 'img/bowls/brand-new-bowl.png' }
  bowlLogos: {},

  // Paste your Firebase web app config here (Firebase console > Project settings > Your apps).
  // Leave apiKey empty to run in demo mode, where picks are saved only in this browser.
  firebase: {
    apiKey: 'AIzaSyCvLFjADkGNqz7Q5irsRmHgAxLhSxDkhNE',
    authDomain: 'cfb-bowl-pool-70c3f.firebaseapp.com',
    projectId: 'cfb-bowl-pool-70c3f',
    appId: '1:328377190979:web:03234eaf3128f6616ae2f6',
  },

  // Push notifications (README > Push notifications). workerUrl is printed when you deploy the
  // Worker; leave it empty to hide the Notifications section. The public key must match
  // VAPID_PUBLIC_KEY in worker/wrangler.toml.
  push: {
    workerUrl: 'https://cfb-bowl-pickems-push.jonsd321.workers.dev',
    vapidPublicKey: 'BDPT2xfgE70KO2JNaetrvPqQwK6YcP_B7j9aAt_77GJl21jQDK3kfAitozuCkDDlYyjQBJRQ8kEkYhtk99_4PqA',
  },
};
