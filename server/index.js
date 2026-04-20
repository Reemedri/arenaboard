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

async function logAdminAction(adminId, action, targetId, reason) {
  if (!process.env.DATABASE_URL) return
  try {
    await db.query(`INSERT INTO admin_audit_log (admin_id, action, target_id, reason) VALUES ($1, $2, $3, $4)`, [adminId, action, targetId || null, reason || null])
  } catch (err) { console.error('logAdminAction:', err.message) }
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
const deviceSockets = new Map()  // uid -> ws (for targeted admin messages)
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

app.get('/', (req, res) => res.json({ service: 'ArenaBoard Server', version: '4.0', mock: MOCK_MODE, db: !!process.env.DATABASE_URL, clients: wss?.clients?.size || 0 }))
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
    if (user.suspended_at) return res.status(403).json({ error: { code: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' } })
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
    const { rows } = await db.query('SELECT id, email, display_name, role, created_at, email_verified, suspended_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100')
    res.json({ users: rows })
  } catch (err) { res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.get('/api/v1/admin/events', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM events ORDER BY occurred_at DESC LIMIT 100')
    res.json({ events: rows })
  } catch (err) { res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.get('/api/v1/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: users } = await db.query('SELECT id, email, display_name, role, created_at, email_verified, suspended_at FROM users WHERE id = $1 AND deleted_at IS NULL', [req.params.id])
    if (!users[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } })
    const { rows: devices } = await db.query('SELECT id, uid, name, firmware_ver, last_heartbeat, activated_at FROM devices WHERE user_id = $1 AND deleted_at IS NULL', [req.params.id])
    const deviceIds = devices.map(d => d.id)
    const { rows: events } = await db.query(
      `SELECT id, type, payload, occurred_at FROM events WHERE user_id = $1 OR device_id = ANY($2::uuid[]) ORDER BY occurred_at DESC LIMIT 50`,
      [req.params.id, deviceIds]
    )
    res.json({ user: users[0], devices: devices.map(d => ({ ...d, online: deviceSockets.has(d.uid) })), events })
  } catch (err) { console.error('admin/users/:id:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.post('/api/v1/admin/users/:id/suspend', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {}
    const { rows } = await db.query('UPDATE users SET suspended_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, email, suspended_at', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } })
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.params.id])
    await logAdminAction(req.user.sub, 'user.suspend', req.params.id, reason)
    res.json({ ok: true, user: rows[0] })
  } catch (err) { console.error('admin/suspend:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.post('/api/v1/admin/users/:id/unsuspend', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('UPDATE users SET suspended_at = NULL WHERE id = $1 AND deleted_at IS NULL RETURNING id, email, suspended_at', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } })
    await logAdminAction(req.user.sub, 'user.unsuspend', req.params.id, null)
    res.json({ ok: true, user: rows[0] })
  } catch (err) { res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.post('/api/v1/admin/users/:id/impersonate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {}
    const { rows } = await db.query('SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL', [req.params.id])
    const target = rows[0]
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } })
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const jwtToken = jwt.sign({ sub: target.id, email: target.email, role: target.role, impersonated_by: req.user.sub }, JWT_SECRET, { expiresIn: '15m' })
    const tokenHash = crypto.createHash('sha256').update(jwtToken).digest('hex')
    await db.query('INSERT INTO impersonation_tokens (token_hash, admin_id, target_user_id, expires_at) VALUES ($1, $2, $3, $4)', [tokenHash, req.user.sub, target.id, expiresAt])
    await logAdminAction(req.user.sub, 'user.impersonate', target.id, reason)
    res.json({ token: jwtToken, expires_at: expiresAt, target: { id: target.id, email: target.email } })
  } catch (err) { console.error('admin/impersonate:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.get('/api/v1/admin/devices', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, uid, user_id, name, firmware_ver, last_heartbeat, last_ip, activated_at, created_at FROM devices WHERE deleted_at IS NULL ORDER BY last_heartbeat DESC NULLS LAST LIMIT 200')
    const devices = rows.map(d => ({ ...d, online: deviceSockets.has(d.uid) }))
    res.json({ devices, connected: deviceSockets.size })
  } catch (err) { res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.get('/api/v1/admin/devices/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM devices WHERE id = $1 AND deleted_at IS NULL', [req.params.id])
    const device = rows[0]
    if (!device) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } })
    const { rows: cfg } = await db.query('SELECT active_mode, settings, updated_at FROM device_configs WHERE device_id = $1', [device.id])
    const { rows: events } = await db.query('SELECT id, type, payload, occurred_at FROM events WHERE device_id = $1 ORDER BY occurred_at DESC LIMIT 50', [device.id])
    res.json({ device: { ...device, online: deviceSockets.has(device.uid) }, config: cfg[0] || null, events })
  } catch (err) { console.error('admin/devices/:id:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.post('/api/v1/admin/devices/:id/force-reload', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, uid FROM devices WHERE id = $1 AND deleted_at IS NULL', [req.params.id])
    const device = rows[0]
    if (!device) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } })
    const ws = deviceSockets.get(device.uid)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      await logAdminAction(req.user.sub, 'device.force_reload.offline', device.id, null)
      return res.status(410).json({ error: { code: 'DEVICE_OFFLINE', message: 'Device not connected' } })
    }
    const saved = await getConfig(device.uid)
    ws.send(JSON.stringify({ type: 'CONFIG_UPDATE', data: saved?.settings || {}, forced: true }))
    await logAdminAction(req.user.sub, 'device.force_reload', device.id, null)
    res.json({ ok: true, uid: device.uid })
  } catch (err) { console.error('admin/force-reload:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.get('/api/v1/admin/metrics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [users, devices, active, perMin] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS total FROM users WHERE deleted_at IS NULL'),
      db.query('SELECT COUNT(*)::int AS total FROM devices WHERE deleted_at IS NULL'),
      db.query(`SELECT COUNT(DISTINCT user_id)::int AS active FROM events WHERE type = 'user.login' AND occurred_at > now() - interval '24 hours'`),
      db.query(`SELECT COUNT(*)::int AS total FROM events WHERE occurred_at > now() - interval '1 minute'`),
    ])
    res.json({
      total_users: users.rows[0].total,
      active_users_24h: active.rows[0].active,
      total_devices: devices.rows[0].total,
      devices_online: deviceSockets.size,
      connected_clients: wss.clients.size,
      events_per_minute: perMin.rows[0].total,
    })
  } catch (err) { console.error('admin/metrics:', err.message); res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed' } }) }
})

