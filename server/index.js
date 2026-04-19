// ArenaBoard Server v2 — WebSocket + REST API for PWA config
// --------------------------------------------------------------
// PIPELINE (matches production ESP32 flow):
//   PWA → POST /api/device/:uid/config → server stores + broadcasts
//   Server → WebSocket CONFIG_UPDATE → all boards bound to that device
//   Board → receives diff → updates local state → re-renders
//
// No direct PWA↔Board communication. When ESP32 replaces virtual-board,
// the pipeline is identical — no client code changes.
// --------------------------------------------------------------

const http = require('http')
const express = require('express')
const WebSocket = require('ws')
const axios = require('axios')
const { getTeamColors, TEAM_COLORS } = require('./teams')

const PORT = parseInt(process.env.PORT || '3001', 10)
const PROTOCOL_VERSION = 1

// MOCK_MODE controls the fallback mock game. Even when true, we still fetch
// ESPN in the background so the Game tab shows real live games.
// Override via env: MOCK_MODE=false to disable mock and only use live ESPN data
const MOCK_MODE = process.env.MOCK_MODE !== 'false'

// ─── Express app + HTTP server ──────────────────────────────
const app = express()
app.use(express.json())
// permissive CORS for dev — tighten for production
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

// ─── In-memory "DB" — replace with Postgres + Redis in Phase 3 ──
// devices: uid → { config, last_heartbeat, firmware_version, active_game_id }
const devices = new Map()
// game state PER DEVICE (each device can follow a different game)
const gameStateByDevice = new Map()
// list of all current games from ESPN (refreshed every few seconds)
let allGames = []
let lastEspnFetch = 0

// Default device config — applied when a board first connects with new UID
const DEFAULT_CONFIG = {
  favorite_team: 'LAL',
  favorite_player: null,        // e.g. 'LeBron James'
  brightness: 80,               // 0-100
  animation_pack: 'confetti',   // 'confetti' | 'fireworks' | 'flash' | 'minimal'
  theme: 'classic',             // 'classic' | 'neon' | 'retro'
  accent_color: '#FDB927',      // user-chosen override (null = use team color)
  show_shot_clock: true,
  show_ticker: true,
  clock_color: '#ff5500',
}

function getDevice(uid) {
  if (!devices.has(uid)) {
    devices.set(uid, {
      uid,
      config: { ...DEFAULT_CONFIG },
      firmware_version: '1.0.0',
      last_heartbeat: Date.now(),
      created_at: Date.now(),
      active_game_id: null,  // null = follow mock / first live game
    })
    console.log(`[device] registered new UID=${uid}`)
  }
  return devices.get(uid)
}

// ─── REST API for PWA ──────────────────────────────────────

// GET full device config (PWA loads this on open)
app.get('/api/device/:uid/config', (req, res) => {
  const dev = getDevice(req.params.uid)
  res.json({
    uid: dev.uid,
    config: dev.config,
    firmware_version: dev.firmware_version,
    online: Date.now() - dev.last_heartbeat < 90_000,
  })
})

// PATCH config — only changed fields. Diff Engine applies here too.
app.patch('/api/device/:uid/config', (req, res) => {
  const dev = getDevice(req.params.uid)
  const incoming = req.body || {}
  const diff = {}

  for (const key in incoming) {
    if (!(key in DEFAULT_CONFIG)) continue  // ignore unknown keys
    if (dev.config[key] !== incoming[key]) {
      dev.config[key] = incoming[key]
      diff[key] = incoming[key]
    }
  }

  if (Object.keys(diff).length === 0) {
    return res.json({ ok: true, changed: 0 })
  }

  // broadcast CONFIG_UPDATE only to boards bound to this device
  broadcastToDevice(req.params.uid, {
    v: PROTOCOL_VERSION,
    type: 'CONFIG_UPDATE',
    data: diff,
  })

  console.log(`[config] ${req.params.uid}`, diff)
  res.json({ ok: true, changed: Object.keys(diff).length, diff })
})

