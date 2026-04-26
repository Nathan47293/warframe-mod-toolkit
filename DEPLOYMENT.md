# Deployment Guide

The toolkit runs in two modes:

| Mode | When to use | What handles CORS |
|------|-------------|-------------------|
| **Local** | Offline dev, single-machine use | `server.py` (Python proxy) |
| **Hosted** | Bookmarkable URL, any device | Cloudflare Worker + GitHub Pages |

The HTML auto-detects which mode it's in based on `location.hostname`. You can run both at the same time.

## Hosted Setup (one-time, ~10 min)

### 1. Deploy the Cloudflare Worker

1. Sign up free at [dash.cloudflare.com](https://dash.cloudflare.com) (no card required for the Workers free plan).
2. Go to **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name (e.g., `wf-toolkit-proxy`). Note the URL it generates — it'll look like `https://wf-toolkit-proxy.<your-subdomain>.workers.dev`.
4. Click **Deploy**, then **Edit code**.
5. Replace the entire default `worker.js` content with the contents of `cloudflare-worker.js` from this repo.
6. Click **Deploy**.
7. Test the worker by visiting `https://wf-toolkit-proxy.<your-subdomain>.workers.dev/api/v2/items` — you should get a JSON response with the item catalog.

The worker whitelists only `/v2/items` and `/v1/items/<slug>/statistics`, so it can't be abused as a generic CORS proxy. Free tier covers 100k requests/day; the toolkit only fires ~300 per fetch, so quota is not a concern.

### 2. Wire the worker URL into the HTML

Open `warframe_toolkit.html` and find the `API_BASE` constant near the top of the `<script>` block. Replace `YOUR-SUBDOMAIN` with your Cloudflare subdomain:

```js
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? '/api'
  : 'https://wf-toolkit-proxy.your-actual-subdomain.workers.dev/api';
```

Commit and push the change.

### 3. Enable GitHub Pages

1. In your repo on GitHub, go to **Settings** → **Pages**.
2. Under **Source**, pick **Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`. Save.
4. Wait ~1 min for the deployment. Your URL will be `https://<username>.github.io/<repo-name>/`.
5. Visiting the bare URL serves `index.html`, which redirects to `warframe_toolkit.html`. Bookmark it.

### Updating after deploys

- HTML changes: just `git push` to `main` — GitHub Pages redeploys automatically (~1 min).
- Worker changes: edit `cloudflare-worker.js`, then paste it into Cloudflare's editor and click **Deploy**. (For more rigor, install `wrangler` and run `wrangler deploy` from the repo, but the dashboard editor is fine for a one-file worker.)

## Local Setup

If you've already been using this locally, nothing changes — `server.py` and `run_toolkit.bat` work exactly as before, and the HTML auto-routes through `/api/...` when it sees `localhost`.

```sh
python server.py
# or double-click run_toolkit.bat on Windows
```

## Troubleshooting

- **Hosted page loads but shows "No data" forever**: open browser DevTools → Console. If you see CORS errors, double-check the `API_BASE` URL in the HTML matches your worker's URL exactly.
- **Worker returns 403 Forbidden**: the path isn't whitelisted. The worker only allows `/api/v2/items` and `/api/v1/items/<slug>/statistics` — anything else is rejected. If you legitimately need another path, edit `STATS_RE`/`ITEMS_PATH` in `cloudflare-worker.js`.
- **Worker returns 502**: warframe.market is down or rate-limiting the worker. The HTML retries with exponential backoff (2s/4s/8s) on 429s, so transient hiccups self-recover.
- **GitHub Pages 404 at the bare URL**: make sure `index.html` exists in the repo root and Pages is configured to deploy from `main` branch root.
