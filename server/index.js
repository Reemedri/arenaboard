const WebSocket = require('ws')
const axios     = require('axios')
const express   = require('express')
const cors      = require('cors')
const fs        = require('fs')
const path      = require('path')
const { Pool }  = require('pg')
const { getTeamColors } = require('./teams')

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT || 3001
const MOCK_MODE = process.env.MOCK_MODE !== 'false'

// ─── Postgres ─────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
})

// ─── Run migrations on boot ───────────────────────────────────────────────────
async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL — skipping migrations (running without DB)')
    return
  }
  try {
    // ensure migrations table exists first
    await db.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id         serial PRIMARY KEY,
        filename   text UNIQUE NOT NULL,
        applied_at timestamptz DEFAULT now()
      )
    `)

    const migrationsDir = path.join(__dirname, '..', 'migrations')
    if (!fs.existsSync(migrationsDir)) {
      console.log('No migrations folder found — skipping')
      return
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const { rows } = await db.query(
        'SELECT id FROM migrations WHERE filename = $1', [file]
      )
      if (rows.length > 0) {
        console.log(`Migration already applied: ${file}`)
        continue
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      await db.query(sql)
      await db.query('INSERT INTO migrations (filename) VALUES ($1)', [file])
      console.log(`Migration applied: ${file}`)
    }
    console.log('All migrations up to date')
  } catch (err) {
    console.error('Migration error:', err.message)
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function getOrCreateDevice(uid) {
  if (!process.env.DATABASE_URL) return null
  try {
    // upsert device
    await db.query(`
      INSERT INTO devices (uid, activated_at)
      VALUES ($1, now())
      ON CONFLICT (uid) DO UPDATE SET last_heartbeat = now()
    `, [uid])
    const { rows } = await db.query('SELECT id FROM devices WHERE uid = $1', [uid])
    return rows[0]?.id || null
  } catch (err) {
    console.error('getOrCreateDevice error:', err.message)
    return null
  }
}

async function getConfig(uid) {
  if (!process.env.DATABASE_URL) return null
  try {
    const { rows } = await db.query(`
      SELECT dc.settings, dc.active_mode
      FROM device_configs dc
      JOIN devices d ON d.id = dc.device_id
      WHERE d.uid = $1
    `, [uid])
    return rows[0] || null
  } catch (err) {
    console.error('getConfig error:', err.message)
    return null
  }
}

async function saveConfig(uid, settings) {
  if (!process.env.DATABASE_URL) return
  try {
    const deviceId = await getOrCreateDevice(uid)
    if (!deviceId) return
    await db.query(`
      INSERT INTO device_configs (device_id, settings)
      VALUES ($1, $2)
      ON CONFLICT (device_id)
      DO UPDATE SET settings = $2, updated_at = now()
    `, [deviceId, JSON.stringify(settings)])
  } catch (err) {
    console.error('saveConfig error:', err.message)
  }
}

async function logEvent(uid, type, payload) {
  if (!process.env.DATABASE_URL) return
  try {
    const deviceId = await getOrCreateDevice(uid)
    await db.query(`
      INSERT INTO events (device_id, type, payload)
      VALUES ($1, $2, $3)
    `, [deviceId, type, JSON.stringify(payload)])
  } catch (err) {
    console.error('logEvent error:', err.message)
  }
}

// ─── In-memory state (fallback when no DB) ────────────────────────────────────
const deviceConfigs = {}
let lastState = {}

// ─── Mock game ────────────────────────────────────────────────────────────────
const mockState = {
  id: '401234567', status: 'STATUS_IN_PROGRESS',
  period: 1, home_team: 'WAS', home_score: 0,
  away_team: 'LAL', away_score: 0,
  clockMinutes: 12, clockSeconds: 0,
}

function tickMock() {
  mockState.clockSeconds--
  if (mockState.clockSeconds < 0) { mockState.clockSeconds = 59; mockState.clockMinutes-- }
  if (mockState.clockMinutes < 0) {
    mockState.period++
    if (mockState.period > 4) {
      mockState.period = 4; mockState.clockMinutes = 0
      mockState.clockSeconds = 0; mockState.status = 'STATUS_FINAL'
    } else { mockState.clockMinutes = 11; mockState.clockSeconds = 59 }
  }
  if (Math.random() > 0.95) mockState.home_score += Math.random() > 0.5 ? 2 : 3
  if (Math.random() > 0.96) mockState.away_score += Math.random() > 0.5 ? 2 : 3
}

// ─── ESPN ─────────────────────────────────────────────────────────────────────
async function fetchNBA() {
  const res = await axios.get(
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
  )
  return res.data.events || []
}

function parseGame(event) {
  const comp = event.competitions[0]
  const home = comp.competitors.find(t => t.homeAway === 'home')
  const away = comp.competitors.find(t => t.homeAway === 'away')
  return {
    id: event.id, status: event.status.type.name,
    clock: event.status.displayClock, period: event.status.period,
    home_team: home.team.abbreviation, home_score: parseInt(home.score || 0),
    away_team: away.team.abbreviation, away_score: parseInt(away.score || 0),
  }
}

// ─── Diff engine ──────────────────────────────────────────────────────────────
function getDiff(newState, oldState) {
  const diff = {}
  for (const key in newState) {
    if (newState[key] !== oldState[key]) diff[key] = newState[key]
  }
  return Object.keys(diff).length > 0 ? diff : null
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => res.json({
  service: 'ArenaBoard Server', version: '3.0',
  mock: MOCK_MODE, db: !!process.env.DATABASE_URL,
  clients: wss?.clients?.size || 0
}))

app.get('/health', (req, res) => res.json({ ok: true }))

app.get('/ota/check', (req, res) => {
  const latest = '1.0.0'
  const current = req.query.firmware_version || '0.0.0'
  res.json({ current, latest, update_available: current !== latest,
    url: current !== latest ? `${req.protocol}://${req.get('host')}/ota/firmware.bin` : null })
})

