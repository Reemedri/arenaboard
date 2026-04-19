const WebSocket  = require('ws')
const axios      = require('axios')
const express    = require('express')
const cors       = require('cors')
const fs         = require('fs')
const path       = require('path')
const { Pool }   = require('pg')
const bcrypt     = require('bcrypt')
const jwt        = require('jsonwebtoken')
const crypto     = require('crypto')
const { getTeamColors } = require('./teams')

const PORT       = process.env.PORT || 3001
const MOCK_MODE  = process.env.MOCK_MODE !== 'false'
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production'
const BCRYPT_ROUNDS = 12

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
})

async function runMigrations() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL — skipping migrations'); return }
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS migrations (id serial PRIMARY KEY, filename text UNIQUE NOT NULL, applied_at timestamptz DEFAULT now())`)
    const migrationsDir = path.join(__dirname, '..', 'migrations')
    if (!fs.existsSync(migrationsDir)) { console.log('No migrations folder'); return }
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const { rows } = await db.query('SELECT id FROM migrations WHERE filename = $1', [file])
      if (rows.length > 0) { console.log(`Already applied: ${file}`); continue }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      await db.query(sql)
      await db.query('INSERT INTO migrations (filename) VALUES ($1)', [file])
      console.log(`Migration applied: ${file}`)
    }
    console.log('All migrations up to date')
  } catch (err) { console.error('Migration error:', err.message) }
}

async function getOrCreateDevice(uid) {
  if (!process.env.DATABASE_URL) return null
  try {
    await db.query(`INSERT INTO devices (uid, activated_at) VALUES ($1, now()) ON CONFLICT (uid) DO UPDATE SET last_heartbeat = now()`, [uid])
    const { rows } = await db.query('SELECT id FROM devices WHERE uid = $1', [uid])
    return rows[0]?.id || null
  } catch (err) { console.error('getOrCreateDevice:', err.message); return null }
}

async function getConfig(uid) {
  if (!process.env.DATABASE_URL) return null
  try {
    const { rows } = await db.query(`SELECT dc.settings, dc.active_mode FROM device_configs dc JOIN devices d ON d.id = dc.device_id WHERE d.uid = $1`, [uid])
    return rows[0] || null
  } catch (err) { console.error('getConfig:', err.message); return null }
}

async function saveConfig(uid, settings) {
  if (!process.env.DATABASE_URL) return
  try {
    const deviceId = await getOrCreateDevice(uid)
    if (!deviceId) return
    await db.query(`INSERT INTO device_configs (device_id, settings) VALUES ($1, $2) ON CONFLICT (device_id) DO UPDATE SET settings = $2, updated_at = now()`, [deviceId, JSON.stringify(settings)])
  } catch (err) { console.error('saveConfig:', err.message) }
}

async function logEvent(uid, type, payload) {
  if (!process.env.DATABASE_URL) return
  try {
    const deviceId = uid !== 'global' ? await getOrCreateDevice(uid) : null
    await db.query(`INSERT INTO events (device_id, type, payload) VALUES ($1, $2, $3)`, [deviceId, type, JSON.stringify(payload)])
  } catch (err) { console.error('logEvent:', err.message) }
}

function generateAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '1h' })
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex')
}

async function saveRefreshToken(userId, token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [userId, hash, expires])
}

async function deleteRefreshToken(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash])
}

async function findRefreshToken(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  const { rows } = await db.query(`SELECT rt.*, u.id as uid, u.email, u.role FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1 AND rt.expires_at > now()`, [hash])
  return rows[0] || null
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } })
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET)
    next()
  } catch (err) {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Token invalid or expired' } })
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin only' } })
  next()
}

const deviceConfigs = {}
let lastState = {}

const mockState = {
  id: '401234567', status: 'STATUS_IN_PROGRESS', period: 1,
  home_team: 'WAS', home_score: 0, away_team: 'LAL', away_score: 0,
  clockMinutes: 12, clockSeconds: 0,
}

function tickMock() {
  mockState.clockSeconds--
  if (mockState.clockSeconds < 0) { mockState.clockSeconds = 59; mockState.clockMinutes-- }
  if (mockState.clockMinutes < 0) {
    mockState.period++
    if (mockState.period > 4) { mockState.period = 4; mockState.clockMinutes = 0; mockState.clockSeconds = 0; mockState.status = 'STATUS_FINAL' }
    else { mockState.clockMinutes = 11; mockState.clockSeconds = 59 }
  }
  if (Math.random() > 0.95) mockState.home_score += Math.random() > 0.5 ? 2 : 3
  if (Math.random() > 0.96) mockState.away_score += Math.random() > 0.5 ? 2 : 3
}

async function fetchNBA() {
  const res = await axios.get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard')
  return res.data.events || []
}

function parseGame(event) {
  const comp = event.competitions[0]
  const home = comp.competitors.find(t => t.homeAway === 'home')
  const away = comp.competitors.find(t => t.homeAway === 'away')
  return { id: event.id, status: event.status.type.name, clock: event.status.displayClock, period: event.status.period, home_team: home.team.abbreviation, home_score: parseInt(home.score || 0), away_team: away.team.abbreviation, away_score: parseInt(away.score || 0) }
}

function getDiff(newState, oldState) {
  const diff = {}
  for (const key in newState) { if (newState[key] !== oldState[key]) diff[key] = newState[key] }
  return Object.keys(diff).length > 0 ? diff : null
}

const app = express()
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => res.json({ service: 'ArenaBoard Server', version: '3.1', mock: MOCK_MODE, db: !!process.env.DATABASE_URL, clients: wss?.clients?.size || 0 }))
app.get('/health', (req, res) => res.json({ ok: true }))
app.get('/ota/check', (req, res) => {
  const latest = '1.0.0'; const current = req.query.firmware_version || '0.0.0'
  res.json({ current, latest, update_available: current !== latest, url: current !== latest ? `${req.protocol}://${req.get('host')}/ota/firmware.bin` : null })
})

