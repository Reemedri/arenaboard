-- ArenaBoard Phase 4 — Admin Dashboard
-- Run order: 003
-- Adds: users.suspended_at, admin_audit_log, impersonation_tokens
-- Required by index.js v4.0 admin endpoints (already coded but lacking schema)

-- 1. Suspended-at flag on users (used by /admin/users/:id/suspend + login guard)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

-- 2. Admin action audit log
-- Every admin write (suspend, unsuspend, impersonate, force-reload) gets a row.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_id   uuid,
  reason      text,
  occurred_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin    ON admin_audit_log(admin_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target   ON admin_audit_log(target_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_occurred ON admin_audit_log(occurred_at DESC);

-- 3. Impersonation tokens
-- Short-lived (15 min) tokens issued when an admin impersonates a user.
-- token_hash stores SHA-256 of the JWT for later auditing/revocation.
CREATE TABLE IF NOT EXISTS impersonation_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text UNIQUE NOT NULL,
  admin_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  target_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imp_tokens_admin   ON impersonation_tokens(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imp_tokens_target  ON impersonation_tokens(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imp_tokens_expires ON impersonation_tokens(expires_at);
