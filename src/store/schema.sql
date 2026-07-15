CREATE TABLE schema_meta (
    fingerprint TEXT NOT NULL
);

CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    clarification_round INTEGER NOT NULL DEFAULT 0,
    clarifications TEXT NOT NULL DEFAULT '[]',
    draft TEXT,
    analysis_revision INTEGER NOT NULL DEFAULT 0,
    active_prompt TEXT,
    clarification_history TEXT NOT NULL DEFAULT '[]',
    pi_session_file TEXT,
    error TEXT,
    failure_stage TEXT,
    failure_code TEXT,
    queued_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'standalone'
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE project_chats (
    singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'chat'),
    messages TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'qa',
    active_requirement_id TEXT,
    running INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    pi_session_file TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL,
    status TEXT NOT NULL,
    change_spec TEXT NOT NULL,
    design_notes TEXT NOT NULL DEFAULT '[]',
    plan_summary TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    base_head TEXT,
    integration_branch TEXT,
    integration_worktree TEXT,
    final_commit TEXT,
    rescue_used INTEGER NOT NULL DEFAULT 0,
    rescue_attempt_id TEXT,
    blocked_reason TEXT,
    paused_operation TEXT,
    replaces_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE RESTRICT,
    FOREIGN KEY (replaces_run_id) REFERENCES workflow_runs(id) ON DELETE RESTRICT
);

CREATE INDEX workflow_runs_requirement_created
    ON workflow_runs(requirement_id, created_at DESC);
CREATE INDEX workflow_runs_status
    ON workflow_runs(status, updated_at);
CREATE UNIQUE INDEX workflow_runs_replaces_unique
    ON workflow_runs(replaces_run_id) WHERE replaces_run_id IS NOT NULL;

CREATE TABLE workflow_work_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    objective TEXT NOT NULL,
    scenario_refs TEXT NOT NULL,
    group_name TEXT,
    scope_hints TEXT NOT NULL DEFAULT '[]',
    verification_goals TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    accepted_attempt_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, position),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX workflow_work_items_runnable
    ON workflow_work_items(run_id, status, position);

CREATE TABLE workflow_dependencies (
    work_item_id TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    PRIMARY KEY (work_item_id, depends_on_id),
    CHECK (work_item_id != depends_on_id),
    FOREIGN KEY (work_item_id) REFERENCES workflow_work_items(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_id) REFERENCES workflow_work_items(id) ON DELETE RESTRICT
);

CREATE TABLE workflow_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    work_item_id TEXT,
    kind TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    model_tier TEXT NOT NULL,
    pi_session_file TEXT,
    worktree_fingerprint TEXT,
    result_summary TEXT,
    failure_class TEXT,
    failure_message TEXT,
    usage TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (run_id, work_item_id, kind, ordinal),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (work_item_id) REFERENCES workflow_work_items(id) ON DELETE SET NULL
);

CREATE INDEX workflow_attempts_run_started
    ON workflow_attempts(run_id, started_at);

CREATE TABLE workflow_checkpoints (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    snapshot_sha TEXT NOT NULL,
    required_angles TEXT NOT NULL,
    summary TEXT,
    review_details TEXT,
    usage TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX workflow_checkpoints_run_created
    ON workflow_checkpoints(run_id, created_at);

CREATE TABLE workflow_validations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    attempt_id TEXT,
    checkpoint_id TEXT,
    command TEXT NOT NULL,
    source TEXT NOT NULL,
    gating INTEGER NOT NULL DEFAULT 0,
    baseline_status TEXT NOT NULL,
    final_status TEXT NOT NULL,
    baseline_exit_code INTEGER,
    final_exit_code INTEGER,
    output_summary TEXT,
    worktree_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(id) ON DELETE SET NULL,
    FOREIGN KEY (checkpoint_id) REFERENCES workflow_checkpoints(id) ON DELETE SET NULL
);

CREATE INDEX workflow_validations_fingerprint
    ON workflow_validations(run_id, command, worktree_fingerprint, final_status);

CREATE TABLE workflow_review_findings (
    id TEXT PRIMARY KEY,
    checkpoint_id TEXT NOT NULL,
    angle TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    category TEXT NOT NULL,
    path TEXT,
    location TEXT,
    summary TEXT NOT NULL,
    evidence TEXT NOT NULL,
    reproduction TEXT,
    remediation TEXT,
    scenario_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (checkpoint_id, angle, category, path, location),
    FOREIGN KEY (checkpoint_id) REFERENCES workflow_checkpoints(id) ON DELETE CASCADE
);

CREATE TABLE workflow_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX workflow_events_run_sequence
    ON workflow_events(run_id, sequence);

CREATE TABLE workflow_publications (
    run_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    phase TEXT NOT NULL,
    origin TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    source_branch TEXT NOT NULL,
    review_url TEXT,
    head_commit TEXT,
    merge_commit TEXT,
    local_sync_status TEXT NOT NULL,
    local_sync_message TEXT,
    cleanup_status TEXT NOT NULL,
    remote_ci_fix_used INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE TABLE workflow_item_workspaces (
    work_item_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    result_commit TEXT,
    status TEXT NOT NULL,
    fallback_serial INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (work_item_id) REFERENCES workflow_work_items(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX workflow_item_workspaces_run
    ON workflow_item_workspaces(run_id, status);

CREATE TABLE workflow_failure_fuses (
    run_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    failure_class TEXT NOT NULL,
    integration_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (work_item_id, failure_class, integration_fingerprint),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (work_item_id) REFERENCES workflow_work_items(id) ON DELETE CASCADE
);
