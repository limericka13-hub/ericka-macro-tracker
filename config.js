/**
 * This instance's settings - what makes this app Ericka's rather than the
 * original. app.js reads them at runtime; scripts/sync-from-original.mjs reads
 * APP_NAME and APP_SHORT_NAME to brand index.html and manifest.json. The sync
 * script never overwrites this file.
 *
 * Nothing here is secret. The Supabase publishable key is public by design and
 * only works for a signed-in user, because every table's row-level security
 * policy requires one (see schema.sql). The USDA key is a free public-data key.
 * The only real secret, GEMINI_API_KEY, is a Vercel environment variable read
 * server-side in api/gemini.js; it never reaches the browser.
 */

window.APP_CONFIG = {
  // ---- Ericka's Supabase project -------------------------------------------
  // From her project's Connect dialog (URL) and Project Settings -> API Keys
  // (publishable key).
  SUPABASE_URL: 'https://azqywzdzlahxvxibgyfa.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_LJRxuFpXDATNfEnJwiJepQ_2RxiCQx1',

  // ---- Shared, free-tier key -----------------------------------------------
  // The same key as the original app: public data, no personal information,
  // and ample quota for two people.
  USDA_API_KEY: 'RFe1YPJI28FNOWHX82BdooszJJaA2hftQ0gUEsbf',

  // ---- Branding ------------------------------------------------------------
  APP_NAME: "Ericka's Macro Tracker",
  APP_SHORT_NAME: 'Macros'
};