app.post('/api/v1/auth/signup', async (req, res) => {
  try {
    const { email, password, display_name } = req.body
    if (!email || !password) return res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'Email and password required' } })
    if (password.length < 8) return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' } })
    const { rows: existing } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    if (existing.length > 0) return res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'Email already registered' } })
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const { rows } = await db.query(`INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'user') RETURNING id, email, display_name, role, created_at`, [email.toLowerCase(), password_hash, display_name || null])
    const user = rows[0]
    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken()
    await saveRefreshToken(user.id, refreshToken)
    await logEvent('global', 'user.signup', { user_id: user.id })
    res.status(201).json({ token: accessToken, refresh_token: refreshToken, user })
  } catch (err) { console.error('Signup:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Signup failed' } }) }
})

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'Email and password required' } })
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email.toLowerCase()])
    const user = rows[0]
    if (!user || !user.password_hash) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } })
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } })
    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken()
    await saveRefreshToken(user.id, refreshToken)
    await logEvent('global', 'user.login', { user_id: user.id })
    res.json({ token: accessToken, refresh_token: refreshToken, user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } })
  } catch (err) { console.error('Login:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Login failed' } }) }
})

app.post('/api/v1/auth/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body
    if (!refresh_token) return res.status(400).json({ error: { code: 'MISSING_TOKEN', message: 'Refresh token required' } })
    const record = await findRefreshToken(refresh_token)
    if (!record) return res.status(401).json({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Token invalid or expired' } })
    await deleteRefreshToken(refresh_token)
    const newRefreshToken = generateRefreshToken()
    await saveRefreshToken(record.user_id, newRefreshToken)
    const accessToken = generateAccessToken({ id: record.uid, email: record.email, role: record.role })
    res.json({ token: accessToken, refresh_token: newRefreshToken })
  } catch (err) { console.error('Refresh:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Refresh failed' } }) }
})

app.post('/api/v1/auth/logout', async (req, res) => {
  try { const { refresh_token } = req.body; if (refresh_token) await deleteRefreshToken(refresh_token) } catch (err) {}
  res.json({ ok: true })
})

app.get('/api/v1/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, display_name, role, created_at, email_verified FROM users WHERE id = $1', [req.user.sub])
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } })
    res.json(rows[0])
  } catch (err) { res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch user' } }) }
})

app.get('/api/device/:uid/config', async (req, res) => {
  const { uid } = req.params
  const saved = await getConfig(uid)
  const defaults = { brightness: 80, team: 'LAL', animation_pack: 'default', mode: 'sport_live', color_theme: 'team' }
  res.json({ uid, settings: saved ? { ...defaults, ...saved.settings } : defaults, active_mode: saved?.active_mode || 'sport_live' })
  logEvent(uid, 'config.read', { uid })
})