// OTA check (from roadmap — Phase 1 ready)
app.get('/ota/check', (req, res) => {
  const { device_id, firmware_version } = req.query
  const latest = '1.0.0'
  if (firmware_version !== latest) {
    res.json({
      update_available: true,
      version: latest,
      url: 'https://yourserver.com/firmware/v1.0.0.bin',
    })
  } else {
    res.json({ update_available: false })
  }
})

// Fire a test event from PWA — broadcasts to all boards of that device
app.post('/api/device/:uid/trigger', (req, res) => {
  const { reason, team, accent_color } = req.body || {}
  if (!reason) return res.status(400).json({ error: 'missing reason' })
  const uid = req.params.uid
  const dev = getDevice(uid)
  const color = accent_color || dev.config.accent_color || '#ffffff'

  broadcastToDevice(uid, {
    v: PROTOCOL_VERSION,
    type: 'SCORE_EVENT',
    team: team || 'home',
    reason,
    colors: { primary: color, secondary: '#ffffff' },
    _source: 'pwa_test',
  })
  console.log(`[trigger] ${uid} reason=${reason} team=${team||'home'}`)
  res.json({ ok: true })
})

// List all games (live + upcoming + final) — used by PWA Game tab
app.get('/api/games', (req, res) => {
  res.json({
    games: allGames,
    updated_at: lastEspnFetch,
    mock_active: MOCK_MODE && allGames.length === 0,
  })
})

// Set which game a device follows
app.post('/api/device/:uid/active-game', (req, res) => {
  const uid = req.params.uid
  const dev = getDevice(uid)
  const { game_id } = req.body || {}
  dev.active_game_id = game_id || null
  console.log(`[active-game] ${uid} → ${game_id || 'auto'}`)

  // Reset game state for this device so next tick pushes full state
  gameStateByDevice.delete(uid)

  // Immediately push FULL_STATE of the new game
  const game = pickGameForDevice(dev)
  if (game) {
    const fullState = {
      ...game,
      home_color: getTeamColors(game.home_team).secondary,
      away_color: getTeamColors(game.away_team).secondary,
    }
    broadcastToDevice(uid, { v: PROTOCOL_VERSION, type: 'FULL_STATE', data: fullState })
    gameStateByDevice.set(uid, { ...game })
  }

  res.json({ ok: true, active_game_id: dev.active_game_id })
})

// Device heartbeat (ESP32 will POST this every 30s)
app.post('/api/device/:uid/heartbeat', (req, res) => {
  const dev = getDevice(req.params.uid)
  dev.last_heartbeat = Date.now()
  if (req.body?.firmware_version) dev.firmware_version = req.body.firmware_version
  res.json({ ok: true, server_time: Date.now() })
})

// Service info / root — used by Railway healthcheck and to verify deploy
app.get('/', (req, res) => {
  res.json({
    service: 'ArenaBoard Server',
    version: '2.1.0',
    protocol: PROTOCOL_VERSION,
    status: 'ok',
    endpoints: {
      health: '/health',
      device_config: '/api/device/:uid/config',
      games: '/api/games',
      ws: 'wss://<this-host>/?uid=DEVICE_UID&role=board|pwa',
    },
  })
})

// Health check
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    devices: devices.size,
    clients: wss.clients.size,
    protocol: PROTOCOL_VERSION,
  })
})

// ─── Mock game engine ──────────────────────────────────────
// Used as fallback when no ESPN games are available, or when device has no
// active_game_id set.
const mockState = {
  id: 'mock-game-001',
  status: 'STATUS_IN_PROGRESS',
  period: 1,
  home_team: 'WAS',
  home_score: 0,
  away_team: 'LAL',
  away_score: 0,
  clockMinutes: 12,
  clockSeconds: 0,
  shot_clock: 24,
  home_team_full: 'Washington Wizards',
  away_team_full: 'Los Angeles Lakers',
}

