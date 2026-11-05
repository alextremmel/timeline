# Timeline of Me

A private, time-stamped personal log: notes, meals, weight, mood, symptoms and photos in one feed, built so an AI can later look for trends.

- **App:** static files in this repo, served by GitHub Pages.
- **Data:** a Supabase project (`timeline`). Entries live in the `entries` table, photo records in `entry_photos`, and the image files in the private `photos` storage bucket.
- **Privacy:** row-level security lets only the signed-in owner read or write their own entries and photos. The publishable key in `config.js` is meant to be public.

## Data model

| Table | What it holds |
| --- | --- |
| `entries` | `ts` (when it happened), `body` (text), `tags` (food, drink, weight, mood, symptom, activity, sleep, meds, note), `weight_lb`, `mood` (1–5), `severity` (1–10), `rested` (1–5), `source` (`me` for manual entries; later `strava`, `google_health`), `source_id`, `details` (JSON for imported data) |
| `entry_photos` | one row per photo: `entry_id`, storage `path`, `width`, `height` |

## Files

- `index.html`, `styles.css`, `app.js` — the app
- `config.js` — Supabase project URL and publishable key
- `manifest.webmanifest`, `icons/` — home-screen icon and app settings