// GET config for a device
app.get('/api/device/:uid/config', async (req, res) => {
  const { uid } = req.params
  const saved = await getConfig(uid)
  const defaults = { brightness: 80, team: 'LAL', animation_pack: 'default',
    mode: 'sport_live', color_theme: 'team' }
  const settings = saved ? { ...defaults, ...saved.settings } : defaults
  res.json({ uid, settings, active_mode: saved?.active_mode || 'sport_live' })
  logEvent(uid, 'config.read', { uid })
})

// PATCH config for a device
app.patch('/api/device/:uid/config', async (req, res) => {
  const { uid } = req.params
  const saved = await getConfig(uid)
  const current = saved?.settings || {}
  const updated = { ...current, ...req.body }
  await saveConfig(uid, updated)
  // in-memory fallback
  deviceConfigs[uid] = updated
  const diff = getDiff(updated, current)
  if (diff) broadcastToDevice(uid, { type: 'CONFIG_UPDATE', data: diff })
  logEvent(uid, 'config.update', { diff })
  res.json({ ok: true, settings: updated })
})

// POST trigger (test events from PWA)
app.post('/api/device/:uid/trigger', (req, res) => {
  const { uid } = req.params
  const { reason = 'THREE', team = 'home' } = req.body
  const teamName = team === 'home' ? lastState.home_team : lastState.away_team
  const colors = getTeamColors(teamName || 'LAL')
  broadcastToDevice(uid, { type: 'SCORE_EVENT', team, colors, reason })
  logEvent(uid, 'trigger.manual', { reason, team })
  res.json({ ok: true, triggered: reason })
})

// ─── HTTP server (shared with WebSocket) ─────────────────────────────────────
const server = require('http').createServer(app)
const wss    = new WebSocket.Server({ server })

// ─── Broadcast helpers ────────────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg)
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data) })
}

function broadcastToDevice(uid, msg) {
  // for now broadcast to all — Phase 3 will scope by device uid
  broadcast(msg)
}