function tickMock() {
  mockState.clockSeconds--
  mockState.shot_clock--
  if (mockState.shot_clock < 0) mockState.shot_clock = 24
  if (mockState.clockSeconds < 0) {
    mockState.clockSeconds = 59
    mockState.clockMinutes--
  }
  if (mockState.clockMinutes < 0) {
    mockState.period++
    if (mockState.period > 4) {
      mockState.period = 4
      mockState.clockMinutes = 0
      mockState.clockSeconds = 0
      mockState.status = 'STATUS_FINAL'
    } else {
      mockState.clockMinutes = 11
      mockState.clockSeconds = 59
    }
  }
  if (Math.random() > 0.95) mockState.home_score += Math.random() > 0.5 ? 2 : 3
  if (Math.random() > 0.96) mockState.away_score += Math.random() > 0.5 ? 2 : 3
}

function getMockGame() {
  return {
    id: mockState.id,
    status: mockState.status,
    clock: `${mockState.clockMinutes}:${String(mockState.clockSeconds).padStart(2, '0')}`,
    period: mockState.period,
    home_team: mockState.home_team,
    home_score: mockState.home_score,
    away_team: mockState.away_team,
    away_score: mockState.away_score,
    shot_clock: mockState.shot_clock,
    home_team_full: mockState.home_team_full,
    away_team_full: mockState.away_team_full,
    is_mock: true,
  }
}

// ─── ESPN API integration ──────────────────────────────────
async function fetchNBA() {
  const res = await axios.get(
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (ArenaBoard/1.0)',
        'Accept': 'application/json',
      },
    }
  )
  return res.data.events || []
}

function parseGame(event) {
  const comp = event.competitions[0]
  const home = comp.competitors.find(t => t.homeAway === 'home')
  const away = comp.competitors.find(t => t.homeAway === 'away')
  const statusName = event.status.type.name
  return {
    id: event.id,
    status: statusName,
    status_detail: event.status.type.shortDetail || '',
    clock: event.status.displayClock || '0:00',
    period: event.status.period || 0,
    home_team: home.team.abbreviation,
    home_team_full: home.team.displayName,
    home_score: parseInt(home.score || 0),
    away_team: away.team.abbreviation,
    away_team_full: away.team.displayName,
    away_score: parseInt(away.score || 0),
    shot_clock: 24, // ESPN doesn't expose this — placeholder
    is_live: statusName === 'STATUS_IN_PROGRESS' || statusName === 'STATUS_HALFTIME',
    is_final: statusName === 'STATUS_FINAL',
    scheduled: event.date,
    is_mock: false,
  }
}

async function pollESPN() {
  try {
    const events = await fetchNBA()
    allGames = events.map(parseGame)
    lastEspnFetch = Date.now()
    const live = allGames.filter(g => g.is_live).length
    console.log(`[espn] fetched ${allGames.length} games (${live} live)`)
  } catch (err) {
    console.error('[espn] poll error:', err.message)
    // keep previous allGames on error — don't blank out the list
  }
}

// ─── Game selection per device ─────────────────────────────
// Decide which game a device should display.
// Priority:
//  1. Explicit active_game_id set by PWA
//  2. First live game featuring device's favorite_team
//  3. First live game overall
//  4. Mock game (if MOCK_MODE and no live games)
function pickGameForDevice(dev) {
  if (dev.active_game_id) {
    const g = allGames.find(x => x.id === dev.active_game_id)
    if (g) return g
  }
  const fav = dev.config.favorite_team
  const live = allGames.filter(g => g.is_live)
  if (fav) {
    const favGame = live.find(g => g.home_team === fav || g.away_team === fav)
    if (favGame) return favGame
  }
  if (live.length > 0) return live[0]
  if (MOCK_MODE) return getMockGame()
  return null
}

function getDiff(newState, oldState) {
  const diff = {}
  for (const key in newState) {
    if (newState[key] !== oldState[key]) diff[key] = newState[key]
  }
  return Object.keys(diff).length > 0 ? diff : null
}

// Broadcast to all clients bound to a specific device UID
function broadcastToDevice(uid, msg) {
  const data = JSON.stringify(msg)
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.device_uid === uid) {
      client.send(data)
    }
  })
}

