# GPS Maintenance Tracker

Field app for GPS installation and repair work. Data is stored in **Supabase**. Frontend is hosted on **GitHub Pages**.

## Login

Login credentials are managed in the app code and should be shared privately with users.

---

## Supabase

The app is already connected to this Supabase project:

```txt
https://jzclmcjurfehpfybxryh.supabase.co
```

If the database tables are not created yet, open Supabase **SQL Editor**, copy all of `supabase/schema.sql`, and run it once.

---

## Run locally

```bash
cd gps-maintenance-tracker
python3 -m http.server 8080
```

Open http://localhost:8080

---

## Push to GitHub

1. Create a new repo on GitHub, for example `gps-maintenance-tracker`.
2. In terminal:

```bash
cd gps-maintenance-tracker
git remote add origin https://github.com/YOUR_USERNAME/gps-maintenance-tracker.git
git push -u origin main
```

---

## Enable GitHub Pages

1. On GitHub, open your repo → **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**.
3. Go to **Actions** tab. The deploy workflow runs on push to `main`.
4. After it succeeds, your site is live at:

```
https://YOUR_USERNAME.github.io/gps-maintenance-tracker/
```

No GitHub secrets are required because the Supabase public URL and anon public key are built into the app.

---

## Bulk Upload

Admin can upload old data in one go.

1. Login as `admin`.
2. Open the **Installations** tab or **Repair Work** tab.
3. Click **Download sample file**.
4. Fill the CSV file.
5. Click **Upload filled file**.

Installation CSV columns:

```txt
imei, vehicle_no, gps_model, sim_no, mac_id, sensor_no, created_at, created_by
```

Repair CSV columns:

```txt
imei, wiring_connection, sim_change, new_sim_no, device_change, new_imei, created_at, created_by
```

Use `akash` in `created_by` when those old records should appear in Akash's **My Entries** view.

---

## What goes where

| Item | Where |
|------|--------|
| Installations | Supabase `installations` table |
| Repair records | Supabase `maintenance_records` table |
| Website files | GitHub repo |
| Live site | GitHub Pages |
| Database | Supabase cloud |

---

## Migrate old browser data (optional)

If you used the app before with localStorage, old data stays in your browser only. You would need to re-enter it, or ask for an import script.

---

## Security note

Login (akash/admin) is handled in the app. Supabase uses the public anon key, which is safe to publish, but the current Row Level Security policies allow public read/insert/update for this project. For production, add Supabase Auth and tighter Row Level Security policies.
