use std::{collections::HashSet, path::Path};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, Transaction, params};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::AppError;
use crate::models::{
    AppData, ModelSettings, Project, ProjectChat, Requirement, RequirementStatus, SummaryNode,
    TerminalCommandProfile,
};

const SCHEMA_VERSION: i64 = 3;

pub struct Database {
    conn: std::sync::Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(path)?;
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
                execution_plan TEXT,
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
                requirement_summary TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
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
            1 => {
                let version = *unique_versions.iter().next().expect("one unique version");
                if !(1..=SCHEMA_VERSION).contains(&version) {
                    return Err(AppError::internal(format!("不支持的数据库版本：{version}")));
                }
            }
            _ => return Err(AppError::internal("数据库 schema_version 记录损坏")),
        }
        add_column_if_missing(&tx, "requirements", "queued_at", "TEXT")?;
        add_column_if_missing(&tx, "requirements", "pi_session_file", "TEXT")?;
        add_column_if_missing(
            &tx,
            "requirements",
            "analysis_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&tx, "requirements", "active_prompt", "TEXT")?;
        add_column_if_missing(
            &tx,
            "requirements",
            "clarification_history",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        add_column_if_missing(
            &tx,
            "requirements",
            "origin",
            "TEXT NOT NULL DEFAULT 'standalone'",
        )?;
        add_column_if_missing(&tx, "project_chats", "requirement_summary", "TEXT")?;
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
}

fn add_column_if_missing(
    tx: &Transaction<'_>,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), AppError> {
    let mut statement = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    tx.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
    ))?;
    Ok(())
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
    if let Some(plan) = persisted.execution_plan.as_mut() {
        for task in &mut plan.tasks {
            task.trace = task.trace.as_ref().and_then(compact_trace);
        }
    }
    tx.execute(
        "INSERT INTO requirements
         (id, project_id, title, original_message, status, messages,
          clarification_round, clarifications, draft, analysis_revision, active_prompt,
          clarification_history, execution_plan, pi_session_file, error, queued_at, created_at,
          updated_at)
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
           execution_plan = excluded.execution_plan,
           pi_session_file = excluded.pi_session_file,
           error = excluded.error,
           queued_at = excluded.queued_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
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
            optional_json(&persisted.execution_plan)?,
            persisted.pi_session_file,
            persisted.error,
            persisted.queued_at.map(|value| value.to_rfc3339()),
            persisted.created_at.to_rfc3339(),
            persisted.updated_at.to_rfc3339(),
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
         (project_id, messages, running, error, pi_session_file, requirement_summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            chat.project_id,
            serde_json::to_string(&messages)?,
            i64::from(chat.running),
            chat.error,
            chat.pi_session_file,
            optional_json(&chat.requirement_summary)?,
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
                clarification_history, execution_plan, pi_session_file, error, queued_at,
                created_at, updated_at
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
            row.get::<_, Option<String>>(15)?,
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
            execution_plan,
            pi_session_file,
            error,
            queued_at,
            created_at,
            updated_at,
        ) = row?;
        requirements.push(Requirement {
            id,
            project_id,
            title,
            original_message,
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
            execution_plan: parse_optional_json(execution_plan, "requirements.execution_plan")?,
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
        "SELECT project_id, messages, running, error, pi_session_file, requirement_summary, created_at, updated_at
         FROM project_chats",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let mut chats = Vec::new();
    for row in rows {
        let (
            project_id,
            messages,
            running,
            error,
            pi_session_file,
            requirement_summary,
            created_at,
            updated_at,
        ) = row?;
        chats.push(ProjectChat {
            project_id,
            messages: parse_json(&messages, "project_chats.messages")?,
            running: running != 0,
            error,
            pi_session_file,
            requirement_summary: requirement_summary
                .map(|value| parse_json(&value, "project_chats.requirement_summary"))
                .transpose()?,
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
