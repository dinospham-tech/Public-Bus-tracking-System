# Deploying the apps on Vercel

Keep both apps in this repository, then create **two Vercel projects** connected to the same repository. Set each project's Root Directory to its app folder:

- `customer screen` deploys as the CityBus Passenger app.
- `driver screen` deploys as the DriveOps Driver app.

Each app gets its own Vercel URL, manifest, icon, and standalone mobile home-screen experience. The API remains on the existing Render service (`render.yaml`). It owns the shared live bus state and WebSocket feed, so keep both phones connected to that same backend.

## Setup

1. Deploy the existing `genesis-citybus` web service from `render.yaml` on Render.
2. Create a Vercel project for the customer app. Set its Root Directory to `customer screen` and its framework preset to **Other**.
3. Create a second Vercel project for the driver app. Set its Root Directory to `driver screen` and its framework preset to **Other**.
4. In **both** Vercel projects, add `BUS_API_URL` for Production, Preview, and Development. Set it to `https://public-bus-tracking-system.onrender.com`.
5. If you use a custom `DEVICE_API_KEY` on Render, add the same value to the driver Vercel project's environment variables.
6. Deploy both projects. Each local `vercel.json` builds that app as a standalone mobile web app and injects the backend configuration.

The Render service must allow browser requests from both Vercel domains. Its current default `CORS_ORIGIN=*` allows this. If you restrict CORS, set `CORS_ORIGIN` to the two origins separated by commas.

`DEVICE_API_KEY` is embedded in the driver page because the browser sends it with telemetry. It is visible to users of that page, so treat it as an app identifier rather than a private secret.

On each phone, open that app's Vercel URL in the browser and choose **Add to Home Screen** (iPhone: Safari share menu; Android: Chrome menu). The installed apps have different names and icons. The Vercel build requires `BUS_API_URL` so an app cannot silently point API calls at its own static site.

The root `vercel.json` is still available if you prefer one Vercel project with both apps under separate paths; use the two subdirectory projects above for separate app identities and URLs.
