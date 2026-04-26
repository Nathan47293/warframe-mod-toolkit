# Deployment Guide

The toolkit is hosted on GitHub Pages with a Cloudflare Worker handling the warframe.market CORS proxy. This doc covers the one-time setup and how to update either piece later.

## Architecture

```
Browser ──> GitHub Pages (index.html, static)
              │
              └── fetch(API_BASE + ...) ──> Cloudflare Worker ──> api.warframe.market
                                            (whitelist + cache)
```

- `index.html` — the entire app, served as a static file from GitHub Pages
- `cloudflare-worker.js` — source for the Worker (paste this into the Cloudflare dashboard)
- `API_BASE` constant in `index.html` — points at the Worker URL

## One-Time Setup

### 1. Deploy the Cloudflare Worker

1. Sign up free at [dash.cloudflare.com](https://dash.cloudflare.com) (no card required for the Workers free plan).
2. **Workers & Pages** → **Create application** → **Create Worker**.
3. From the "Select a method" screen, pick **Hello World** (the upload-and-deploy method does NOT support ES module syntax).
4. Set the worker name (e.g., `wf-toolkit-proxy`) and deploy.
5. Click **Edit code** on the worker's page.
6. Delete the default code and paste in the contents of `cloudflare-worker.js` from this repo.
7. Click **Deploy**.
8. Verify by visiting `https://<worker-name>.<your-subdomain>.workers.dev/api/v2/items` — you should see a wall of JSON (the full warframe.market item catalog).

The worker whitelists only `/v2/items` and `/v1/items/<slug>/statistics`, so it can't be abused as a generic CORS proxy. Free tier covers 100k requests/day; the toolkit only fires ~300 per fetch, so quota is not a concern.

### 2. Wire the worker URL into the HTML

Open `index.html` and find the `API_BASE` constant near the top of the `<script>` block. Set it to your worker URL:

```js
const API_BASE = 'https://wf-toolkit-proxy.your-subdomain.workers.dev/api';
```

Commit and push the change.

### 3. Enable GitHub Pages

1. In your repo on GitHub, go to **Settings** → **Pages**.
2. Under **Source**, pick **Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.
4. Wait ~1 min for the deployment. Your URL will be `https://<username>.github.io/<repo-name>/`.
5. Bookmark it.

## Updating

- **HTML changes**: edit `index.html`, commit, `git push`. GitHub Pages redeploys automatically (~1 min).
- **Worker changes**: edit `cloudflare-worker.js`, commit it for source-of-truth tracking, then paste the new contents into the Cloudflare dashboard editor and click **Deploy**. (For more rigor, install `wrangler` and run `wrangler deploy`, but the dashboard editor is fine for a one-file worker.)

## Troubleshooting

- **Page loads but shows "No data" forever**: open DevTools → Console. CORS errors mean `API_BASE` doesn't match your worker URL. `Forbidden path` means the worker is rejecting the path — check `STATS_RE` / `ITEMS_PATH` in `cloudflare-worker.js`.
- **Worker returns 502**: warframe.market is down or rate-limiting. The HTML retries with exponential backoff (2s/4s/8s) on 429s.
- **GitHub Pages 404 at the bare URL**: make sure `index.html` exists in the repo root and Pages is configured to deploy from `main` branch root.
