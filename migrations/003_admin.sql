-- ArenaBoard Phase 4 — Admin Dashboard
-- Run order: 003

-- Add suspension support to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

-- Audit log: every admin action is recorded here
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_id   uuid,
  reason      text,
  occurred_at timestamptz DEFAULT now()
);

-- Short-lived impersonation tokens (15-min TTL enforced in app code)
CREATE TABLE IF NOT EXISTS impersonation_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text UNIQUE NOT NULL,
  admin_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  target_user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin    ON admin_audit_log(admin_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target   ON admin_audit_log(target_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_imp_tokens_hash      ON impersonation_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_imp_tokens_expires   ON impersonation_tokens(expires_at);
