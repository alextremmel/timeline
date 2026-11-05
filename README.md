# Timeline of Me

A private, time-stamped personal log: free-text notes and photos in one feed, built so an AI can later read it and look for trends.

- **App:** static files in this repo, served by GitHub Pages.
- **Data:** a Supabase project (`timeline`). Entries live in the `entries` table, photo records in `entry_photos`, and the image files in the private `photos` storage bucket.
- **Privacy:** row-level security lets only the signed-in owner read or write their own entries and photos. The publishable key in `config.js` is meant to be public.

## Data model

| Table | What it holds |
| --- | --- |
| `entries` | `ts` (when it happened), `tz` (time zone), `body` (free text, no tags), `source` (`me` for manual entries; later `strava`, `google_health`), `source_id`, `details` (JSON for imported data) |
| `entry_photos` | one row per photo: `entry_id`, storage `path`, `width`, `height` |

## Strava sync

- `supabase/functions/strava-start` — begins "Connect Strava" for the signed-in user
- `supabase/functions/strava-callback` — finishes the connection and stores tokens server-side (`oauth_tokens`, never readable by the app)
- `supabase/functions/strava-sync` — imports activities into `entries` with `source = 'strava'`; runs hourly (pg_cron job `strava-sync-hourly`) and when the app opens
- Needs Edge Function secrets `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`

## Files

- `index.html`, `styles.css`, `app.js` — the app
- `config.js` — Supabase project URL and publishable key
- `manifest.webmanifest`, `icons/` — home-screen icon and app settings
