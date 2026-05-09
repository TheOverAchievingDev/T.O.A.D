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
  task_id TEXT,
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

CREATE TABLE IF NOT EXISTS team_configs (
  team_id     TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS foundry_sessions (
  session_id      TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  project_path    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  cli_session_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_foundry_sessions_updated
  ON foundry_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS foundry_messages (
  message_id    TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  role          TEXT NOT NULL,
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (session_id) REFERENCES foundry_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_foundry_messages_session
  ON foundry_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS foundry_artifacts (
  artifact_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  target_path   TEXT,
  version       INTEGER NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (session_id) REFERENCES foundry_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_foundry_artifacts_session
  ON foundry_artifacts(session_id, kind, updated_at);

-- Drift Monitor (slice 1) — see docs/superpowers/specs/2026-05-03-drift-monitor-design.md
-- Findings are replaced wholesale per run (delete-by-team_id, insert-new).
-- correction_task_id (Drift Slice 3) stamps a finding as "under remediation" — engine
-- excludes it from score + skips LLM re-emit until the correction task hits done/rejected
-- (then engine reaps via SqliteDriftStore.reapResolvedCorrections).
-- See docs/superpowers/specs/2026-05-04-drift-slice-3-correction-tasks-design.md
CREATE TABLE IF NOT EXISTS drift_findings (
  finding_id         TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL,
  team_id            TEXT NOT NULL,
  task_id            TEXT,
  category           TEXT NOT NULL,
  severity           TEXT NOT NULL,
  check_name         TEXT NOT NULL,
  title              TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  expected           TEXT NOT NULL,
  actual             TEXT NOT NULL,
  recommended        TEXT NOT NULL,
  auto_fixable       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  correction_task_id TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_drift_findings_team ON drift_findings(team_id);
CREATE INDEX IF NOT EXISTS idx_drift_findings_task ON drift_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_drift_findings_run  ON drift_findings(run_id);
-- idx_drift_findings_correction is created by applyMigrations in sqlite.js so it
-- works on both fresh DBs (column already present) and existing DBs (column added
-- via ALTER TABLE before the index is created).

-- One row per run; pruned to last 500 per team.
CREATE TABLE IF NOT EXISTS drift_score_history (
  run_id              TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL,
  team_score          INTEGER NOT NULL,
  status              TEXT NOT NULL,
  category_scores_json TEXT NOT NULL,
  per_task_scores_json TEXT NOT NULL,
  findings_count      INTEGER NOT NULL,
  trigger             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_drift_score_history_team_time
  ON drift_score_history(team_id, created_at DESC);

-- Plugin Slice 0+1 — see docs/superpowers/specs/2026-05-04-plugin-slice-0-1-railway-design.md
-- Background-job tracker for long-running plugin actions (EAS builds,
-- Vercel deploys, etc). Mostly unused in slice 1 (Railway is synchronous);
-- table exists so slice 2 (EAS) can plug in without a schema migration.
CREATE TABLE IF NOT EXISTS plugin_jobs (
  job_id          TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  plugin_id       TEXT NOT NULL,
  action          TEXT NOT NULL,
  state           TEXT NOT NULL,
  args_json       TEXT NOT NULL DEFAULT '{}',
  log_tail        TEXT,
  started_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  finished_at     TEXT,
  error           TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_jobs_team ON plugin_jobs(team_id);
CREATE INDEX IF NOT EXISTS idx_plugin_jobs_team_state ON plugin_jobs(team_id, state);

-- Provisioned-resource tracker. Used immediately by Railway's idempotency
-- check (the partial index makes "is there a live Postgres for this team?"
-- a single index lookup). Cleanup-on-team-delete reads from this table.
CREATE TABLE IF NOT EXISTS plugin_resources (
  resource_id     TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  plugin_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  deprovisioned_at TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_resources_team ON plugin_resources(team_id);
CREATE INDEX IF NOT EXISTS idx_plugin_resources_live
  ON plugin_resources(team_id, plugin_id, kind)
  WHERE deprovisioned_at IS NULL;
