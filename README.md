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

## Apple Health (via iPhone Shortcut)

- `supabase/functions/health-ingest` — receives POSTs from an iPhone Shortcut (header `x-timeline-key`; only its hash is stored in `ingest_keys`), stores each delivery in `health_raw`
- Workouts recorded by Strava and Fitbit reach Apple Health, so both arrive this way
- The direct Strava functions remain for later but are unscheduled (Strava's API needs a paid subscription)

## Fitbit (Google Health API)

- `supabase/functions/gh-start`, `gh-callback` — connect Google Health (tokens stored server-side in `oauth_tokens`)
- `supabase/functions/gh-sync` — hourly (pg_cron job `google-health-sync-hourly`) and on app open; pulls sleep, daily resting heart rate, daily HRV, steps and active calories; raw responses kept in `google_raw`
- Needs Edge Function secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

## Workout heart rate

- `supabase/functions/workout-hr` — hourly (pg_cron job `workout-hr-hourly`) and right after new Strava workouts arrive; reads Fitbit `heart-rate` samples (about every 2 s) from the Google Health API between each workout's start and end
- Every reading is kept in `workout_hr.samples` as `[seconds_from_start, bpm]`; a summary (average, max, min, heartbeats per mile, a 60-point graph line, minute-by-minute averages) is copied into the workout's `entries.details.hr`
- Status `pending` while Fitbit hasn't synced (retried for 48 h), then `none`; the Strava card shows "Heart rate syncing…" or "No heart rate recorded"

## Coming up (Exercise calendar)

- `supabase/functions/calendar-upcoming` — reads all-day events from the Google Calendar named "Exercise", today through 7 days ahead, live from Google on every call; nothing is stored, so past events simply disappear
- Uses the Google Health connection with two extra read-only scopes (`calendar.calendarlist.readonly`, `calendar.events.readonly`)
- The app shows them below a "Now" line in a "Coming up" section (gray CALENDAR cards); the app still opens at the Now line, so you scroll down to see them
- The AI link includes them as a PLANNED section (`planned_next_7_days` in JSON)

## Weather

- An evening iPhone automation ("Timeline Location") posts `{"lat", "lon"}` to `health-ingest`; it is rounded to about 1 km and stored in `places` with its time zone and local date
- `supabase/functions/weather-sync` — hourly (pg_cron job `weather-sync-hourly`); for each finished day since the first location, looks up that day's weather from Open-Meteo at that evening's location (or the last known one) and saves one `source = 'weather'` entry at 23:59: high/low, feels-like, humidity, dew point, UV, precipitation, wind, sunshine
- The app shows only the high/low as a small tag beside each date; the AI link and the `ai_daily` view carry the rest (no coordinates)

## Read-only AI link

- `supabase/functions/ai-export` — `GET /functions/v1/ai-export?key=…` returns the timeline as plain text (default), `format=json` (compact) or `format=csv`; `days=N` (default 30) or `from=`/`to=` dates; `kind=sleep,workout,note,photo,day_total,weather,nap`; `order=newest` (default, so a reader that truncates drops the oldest days) or `oldest`; `view=timeline` (default), `daily` or `both`; `photos=links`
- Each night's sleep includes its stage sequence (local start time, stage, minutes; blips under 2 min folded into the surrounding stage, awake periods always kept)
- Read-only; the secret key's hash lives in `export_keys` (set `revoked_at` to shut a key off)
- Built on the `ai_timeline` and `ai_daily` views

## References

- `refs` + `ref_versions`: things mentioned often (a specific milk, a usual meal). Entries link one by writing `[[Name]]`; plain words never do.
- Every change is a new dated version (`valid_from`), so the AI can tell what `[[Soy milk]]` meant on a given date. A typo fix can update the current version in place.
- `ai_references` view and the top of the AI link list every version with its date range.

## Files

- `index.html`, `styles.css`, `app.js` — the app
- `config.js` — Supabase project URL and publishable key
- `manifest.webmanifest`, `icons/` — home-screen icon and app settings