app.get('/api/v1/admin/audit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT a.id, a.admin_id, u.email AS admin_email, a.action, a.target_id, a.reason, a.occurred_at FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.occurred_at DESC LIMIT 100`)
    res.json({ audit: rows })
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
  deviceSockets.set(uid, ws)
  await getOrCreateDevice(uid)
  logEvent(uid, 'device.connect', { uid })
  if (Object.keys(lastState).length > 0) {
    ws.send(JSON.stringify({ type: 'FULL_STATE', data: { ...lastState, home_color: getTeamColors(lastState.home_team).secondary, away_color: getTeamColors(lastState.away_team).secondary } }))
  }
  const saved = await getConfig(uid)
  if (saved) ws.send(JSON.stringify({ type: 'CONFIG_UPDATE', data: saved.settings }))
  ws.on('close', () => {
    if (deviceSockets.get(uid) === ws) deviceSockets.delete(uid)
    logEvent(uid, 'device.disconnect', { uid })
    console.log(`Board disconnected: ${uid} — total: ${wss.clients.size}`)
  })
})

async function boot() {
  await runMigrations()
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ArenaBoard server v4.0 running on port ${PORT}`)
    console.log(`DB: ${process.env.DATABASE_URL ? 'connected' : 'none (memory only)'}`)
    console.log(`Mode: ${MOCK_MODE ? 'MOCK' : 'ESPN live'}`)
  })
  if (MOCK_MODE) { setInterval(processMockTick, 1000); processMockTick() }
  else { setInterval(pollESPN, 3000); pollESPN() }
}

boot()
