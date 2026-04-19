-- ArenaBoard Phase 2 — Initial Schema
-- Run order: 001

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE,
  role        text NOT NULL DEFAULT 'user',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uid            text UNIQUE NOT NULL,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  name           text,
  firmware_ver   text,
  last_heartbeat timestamptz,
  last_ip        inet,
  activated_at   timestamptz,
  created_at     timestamptz DEFAULT now(),
  deleted_at     timestamptz
);

CREATE TABLE IF NOT EXISTS device_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid REFERENCES devices(id) ON DELETE CASCADE,
  active_mode text NOT NULL DEFAULT 'sport_live',
  settings    jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id),
  device_id   uuid REFERENCES devices(id),
  type        text NOT NULL,
  payload     jsonb,
  ip          inet,
  occurred_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migrations (
  id         serial PRIMARY KEY,
  filename   text UNIQUE NOT NULL,
  applied_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user   ON events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_uid   ON devices(uid);
