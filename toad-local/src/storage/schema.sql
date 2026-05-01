PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  provider_id TEXT,
  runtime_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  team_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_team_id TEXT,
  to_agent_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reply_to_message_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox
  ON messages(team_id, to_kind, to_team_id, to_agent_id, created_at);

CREATE TABLE IF NOT EXISTS message_task_refs (
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (message_id, task_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, reader_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  payload_hash TEXT,
  message_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  delivery_kind TEXT NOT NULL DEFAULT 'unknown',
  destination_json TEXT NOT NULL,
  status TEXT NOT NULL,
  response_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  receipt_json TEXT,
  error TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);

CREATE TABLE IF NOT EXISTS runtime_instances (
  runtime_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  cwd TEXT,
  env_json TEXT NOT NULL DEFAULT '{}',
  delivery_mode TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_instances_team
  ON runtime_instances(team_id, agent_id, status);

CREATE TABLE IF NOT EXISTS agent_delivery_modes (
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (runtime_id) REFERENCES runtime_instances(runtime_id)
);

CREATE TABLE IF NOT EXISTS runtime_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  runtime_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_runtime
  ON runtime_events(runtime_id, created_at);

CREATE TABLE IF NOT EXISTS task_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_task_events_task
  ON task_events(team_id, task_id, created_at);

CREATE TABLE IF NOT EXISTS approval_requests (
  approval_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  decision_json TEXT,
  response_idempotency_key TEXT UNIQUE,
  responded_by_team_id TEXT,
  responded_by_agent_id TEXT,
  reason TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_team
  ON approval_requests(team_id, created_at);

CREATE TABLE IF NOT EXISTS approval_deliveries (
  delivery_id TEXT PRIMARY KEY,
  approval_id TEXT UNIQUE NOT NULL,
  runtime_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  FOREIGN KEY (approval_id) REFERENCES approval_requests(approval_id)
);

CREATE TABLE IF NOT EXISTS side_effect_deliveries (
  delivery_id    TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  kind           TEXT NOT NULL,
  runtime_id     TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  delivered_at   TEXT
);