app.patch('/api/device/:uid/config', async (req, res) => {
  const { uid } = req.params
  const saved = await getConfig(uid)
  const current = saved?.settings || {}
  const updated = { ...current, ...req.body }
  await saveConfig(uid, updated)
  deviceConfigs[uid] = updated
  const diff = getDiff(updated, current)
  if (diff) broadcast({ type: 'CONFIG_UPDATE', data: diff })
  logEvent(uid, 'config.update', { diff })
  res.json({ ok: true, settings: updated })
})

app.post('/api/device/:uid/trigger', (req, res) => {
  const { uid } = req.params
  const { reason = 'THREE', team = 'home' } = req.body
  const colors = getTeamColors(team === 'home' ? lastState.home_team : lastState.away_team || 'LAL')
  broadcast({ type: 'SCORE_EVENT', team, colors, reason })
  logEvent(uid, 'trigger.manual', { reason, team })
  res.json({ ok: true, triggered: reason })
})

app.get('/api/v1/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, display_name, role, created_at, email_verified FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100')
    res.json({ users: rows })
  } catch (err) { res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.get('/api/v1/admin/events', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM events ORDER BY occurred_at DESC LIMIT 100')
    res.json({ events: rows })
  } catch (err) { res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

const server = require('http').createServer(app)
const wss    = new WebSocket.Server({ server })

function broadcast(msg) {
  const data = JSON.stringify(msg)
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data) })
}

function checkAndBroadcast(game, diff) {
  if (!diff) return
  const prevHome = lastState.home_score || 0
  const prevAway = lastState.away_score || 0
  const homeDiff = game.home_score - game.away_score
  const prevDiff = prevHome - prevAway
  const leadChanged = (homeDiff > 0 && prevDiff <= 0) || (homeDiff < 0 && prevDiff >= 0)
  const isThree = (diff.home_score !== undefined && game.home_score - prevHome === 3) || (diff.away_score !== undefined && game.away_score - prevAway === 3)
  const clutch = game.period === 4 && Math.abs(homeDiff) <= 5
  if (leadChanged || isThree || clutch) {
    const colors = getTeamColors(diff.home_score !== undefined ? game.home_team : game.away_team)
    broadcast({ type: 'SCORE_EVENT', team: diff.home_score !== undefined ? 'home' : 'away', colors, reason: leadChanged ? 'LEAD_CHANGE' : isThree ? 'THREE' : 'CLUTCH' })
    logEvent('global', 'score.event', { reason: leadChanged ? 'LEAD_CHANGE' : isThree ? 'THREE' : 'CLUTCH' })
  }
  if (!lastState.home_team) { diff.home_color = getTeamColors(game.home_team).secondary; diff.away_color = getTeamColors(game.away_team).secondary }
  lastState = { ...game }
  broadcast({ type: 'SCORE_UPDATE', data: diff })
}

function processMockTick() {
  tickMock()
  const game = { id: mockState.id, status: mockState.status, clock: `${mockState.clockMinutes}:${String(mockState.clockSeconds).padStart(2, '0')}`, period: mockState.period, home_team: mockState.home_team, home_score: mockState.home_score, away_team: mockState.away_team, away_score: mockState.away_score }
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

wss.on('connection', async (ws, req) => {
  const uid = new URL(req.url, 'http://x').searchParams.get('uid') || 'unknown'
  console.log(`Board connected: ${uid} — total: ${wss.clients.size}`)
  await getOrCreateDevice(uid)
  logEvent(uid, 'device.connect', { uid })
  if (Object.keys(lastState).length > 0) {
    ws.send(JSON.stringify({ type: 'FULL_STATE', data: { ...lastState, home_color: getTeamColors(lastState.home_team).secondary, away_color: getTeamColors(lastState.away_team).secondary } }))
  }
  const saved = await getConfig(uid)
  if (saved) ws.send(JSON.stringify({ type: 'CONFIG_UPDATE', data: saved.settings }))
  ws.on('close', () => { logEvent(uid, 'device.disconnect', { uid }); console.log(`Board disconnected: ${uid} — total: ${wss.clients.size}`) })
})

async function boot() {
  await runMigrations()
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ArenaBoard server v3.1 running on port ${PORT}`)
    console.log(`DB: ${process.env.DATABASE_URL ? 'connected' : 'none (memory only)'}`)
    console.log(`Mode: ${MOCK_MODE ? 'MOCK' : 'ESPN live'}`)
  })
  if (MOCK_MODE) { setInterval(processMockTick, 1000); processMockTick() }
  else { setInterval(pollESPN, 3000); pollESPN() }
}

boot()