// Event detection — runs per device since each device has its own game
function detectEvents(uid, game, diff) {
  const dev = devices.get(uid)
  const prev = gameStateByDevice.get(uid) || {}
  const prevHomeScore = prev.home_score || 0
  const prevAwayScore = prev.away_score || 0
  const homeDiff = game.home_score - game.away_score
  const prevHomeDiff = prevHomeScore - prevAwayScore

  const leadChanged = prev.home_score !== undefined && (
    (homeDiff > 0 && prevHomeDiff <= 0) ||
    (homeDiff < 0 && prevHomeDiff >= 0)
  )
  const isThree =
    (diff.home_score !== undefined && game.home_score - prevHomeScore === 3) ||
    (diff.away_score !== undefined && game.away_score - prevAwayScore === 3)
  const clutch = game.period === 4 && Math.abs(homeDiff) <= 5 &&
    (diff.home_score !== undefined || diff.away_score !== undefined)

  if (leadChanged || isThree || clutch) {
    const scoringTeam = diff.home_score !== undefined ? game.home_team : game.away_team
    const colors = getTeamColors(scoringTeam)
    broadcastToDevice(uid, {
      v: PROTOCOL_VERSION,
      type: 'SCORE_EVENT',
      team: diff.home_score !== undefined ? 'home' : 'away',
      colors,
      reason: leadChanged ? 'LEAD_CHANGE' : isThree ? 'THREE' : 'CLUTCH',
    })
    console.log(`[event] ${uid} ${leadChanged ? 'LEAD_CHANGE' : isThree ? 'THREE' : 'CLUTCH'}`)
  }
}

// Main tick: for each device, figure out its game and push diffs
function tickAllDevices() {
  // advance the mock clock once per tick
  tickMock()

  for (const [uid, dev] of devices) {
    const game = pickGameForDevice(dev)
    if (!game) continue

    const prev = gameStateByDevice.get(uid) || {}
    const diff = getDiff(game, prev)

    if (!diff) continue

    // On first tick for this device or game change: send colors too
    if (!prev.home_team || prev.id !== game.id) {
      diff.home_color = getTeamColors(game.home_team).secondary
      diff.away_color = getTeamColors(game.away_team).secondary
    }

    detectEvents(uid, game, diff)
    gameStateByDevice.set(uid, { ...game })
    broadcastToDevice(uid, { v: PROTOCOL_VERSION, type: 'SCORE_UPDATE', data: diff })
  }
}

// ─── WebSocket connection handling ─────────────────────────
wss.on('connection', (ws, req) => {
  // PWA passes ?uid=xxx&role=pwa   Board passes ?uid=xxx&role=board
  const url = new URL(req.url, `http://${req.headers.host}`)
  const uid = url.searchParams.get('uid') || 'demo-device-001'
  const role = url.searchParams.get('role') || 'board'
  ws.device_uid = uid
  ws.role = role
  const dev = getDevice(uid)

  console.log(`[ws] ${role} connected uid=${uid} total=${wss.clients.size}`)

  // Send current game state for this device + config
  const game = pickGameForDevice(dev)
  if (game) {
    const fullState = {
      ...game,
      home_color: getTeamColors(game.home_team).secondary,
      away_color: getTeamColors(game.away_team).secondary,
    }
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'FULL_STATE', data: fullState }))
    gameStateByDevice.set(uid, { ...game })
  }
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'CONFIG_FULL', data: dev.config }))

  ws.on('close', () => {
    console.log(`[ws] ${role} disconnected uid=${uid} total=${wss.clients.size}`)
  })
})

// ─── Boot ──────────────────────────────────────────────────
// ESPN poll runs in background regardless of MOCK_MODE —
// the PWA needs real game list even when falling back to mock.
setInterval(pollESPN, 15000)
pollESPN()

// Main game tick — drives all devices
setInterval(tickAllDevices, 1000)

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ArenaBoard server v2 running`)
  console.log(`  Port:      ${PORT}`)
  console.log(`  Protocol:  v${PROTOCOL_VERSION}`)
  console.log(`  Mode:      ${MOCK_MODE ? 'MOCK fallback' : 'LIVE ESPN only'}`)
})
