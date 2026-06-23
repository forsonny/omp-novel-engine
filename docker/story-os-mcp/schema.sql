CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_config(
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY(project_id, key)
);

CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT,
  description TEXT,
  status TEXT,
  first_seen_ref TEXT,
  last_seen_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canon_facts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_id TEXT,
  fact_type TEXT NOT NULL,
  fact_text TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  confidence REAL NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  supersedes_fact_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  state TEXT,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  event_type TEXT,
  time_label TEXT,
  chronology_index REAL,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_edges(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_event_id TEXT NOT NULL,
  to_event_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS arcs(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  owner_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seven_point_beats(
  id TEXT PRIMARY KEY,
  arc_id TEXT NOT NULL,
  beat_name TEXT NOT NULL,
  beat_order INTEGER NOT NULL,
  summary TEXT NOT NULL,
  evidence_ref TEXT,
  approved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chapters(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  container_type TEXT NOT NULL,
  container_id TEXT NOT NULL,
  chapter_number INTEGER NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  markdown_path TEXT,
  selected_variant_id TEXT,
  selected_draft_revision_id TEXT,
  approved_by_gate_id TEXT,
  approved_at TEXT,
  final_markdown_path TEXT,
  completion_notes TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_draft_revisions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  draft_stage TEXT NOT NULL,
  status TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  revision_notes TEXT,
  is_selected INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_variants(
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL,
  variant_type TEXT NOT NULL,
  purpose TEXT NOT NULL,
  changed_structurally TEXT,
  changed_emotionally TEXT,
  changed_in_pacing TEXT,
  canon_risk TEXT,
  continuity_risk TEXT,
  best_use_case TEXT,
  reason_to_choose TEXT,
  reason_not_to_choose TEXT,
  markdown_path TEXT NOT NULL,
  rank_score REAL,
  ranking_reason TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  selection_reason TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gates(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  gate_type TEXT NOT NULL,
  status TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  blocker_reason TEXT,
  blocker_payload_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS gate_decisions(
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  project_id TEXT,
  decision TEXT NOT NULL,
  human_decision TEXT,
  human_confirmed INTEGER NOT NULL DEFAULT 0,
  decision_source TEXT,
  notes TEXT,
  decided_by TEXT,
  decided_at TEXT NOT NULL,
  decision_metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS planning_artifacts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_key TEXT,
  title TEXT,
  payload_json TEXT NOT NULL,
  gate_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mermaid_exports(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  diagram_kind TEXT NOT NULL,
  artifact_type TEXT,
  artifact_id TEXT,
  file_path TEXT NOT NULL,
  mermaid_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_runs(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  audit_type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT,
  artifact_type TEXT,
  artifact_id TEXT,
  artifact_path TEXT,
  provenance_json TEXT,
  completed_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_findings(
  id TEXT PRIMARY KEY,
  audit_run_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  quote_or_location TEXT NOT NULL,
  why_flagged TEXT NOT NULL,
  fix_strategy TEXT NOT NULL,
  finding_key TEXT,
  evidence_json TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolution_notes TEXT,
  found_by TEXT,
  found_at TEXT
);

CREATE TABLE IF NOT EXISTS serial_seasons(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  season_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  promise_summary TEXT,
  arc_id TEXT,
  gate_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS serial_episodes(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL UNIQUE,
  episode_number INTEGER NOT NULL,
  serial_sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  release_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS serial_promises(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  visibility TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  opened_episode_id TEXT,
  target_scope_type TEXT,
  target_scope_id TEXT,
  payoff_episode_id TEXT,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS serial_promise_events(
  id TEXT PRIMARY KEY,
  promise_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  episode_id TEXT,
  notes TEXT,
  source_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS serial_recaps(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  source_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS serial_season_reports(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  unresolved_promise_count INTEGER NOT NULL DEFAULT 0,
  incomplete_episode_count INTEGER NOT NULL DEFAULT 0,
  gate_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_serial_seasons_project_number ON serial_seasons(project_id, season_number);
CREATE INDEX IF NOT EXISTS idx_serial_seasons_project_active ON serial_seasons(project_id, status);
CREATE INDEX IF NOT EXISTS idx_serial_episodes_project_season_number ON serial_episodes(project_id, season_id, episode_number);
CREATE INDEX IF NOT EXISTS idx_serial_episodes_project_sequence ON serial_episodes(project_id, serial_sequence);
CREATE INDEX IF NOT EXISTS idx_serial_episodes_chapter ON serial_episodes(chapter_id);
CREATE INDEX IF NOT EXISTS idx_serial_promises_project_scope ON serial_promises(project_id, status, visibility);
CREATE INDEX IF NOT EXISTS idx_serial_promises_project_scope_lookup ON serial_promises(project_id, target_scope_type, target_scope_id);
CREATE INDEX IF NOT EXISTS idx_serial_promise_events_promise ON serial_promise_events(promise_id, created_at);
CREATE INDEX IF NOT EXISTS idx_serial_recaps_project ON serial_recaps(project_id, scope_type, scope_id, audience, created_at);
CREATE INDEX IF NOT EXISTS idx_serial_season_reports_project ON serial_season_reports(project_id, season_id, created_at);
