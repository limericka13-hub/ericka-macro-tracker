# Ericka's Macro Tracker

A private instance of the Macro Tracker PWA, with its own Supabase project,
GitHub repo and Vercel deployment. It shares no data with the original app.

## Why a fork and not a second login

The app is single-tenant: none of the five tables has a `user_id`, and no query
filters by user. Every row belongs to whoever is signed into that Supabase
project, so two people need two projects.

## Pulling in changes from the original

All development happens in the original app. To bring its changes here:

```
node scripts/sync-from-original.mjs
npm run dev
```

The script copies the original's files and reapplies this instance's edits
(config hookup, branding, the original's credentials stripped, its own service
worker cache). It stops without writing anything if an edit no longer fits or
the original has a file it doesn't recognise, and it refuses to write anything
containing the original's Supabase project. Check locally, then commit and push;
Vercel deploys on push.

**Never copy files across by hand.** `app.js` and `index.html` both carry edits,
and a straight copy puts the original's Supabase project back into this app.

If a change touches the database, apply the same SQL to both Supabase projects.

## What's specific to this instance

| File | Role |
|---|---|
| `config.js` | Supabase URL and publishable key, app name. Never synced. |
| `schema.sql` | Creates the tables, access policies and realtime. Safe to re-run. |
| `scripts/sync-from-original.mjs` | The sync above. |

## Secrets

None in this repo. The Supabase publishable key is public by design; the tables
only open to a signed-in user, and sign-ups are switched off so her account is
the only one. The USDA key is a free public-data key. The one real secret,
`GEMINI_API_KEY`, is a Vercel environment variable read server-side in
`api/gemini.js`.

## Run locally

```
npm install
npm run dev
```

Serves on http://localhost:3000. `server.js` mirrors the two Vercel functions
(`/api/off-search`, `/api/gemini`). Voice input needs `GEMINI_API_KEY` in
`.env.local`; without it, it falls back to plain text parsing.

## Database notes

- `macro_targets` holds exactly one row. Its `id` is `GENERATED ALWAYS`, so the
  app only ever updates it.
- `macro_daily_logs` also holds three reserved rows: `...0001` the day's draft,
  `...0002` the half-built meal, `...0003` carried calories and planned days.
- Supabase's free tier pauses a project after a week with no activity. Daily use
  keeps it awake; if it does pause, resume it from the Supabase dashboard.