// ─── Score engine ─────────────────────────────────────────────────────────────
function checkAndBroadcast(game, diff) {
  if (!diff) return
  const prevHome = lastState.home_score || 0
  const prevAway = lastState.away_score || 0
  const homeDiff = game.home_score - game.away_score
  const prevDiff = prevHome - prevAway
  const leadChanged = (homeDiff > 0 && prevDiff <= 0) || (homeDiff < 0 && prevDiff >= 0)
  const isThree =
    (diff.home_score !== undefined && game.home_score - prevHome === 3) ||
    (diff.away_score !== undefined && game.away_score - prevAway === 3)
  const clutch = game.period === 4 && Math.abs(homeDiff) <= 5

  if (leadChanged || isThree || clutch) {
    const scoringTeam = diff.home_score !== undefined ? game.home_team : game.away_team
    const colors = getTeamColors(scoringTeam)
    broadcast({ type: 'SCORE_EVENT',
      team: diff.home_score !== undefined ? 'home' : 'away',
      colors, reason: leadChanged ? 'LEAD_CHANGE' : isThree ? 'THREE' : 'CLUTCH' })
    logEvent('global', 'score.event', { reason: leadChanged ? 'LEAD_CHANGE' : isThree ? 'THREE' : 'CLUTCH', game })
  }
  if (!lastState.home_team) {
    diff.home_color = getTeamColors(game.home_team).secondary
    diff.away_color = getTeamColors(game.away_team).secondary
  }
  lastState = { ...game }
  broadcast({ type: 'SCORE_UPDATE', data: diff })
}

function processMockTick() {
  tickMock()
  const game = {
    id: mockState.id, status: mockState.status,
    clock: `${mockState.clockMinutes}:${String(mockState.clockSeconds).padStart(2, '0')}`,
    period: mockState.period, home_team: mockState.home_team,
    home_score: mockState.home_score, away_team: mockState.away_team,
    away_score: mockState.away_score,
  }
  const diff = getDiff(game, lastState)
  if (diff) checkAndBroadcast(game, diff)
}

async function pollESPN() {
  try {
    const events = await fetchNBA()
    const live = events.filter(e => e.status.type.name === 'STATUS_IN_PROGRESS')
    if (!live.length) { console.log('No live games'); return }
    const game = parseGame(live[0])
    const diff = getDiff(game, lastState)
    if (diff) checkAndBroadcast(game, diff)
  } catch (err) { console.error('Poll error:', err.message) }
}

// ─── WebSocket connections ────────────────────────────────────────────────────
wss.on('connection', async (ws, req) => {
  const uid = new URL(req.url, 'http://x').searchParams.get('uid') || 'unknown'
  console.log(`Board connected: ${uid} — total: ${wss.clients.size}`)
  await getOrCreateDevice(uid)
  logEvent(uid, 'device.connect', { uid })

  if (Object.keys(lastState).length > 0) {
    ws.send(JSON.stringify({ type: 'FULL_STATE', data: {
      ...lastState,
      home_color: getTeamColors(lastState.home_team).secondary,
      away_color: getTeamColors(lastState.away_team).secondary,
    }}))
  }

  // send saved config if any
  const saved = await getConfig(uid)
  if (saved) ws.send(JSON.stringify({ type: 'CONFIG_UPDATE', data: saved.settings }))

  ws.on('close', () => {
    logEvent(uid, 'device.disconnect', { uid })
    console.log(`Board disconnected: ${uid} — total: ${wss.clients.size}`)
  })
})

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await runMigrations()
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ArenaBoard server v3.0 running on port ${PORT}`)
    console.log(`DB: ${process.env.DATABASE_URL ? 'connected' : 'none (memory only)'}`)
    console.log(`Mode: ${MOCK_MODE ? 'MOCK' : 'ESPN live'}`)
  })
  if (MOCK_MODE) { setInterval(processMockTick, 1000); processMockTick() }
  else           { setInterval(pollESPN, 3000); pollESPN() }
}

boot()
