# ArenaBoard AI

IoT RGB LED scoreboard with live NBA data.
Phase 1 — cloud-deployed virtual board + PWA, ready for ESP32 swap.

## Architecture

```
┌──────────┐   HTTP/REST    ┌──────────┐   WebSocket    ┌──────────┐
│   PWA    │ ─────────────▶ │  Server  │ ─────────────▶ │  Board   │
│ (mobile) │                │ (Railway)│                │ (browser │
└──────────┘                └──────────┘                │ / ESP32) │
                                 │                      └──────────┘
                                 ▼
                            ┌──────────┐
                            │ ESPN API │
                            └──────────┘
```

Three independently deployable pieces:
- `server/` — Node.js WebSocket + REST → **Railway**
- `pwa/` — static HTML phone mockup → **Vercel**
- `virtual-board/` — static HTML LED board → **Vercel**

When ESP32 firmware replaces `virtual-board/`, no other code changes.

## Local development

```bash
npm install
npm start
```

Then open in browser:
- `pwa/index.html` — the phone app
- `virtual-board/index.html` — the virtual LED board

Both default to `http://localhost:3001` (see `pwa/config.js` and `virtual-board/config.js`).

## Production deploy

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/USERNAME/arenaboard.git
git branch -M main
git push -u origin main
```

### Step 2 — Deploy server to Railway

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select your `arenaboard` repo
3. Railway auto-detects Node.js and runs `npm install && npm start`
4. After deploy, click the service → Settings → Networking → **Generate Domain**
5. Copy the URL (e.g. `arenaboard-production.up.railway.app`)
6. Verify: `https://YOUR-URL/health` should return JSON

### Step 3 — Update config.js × 2 with Railway URL

Edit both `pwa/config.js` and `virtual-board/config.js`:

```js
window.ARENABOARD_CONFIG = {
  SERVER: 'https://arenaboard-production.up.railway.app',
  WS_PROTOCOL: 'wss',
}
```

Commit and push:
```bash
git add pwa/config.js virtual-board/config.js
git commit -m "Point frontends at Railway"
git push
```

### Step 4 — Deploy PWA to Vercel

1. Go to https://vercel.com → Add New → Project
2. Import your `arenaboard` repo
3. **Root Directory:** `pwa`
4. Framework: Other
5. Deploy → URL like `arenaboard-pwa.vercel.app`

### Step 5 — Deploy virtual-board to Vercel (separate project)

1. Vercel → Add New → Project → Import same repo
2. **Root Directory:** `virtual-board`
3. Project name: `arenaboard-board`
4. Deploy

### Step 6 — Test end-to-end

Three URLs now live:
- Server: `https://arenaboard-production.up.railway.app/health`
- PWA: `https://arenaboard-pwa.vercel.app`
- Board: `https://arenaboard-board.vercel.app`

Open PWA on phone + board on laptop. Toggle brightness in PWA → board responds in real time.

## How auto-deploy works

After setup, any `git push` to `main` triggers:
- Railway rebuilds server (~1 min)
- Vercel rebuilds PWA + board (~20 sec each)

No manual deploys needed.

## Environment variables (Railway)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | auto | Set by Railway |
| `MOCK_MODE` | `true` | `false` = live ESPN only |

## REST endpoints

- `GET  /` — service info (Railway healthcheck)
- `GET  /health` — detailed status
- `GET  /api/device/:uid/config` — fetch config
- `PATCH /api/device/:uid/config` — update config
- `POST /api/device/:uid/trigger` — fire test event
- `GET  /api/games` — list current games
- `POST /api/device/:uid/active-game` — set which game device follows
- `POST /api/device/:uid/heartbeat` — ESP32 heartbeat
- `GET  /ota/check` — firmware version check

## Protocol (v1)

All WebSocket messages carry `v: 1`.
- `FULL_STATE` — initial game state on connect
- `SCORE_UPDATE` — diff of changed game fields
- `SCORE_EVENT` — lead change / 3PT / clutch / buzzer
- `CONFIG_FULL` — initial device config on connect
- `CONFIG_UPDATE` — diff of config changes

## Next phases

- **Phase 2:** Postgres — persist device configs across restarts
- **Phase 3:** Auth — user accounts, scoped device access
- **Phase 4:** Real OTA — firmware binaries + staged rollout
- **Phase 5:** ESP32-S3 firmware
