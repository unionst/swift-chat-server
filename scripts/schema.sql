CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  external_id text NOT NULL UNIQUE,
  name text,
  avatar_url text,
  event_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  name text,
  photo_url text,
  direct_key text UNIQUE,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participants (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_seq bigint NOT NULL DEFAULT 0,
  delivered_seq bigint NOT NULL DEFAULT 0,
  typing_until timestamptz,
  muted boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS participants_user_idx ON participants (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  sender_id text REFERENCES users(id) ON DELETE SET NULL,
  text text NOT NULL DEFAULT '',
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_key ON messages (conversation_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reactions (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  part text NOT NULL DEFAULT 'message' CHECK (part IN ('message', 'media')),
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, part)
);

CREATE TABLE IF NOT EXISTS user_events (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX IF NOT EXISTS user_events_age_idx ON user_events (created_at);

CREATE TABLE IF NOT EXISTS devices (
  token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'production',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);
