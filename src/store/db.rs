use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, Transaction, params};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::AppError;
use crate::models::{
    AppData, ModelSettings, Project, ProjectChat, Requirement, RequirementStatus, SummaryNode,
    TerminalCommandProfile,
};

const SCHEMA_VERSION: i64 = 5;
const LEGACY_SCHEMA_VERSION: i64 = 4;

pub struct Database {
    conn: std::sync::Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        archive_legacy_database(path)?;
        let conn = Connection::open(path)?;
        conn.busy_handler(Some(retry_busy_database_operation))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )?;
        let db = Self {
            conn: std::sync::Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), AppError> {
        let mut conn = self.conn.lock().expect("db lock poisoned");
        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                git_url TEXT NOT NULL,
                local_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS requirements (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                original_message TEXT NOT NULL,
                status TEXT NOT NULL,
                messages TEXT NOT NULL DEFAULT '[]',
                clarification_round INTEGER NOT NULL DEFAULT 0,
                clarifications TEXT NOT NULL DEFAULT '[]',
                draft TEXT,
                analysis_revision INTEGER NOT NULL DEFAULT 0,
                active_prompt TEXT,
                clarification_history TEXT NOT NULL DEFAULT '[]',
                pi_session_file TEXT,
                error TEXT,
                queued_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT 'standalone'
            );

            CREATE TABLE IF NOT EXISTS requirement_sessions (
                requirement_id TEXT NOT NULL,
                session_file TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (requirement_id, session_file),
                FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_chats (
                project_id TEXT PRIMARY KEY,
                messages TEXT NOT NULL DEFAULT '[]',
                running INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                pi_session_file TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_runs (
                id TEXT PRIMARY KEY,
                requirement_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
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
                version INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE RESTRICT
            );

            CREATE INDEX IF NOT EXISTS workflow_runs_requirement_created
                ON workflow_runs(requirement_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS workflow_runs_status
                ON workflow_runs(status, updated_at);

            CREATE TABLE IF NOT EXISTS workflow_work_items (
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
                lease_owner TEXT,
                lease_expires_at TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (run_id, position),
                FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS workflow_work_items_runnable
                ON workflow_work_items(run_id, status, position);

            CREATE TABLE IF NOT EXISTS workflow_dependencies (
                work_item_id TEXT NOT NULL,
                depends_on_id TEXT NOT NULL,
                PRIMARY KEY (work_item_id, depends_on_id),
                CHECK (work_item_id != depends_on_id),
                FOREIGN KEY (work_item_id) REFERENCES workflow_work_items(id) ON DELETE CASCADE,
                FOREIGN KEY (depends_on_id) REFERENCES workflow_work_items(id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS workflow_attempts (
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

            CREATE INDEX IF NOT EXISTS workflow_attempts_run_started
                ON workflow_attempts(run_id, started_at);

            CREATE TABLE IF NOT EXISTS workflow_checkpoints (
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

            CREATE INDEX IF NOT EXISTS workflow_checkpoints_run_created
                ON workflow_checkpoints(run_id, created_at);

            CREATE TABLE IF NOT EXISTS workflow_validations (
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

            CREATE INDEX IF NOT EXISTS workflow_validations_fingerprint
                ON workflow_validations(run_id, command, worktree_fingerprint, final_status);

            CREATE TABLE IF NOT EXISTS workflow_review_findings (
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

            CREATE TABLE IF NOT EXISTS workflow_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS workflow_events_run_sequence
                ON workflow_events(run_id, sequence);

            CREATE TABLE IF NOT EXISTS workflow_snapshots (
                run_id TEXT PRIMARY KEY,
                last_event_sequence INTEGER NOT NULL,
                snapshot TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
            );
            ",
        )?;
        let versions = {
            let mut statement = tx.prepare("SELECT version FROM schema_version")?;
            statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let unique_versions: HashSet<i64> = versions.iter().copied().collect();
        match unique_versions.len() {
            0 => {}
            1 if unique_versions.contains(&SCHEMA_VERSION) => {}
            1 => {
                let version = unique_versions.iter().next().expect("one unique version");
                return Err(AppError::internal(format!("不支持的数据库版本：{version}")));
            }
            _ => return Err(AppError::internal("数据库 schema_version 记录损坏")),
        }
        tx.execute("DELETE FROM schema_version", [])?;
        tx.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [SCHEMA_VERSION],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load(&self) -> Result<AppData, AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        let version = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get::<_, Option<i64>>(0)
            })?
            .ok_or_else(|| AppError::internal("数据库缺少 schema version"))?;
        if version != SCHEMA_VERSION {
            return Err(AppError::internal(format!("不支持的数据库版本：{version}")));
        }

        let settings = load_settings(&conn)?;
        Ok(AppData {
            projects: load_projects(&conn)?,
            requirements: load_requirements(&conn)?,
            project_chats: load_project_chats(&conn)?,
            settings_summary: setting_or_default(
                &settings,
                "settings_summary",
                SummaryNode {
                    title: "设置".to_owned(),
                    description: "基础设置待配置".to_owned(),
                },
            )?,
            model_summary: setting_or_default(
                &settings,
                "model_summary",
                SummaryNode {
                    title: "模型设置".to_owned(),
                    description: "默认模型待配置".to_owned(),
                },
            )?,
            model_settings: setting_or_default(
                &settings,
                "model_settings",
                ModelSettings::default(),
            )?,
            terminal_command_profiles: setting_or_default::<Vec<TerminalCommandProfile>>(
                &settings,
                "terminal_command_profiles",
                Vec::new(),
            )?,
        })
    }

    pub fn sync_changes(&self, previous: &AppData, next: &AppData) -> Result<(), AppError> {
        let mut conn = self.conn.lock().expect("db lock poisoned");
        let tx = conn.transaction()?;

        sync_by_id(
            &tx,
            &previous.projects,
            &next.projects,
            |project| project.id.as_str(),
            "projects",
            save_project,
        )?;
        sync_by_id(
            &tx,
            &previous.requirements,
            &next.requirements,
            |requirement| requirement.id.as_str(),
            "requirements",
            save_requirement,
        )?;
        sync_by_id(
            &tx,
            &previous.project_chats,
            &next.project_chats,
            |chat| chat.project_id.as_str(),
            "project_chats",
            save_project_chat,
        )?;

        if previous.settings_summary != next.settings_summary {
            save_setting(&tx, "settings_summary", &next.settings_summary)?;
        }
        if previous.model_summary != next.model_summary {
            save_setting(&tx, "model_summary", &next.model_summary)?;
        }
        if previous.model_settings != next.model_settings {
            save_setting(&tx, "model_settings", &next.model_settings)?;
        }
        if previous.terminal_command_profiles != next.terminal_command_profiles {
            save_setting(
                &tx,
                "terminal_command_profiles",
                &next.terminal_command_profiles,
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn requirement_sessions(&self, requirement_id: &str) -> Result<Vec<String>, AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        let mut statement = conn.prepare(
            "SELECT session_file FROM requirement_sessions
             WHERE requirement_id = ?1 ORDER BY created_at",
        )?;
        let rows = statement.query_map([requirement_id], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(crate) fn lock_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("db lock poisoned")
    }
}

fn retry_busy_database_operation(previous_attempts: i32) -> bool {
    if previous_attempts >= 3 {
        return false;
    }
    std::thread::sleep(std::time::Duration::from_millis(
        25 * u64::try_from(previous_attempts + 1).unwrap_or(1),
    ));
    true
}

fn archive_legacy_database(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }
    let conn = Connection::open(path)?;
    let has_schema_version = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !has_schema_version {
        return Ok(());
    }
    let version = conn.query_row("SELECT MAX(version) FROM schema_version", [], |row| {
        row.get::<_, Option<i64>>(0)
    })?;
    if version != Some(LEGACY_SCHEMA_VERSION) {
        return Ok(());
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    drop(conn);

    let data_root = path
        .parent()
        .ok_or_else(|| AppError::internal("数据库路径缺少父目录"))?;
    let archive_root = data_root.join("archive");
    fs::create_dir_all(&archive_root)?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let archive_dir = unique_archive_directory(&archive_root, &format!("workflow-v4-{timestamp}"));
    fs::create_dir(&archive_dir)?;
    fs::copy(path, archive_dir.join("data.db"))?;
    let manifest = serde_json::json!({
        "schema_version": LEGACY_SCHEMA_VERSION,
        "archived_at": Utc::now(),
        "source": "data.db",
        "mode": "byte_archive_before_workflow_v5",
    });
    fs::write(
        archive_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::remove_file(path)?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        if sidecar.exists() {
            fs::remove_file(sidecar)?;
        }
    }
    Ok(())
}

fn unique_archive_directory(root: &Path, stem: &str) -> PathBuf {
    let initial = root.join(stem);
    if !initial.exists() {
        return initial;
    }
    (1..)
        .map(|suffix| root.join(format!("{stem}-{suffix}")))
        .find(|candidate| !candidate.exists())
        .expect("archive suffix space exhausted")
}

fn sync_by_id<T, F, S>(
    tx: &Transaction<'_>,
    previous: &[T],
    next: &[T],
    id: F,
    table: &str,
    save: S,
) -> Result<(), AppError>
where
    T: PartialEq,
    F: Fn(&T) -> &str,
    S: Fn(&Transaction<'_>, &T) -> Result<(), AppError>,
{
    let next_ids = next.iter().map(&id).collect::<HashSet<_>>();
    for old in previous {
        if !next_ids.contains(id(old)) {
            tx.execute(
                &format!("DELETE FROM {table} WHERE {} = ?1", primary_key(table)),
                [id(old)],
            )?;
        }
    }
    for item in next {
        if previous
            .iter()
            .find(|old| id(old) == id(item))
            .is_none_or(|old| old != item)
        {
            save(tx, item)?;
        }
    }
    Ok(())
}

fn primary_key(table: &str) -> &'static str {
    match table {
        "project_chats" => "project_id",
        _ => "id",
    }
}

fn save_project(tx: &Transaction<'_>, project: &Project) -> Result<(), AppError> {
    tx.execute(
        "INSERT OR REPLACE INTO projects
         (id, name, git_url, local_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            project.id,
            project.name,
            project.git_url,
            project.local_path,
            project.created_at.to_rfc3339(),
            project.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn save_requirement(tx: &Transaction<'_>, requirement: &Requirement) -> Result<(), AppError> {
    let mut persisted = requirement.clone();
    for message in &mut persisted.messages {
        message.metadata = message
            .metadata
            .as_ref()
            .map(|value| compact_trace(value).unwrap_or_else(|| value.clone()));
    }
    tx.execute(
        "INSERT INTO requirements
         (id, project_id, title, original_message, status, messages,
          clarification_round, clarifications, draft, analysis_revision, active_prompt,
          clarification_history, pi_session_file, error, queued_at, created_at,
          updated_at, origin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           title = excluded.title,
           original_message = excluded.original_message,
           status = excluded.status,
           messages = excluded.messages,
           clarification_round = excluded.clarification_round,
           clarifications = excluded.clarifications,
           draft = excluded.draft,
           analysis_revision = excluded.analysis_revision,
           active_prompt = excluded.active_prompt,
           clarification_history = excluded.clarification_history,
           pi_session_file = excluded.pi_session_file,
           error = excluded.error,
           queued_at = excluded.queued_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           origin = excluded.origin",
        params![
            persisted.id,
            persisted.project_id,
            persisted.title,
            persisted.original_message,
            status_text(persisted.status)?,
            serde_json::to_string(&persisted.messages)?,
            persisted.clarification_round,
            serde_json::to_string(&persisted.clarifications)?,
            optional_json(&persisted.draft)?,
            persisted.analysis_revision,
            optional_json(&persisted.active_prompt)?,
            serde_json::to_string(&persisted.clarification_history)?,
            persisted.pi_session_file,
            persisted.error,
            persisted.queued_at.map(|value| value.to_rfc3339()),
            persisted.created_at.to_rfc3339(),
            persisted.updated_at.to_rfc3339(),
            serde_json::to_string(&persisted.origin)?.trim_matches('"'),
        ],
    )?;
    if let Some(session_file) = requirement.pi_session_file.as_deref() {
        tx.execute(
            "INSERT OR IGNORE INTO requirement_sessions
             (requirement_id, session_file, created_at) VALUES (?1, ?2, ?3)",
            params![
                requirement.id,
                session_file,
                requirement.updated_at.to_rfc3339()
            ],
        )?;
    }
    Ok(())
}

fn compact_trace(value: &Value) -> Option<Value> {
    let trace = value.get("trace")?.as_object()?;
    let mut compact = Map::new();
    for key in ["usage", "statuses", "completed", "live", "prompt"] {
        if let Some(value) = trace.get(key) {
            compact.insert(key.to_owned(), value.clone());
        }
    }
    Some(serde_json::json!({
        "type": value.get("type").and_then(Value::as_str).unwrap_or("pi_trace"),
        "version": value.get("version").and_then(Value::as_u64).unwrap_or(1),
        "trace": compact,
        "compacted": true,
    }))
}

fn save_project_chat(tx: &Transaction<'_>, chat: &ProjectChat) -> Result<(), AppError> {
    let mut messages = chat.messages.clone();
    for message in &mut messages {
        message.metadata = message
            .metadata
            .as_ref()
            .map(|value| compact_trace(value).unwrap_or_else(|| value.clone()));
    }
    tx.execute(
        "INSERT OR REPLACE INTO project_chats
         (project_id, messages, running, error, pi_session_file, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            chat.project_id,
            serde_json::to_string(&messages)?,
            i64::from(chat.running),
            chat.error,
            chat.pi_session_file,
            chat.created_at.to_rfc3339(),
            chat.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn save_setting<T: serde::Serialize>(
    tx: &Transaction<'_>,
    key: &str,
    value: &T,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

fn load_projects(conn: &Connection) -> Result<Vec<Project>, AppError> {
    let mut statement =
        conn.prepare("SELECT id, name, git_url, local_path, created_at, updated_at FROM projects")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut projects = Vec::new();
    for row in rows {
        let (id, name, git_url, local_path, created_at, updated_at) = row?;
        projects.push(Project {
            id,
            name,
            git_url,
            local_path,
            created_at: parse_date(&created_at, "projects.created_at")?,
            updated_at: parse_date(&updated_at, "projects.updated_at")?,
        });
    }
    Ok(projects)
}

#[allow(clippy::type_complexity)]
fn load_requirements(conn: &Connection) -> Result<Vec<Requirement>, AppError> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, title, original_message, status, messages,
                clarification_round, clarifications, draft, analysis_revision, active_prompt,
                clarification_history, pi_session_file, error, queued_at,
                created_at, updated_at, origin
         FROM requirements ORDER BY created_at, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, u32>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, u32>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, String>(11)?,
            row.get::<_, Option<String>>(12)?,
            row.get::<_, Option<String>>(13)?,
            row.get::<_, Option<String>>(14)?,
            row.get::<_, String>(15)?,
            row.get::<_, String>(16)?,
            row.get::<_, String>(17)?,
        ))
    })?;
    let mut requirements = Vec::new();
    for row in rows {
        let (
            id,
            project_id,
            title,
            original_message,
            status,
            messages,
            clarification_round,
            clarifications,
            draft,
            analysis_revision,
            active_prompt,
            clarification_history,
            pi_session_file,
            error,
            queued_at,
            created_at,
            updated_at,
            origin,
        ) = row?;
        requirements.push(Requirement {
            id,
            project_id,
            title,
            original_message,
            origin: parse_json(&format!("\"{origin}\""), "requirements.origin")?,
            status: parse_json(&format!("\"{status}\""), "requirements.status")?,
            messages: parse_json(&messages, "requirements.messages")?,
            clarification_round,
            clarifications: parse_json(&clarifications, "requirements.clarifications")?,
            draft: parse_optional_json(draft, "requirements.draft")?,
            analysis_revision,
            active_prompt: parse_optional_json(active_prompt, "requirements.active_prompt")?,
            clarification_history: parse_json(
                &clarification_history,
                "requirements.clarification_history",
            )?,
            pi_session_file,
            error,
            queued_at: queued_at
                .map(|value| parse_date(&value, "requirements.queued_at"))
                .transpose()?,
            created_at: parse_date(&created_at, "requirements.created_at")?,
            updated_at: parse_date(&updated_at, "requirements.updated_at")?,
        });
    }
    Ok(requirements)
}

fn load_project_chats(conn: &Connection) -> Result<Vec<ProjectChat>, AppError> {
    let mut statement = conn.prepare(
        "SELECT project_id, messages, running, error, pi_session_file, created_at, updated_at
         FROM project_chats",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    let mut chats = Vec::new();
    for row in rows {
        let (project_id, messages, running, error, pi_session_file, created_at, updated_at) = row?;
        chats.push(ProjectChat {
            project_id,
            messages: parse_json(&messages, "project_chats.messages")?,
            running: running != 0,
            error,
            pi_session_file,
            created_at: parse_date(&created_at, "project_chats.created_at")?,
            updated_at: parse_date(&updated_at, "project_chats.updated_at")?,
        });
    }
    Ok(chats)
}

fn load_settings(conn: &Connection) -> Result<Vec<(String, String)>, AppError> {
    let mut statement = conn.prepare("SELECT key, value FROM settings")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn setting_or_default<T: DeserializeOwned>(
    settings: &[(String, String)],
    key: &str,
    default: T,
) -> Result<T, AppError> {
    settings
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| parse_json(value, key))
        .transpose()
        .map(|value| value.unwrap_or(default))
}

fn status_text(status: RequirementStatus) -> Result<String, AppError> {
    Ok(serde_json::to_string(&status)?.trim_matches('"').to_owned())
}

fn optional_json<T: serde::Serialize>(value: &Option<T>) -> Result<Option<String>, AppError> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(Into::into)
}

fn parse_optional_json<T: DeserializeOwned>(
    value: Option<String>,
    field: &str,
) -> Result<Option<T>, AppError> {
    value.map(|value| parse_json(&value, field)).transpose()
}

fn parse_json<T: DeserializeOwned>(value: &str, field: &str) -> Result<T, AppError> {
    serde_json::from_str(value)
        .map_err(|error| AppError::internal(format!("数据库字段 {field} 损坏：{error}")))
}

fn parse_date(value: &str, field: &str) -> Result<DateTime<Utc>, AppError> {
    value
        .parse()
        .map_err(|error| AppError::internal(format!("数据库字段 {field} 损坏：{error}")))
}
