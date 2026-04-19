-- ArenaBoard Phase 3 — Authentication
-- Run order: 002

-- Add auth fields to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash   text,
  ADD COLUMN IF NOT EXISTS display_name    text,
  ADD COLUMN IF NOT EXISTS email_verified  boolean DEFAULT false;

-- Refresh tokens table
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Add JWT secret placeholder (set via env var in production)
-- JWT_SECRET must be set in Railway environment variables
