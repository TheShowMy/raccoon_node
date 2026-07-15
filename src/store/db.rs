use std::{collections::HashSet, path::Path};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, Transaction, params};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::AppError;
use crate::models::{
    ModelSettings, ProjectChat, ProjectChatMessage, ProjectChatMessageRole,
    ProjectChatMessageSource, Requirement, RequirementFailureStage, RequirementMessageRole,
    RequirementStatus, StoreState, SummaryNode, TerminalCommandProfile,
};

pub struct Database {
    conn: std::sync::Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, AppError> {
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
        db.initialize_schema()?;
        Ok(db)
    }

    fn initialize_schema(&self) -> Result<(), AppError> {
        let mut conn = self.conn.lock().expect("db lock poisoned");
        let tx = conn.transaction()?;
        if has_application_schema(&tx)? {
            validate_schema_fingerprint(&tx)?;
            tx.commit()?;
            return Ok(());
        }
        tx.execute_batch(include_str!("schema.sql"))?;
        let fingerprint = expected_schema_fingerprint()?;
        tx.execute(
            "INSERT INTO schema_meta (fingerprint) VALUES (?1)",
            [&fingerprint],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load(&self) -> Result<StoreState, AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        validate_schema_fingerprint(&conn)?;

        let settings = load_settings(&conn)?;
        let mut requirements = load_requirements(&conn)?;
        let project_chats = load_project_chats(&conn)?;
        if let Some(chat) = project_chats.first() {
            for requirement in &mut requirements {
                requirement.messages = chat
                    .messages
                    .iter()
                    .filter(|message| {
                        message.source == ProjectChatMessageSource::Requirement
                            && message.requirement_id.as_deref() == Some(requirement.id.as_str())
                    })
                    .map(|message| crate::models::RequirementMessage {
                        role: match message.role {
                            ProjectChatMessageRole::User => RequirementMessageRole::User,
                            ProjectChatMessageRole::Assistant => RequirementMessageRole::Assistant,
                            ProjectChatMessageRole::System => RequirementMessageRole::System,
                            ProjectChatMessageRole::Trace => RequirementMessageRole::Trace,
                        },
                        content: message.content.clone(),
                        references: message.references.clone(),
                        images: message.images.clone(),
                        metadata: message.metadata.clone(),
                        created_at: message.created_at,
                    })
                    .collect();
            }
        }
        Ok(StoreState {
            requirements,
            project_chats,
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

    pub fn save_state(&self, next: &StoreState) -> Result<(), AppError> {
        let mut conn = self.conn.lock().expect("db lock poisoned");
        let tx = conn.transaction()?;

        replace_table(
            &tx,
            &next.requirements,
            |requirement| requirement.id.as_str(),
            "requirements",
            save_requirement,
        )?;
        tx.execute("DELETE FROM project_chats", [])?;
        let mut next = next.clone();
        if next.project_chats.is_empty() {
            next.project_chats.push(ProjectChat::default());
        }
        if let Some(chat) = next.project_chats.first_mut() {
            chat.messages
                .retain(|message| message.source != ProjectChatMessageSource::Requirement);
            for requirement in &next.requirements {
                for message in &requirement.messages {
                    chat.messages.push(ProjectChatMessage {
                        role: match message.role {
                            RequirementMessageRole::User => ProjectChatMessageRole::User,
                            RequirementMessageRole::Assistant => ProjectChatMessageRole::Assistant,
                            RequirementMessageRole::System => ProjectChatMessageRole::System,
                            RequirementMessageRole::Trace => ProjectChatMessageRole::Trace,
                        },
                        content: message.content.clone(),
                        references: message.references.clone(),
                        images: message.images.clone(),
                        source: ProjectChatMessageSource::Requirement,
                        requirement_id: Some(requirement.id.clone()),
                        metadata: message.metadata.clone(),
                        created_at: message.created_at,
                    });
                }
            }
            chat.messages.sort_by_key(|message| message.created_at);
        }
        for chat in &next.project_chats {
            save_project_chat(&tx, chat)?;
        }

        save_setting(&tx, "settings_summary", &next.settings_summary)?;
        save_setting(&tx, "model_summary", &next.model_summary)?;
        save_setting(&tx, "model_settings", &next.model_settings)?;
        save_setting(
            &tx,
            "terminal_command_profiles",
            &next.terminal_command_profiles,
        )?;

        tx.commit()?;
        Ok(())
    }

    pub(crate) fn lock_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("db lock poisoned")
    }
}

fn has_application_schema(conn: &Connection) -> Result<bool, AppError> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index')",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(count > 0)
}

fn validate_schema_fingerprint(conn: &Connection) -> Result<(), AppError> {
    let stored = conn
        .query_row("SELECT fingerprint FROM schema_meta", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|_| {
            AppError::internal("数据库结构不属于当前构建，请删除项目的 .raccoon-node 后重新启动")
        })?;
    let actual = current_schema_fingerprint(conn)?;
    let expected = expected_schema_fingerprint()?;
    if stored != actual || stored != expected {
        return Err(AppError::internal(
            "数据库结构与当前构建不一致，请删除项目的 .raccoon-node 后重新启动",
        ));
    }
    Ok(())
}

fn expected_schema_fingerprint() -> Result<String, AppError> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(include_str!("schema.sql"))?;
    current_schema_fingerprint(&conn)
}

fn current_schema_fingerprint(conn: &Connection) -> Result<String, AppError> {
    let mut statement = conn.prepare(
        "SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_meta'
         ORDER BY type, name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        ))
    })?;
    let mut hash = 0xcbf29ce484222325_u64;
    for row in rows {
        let (kind, name, sql) = row?;
        for byte in kind
            .bytes()
            .chain([0])
            .chain(name.bytes())
            .chain([0])
            .chain(sql.bytes())
            .chain([0xff])
        {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("{hash:016x}"))
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

fn replace_table<T, F, S>(
    tx: &Transaction<'_>,
    next: &[T],
    id: F,
    table: &str,
    save: S,
) -> Result<(), AppError>
where
    F: Fn(&T) -> &str,
    S: Fn(&Transaction<'_>, &T) -> Result<(), AppError>,
{
    let key = primary_key(table);
    let existing_ids = {
        let mut statement = tx.prepare(&format!("SELECT {key} FROM {table}"))?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?
    };
    let next_ids = next.iter().map(&id).collect::<HashSet<_>>();
    for existing_id in existing_ids {
        if !next_ids.contains(existing_id.as_str()) {
            tx.execute(
                &format!("DELETE FROM {table} WHERE {key} = ?1"),
                [existing_id],
            )?;
        }
    }
    for item in next {
        save(tx, item)?;
    }
    Ok(())
}

fn primary_key(table: &str) -> &'static str {
    debug_assert_eq!(table, "requirements");
    "id"
}

fn save_requirement(tx: &Transaction<'_>, requirement: &Requirement) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO requirements
         (id, title, status,
          clarification_round, clarifications, draft, analysis_revision, active_prompt,
          clarification_history, pi_session_file, error, failure_stage, failure_code,
          queued_at, created_at, updated_at, origin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           clarification_round = excluded.clarification_round,
           clarifications = excluded.clarifications,
           draft = excluded.draft,
           analysis_revision = excluded.analysis_revision,
           active_prompt = excluded.active_prompt,
           clarification_history = excluded.clarification_history,
           pi_session_file = excluded.pi_session_file,
           error = excluded.error,
           failure_stage = excluded.failure_stage,
           failure_code = excluded.failure_code,
           queued_at = excluded.queued_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           origin = excluded.origin",
        params![
            requirement.id,
            requirement.title,
            status_text(requirement.status)?,
            requirement.clarification_round,
            serde_json::to_string(&requirement.clarifications)?,
            optional_json(&requirement.draft)?,
            requirement.analysis_revision,
            optional_json(&requirement.active_prompt)?,
            serde_json::to_string(&requirement.clarification_history)?,
            requirement.pi_session_file,
            requirement.error,
            requirement
                .failure_stage
                .map(requirement_failure_stage_text)
                .transpose()?,
            requirement.failure_code,
            requirement.queued_at.map(|value| value.to_rfc3339()),
            requirement.created_at.to_rfc3339(),
            requirement.updated_at.to_rfc3339(),
            serde_json::to_string(&requirement.origin)?.trim_matches('"'),
        ],
    )?;
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
        "trace": compact,
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
         (singleton_key, messages, mode, active_requirement_id, running, error, pi_session_file, created_at, updated_at)
         VALUES ('chat', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            serde_json::to_string(&messages)?,
            serde_json::to_string(&chat.mode)?.trim_matches('"'),
            chat.active_requirement_id,
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

#[allow(clippy::type_complexity)]
fn load_requirements(conn: &Connection) -> Result<Vec<Requirement>, AppError> {
    let mut statement = conn.prepare(
        "SELECT id, title, status,
                clarification_round, clarifications, draft, analysis_revision, active_prompt,
                clarification_history, pi_session_file, error, failure_stage, failure_code,
                queued_at, created_at, updated_at, origin
         FROM requirements ORDER BY created_at, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, u32>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, u32>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
            row.get::<_, Option<String>>(13)?,
            row.get::<_, String>(14)?,
            row.get::<_, String>(15)?,
            row.get::<_, String>(16)?,
        ))
    })?;
    let mut requirements = Vec::new();
    for row in rows {
        let (
            id,
            title,
            status,
            clarification_round,
            clarifications,
            draft,
            analysis_revision,
            active_prompt,
            clarification_history,
            pi_session_file,
            error,
            failure_stage,
            failure_code,
            queued_at,
            created_at,
            updated_at,
            origin,
        ) = row?;
        requirements.push(Requirement {
            id,
            title,
            origin: parse_json(&format!("\"{origin}\""), "requirements.origin")?,
            status: parse_json(&format!("\"{status}\""), "requirements.status")?,
            messages: Vec::new(),
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
            failure_stage: failure_stage
                .map(|value| parse_json(&format!("\"{value}\""), "requirements.failure_stage"))
                .transpose()?,
            failure_code,
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
        "SELECT messages, mode, active_requirement_id, running, error, pi_session_file, created_at, updated_at
         FROM project_chats",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let mut chats = Vec::new();
    for row in rows {
        let (
            messages,
            mode,
            active_requirement_id,
            running,
            error,
            pi_session_file,
            created_at,
            updated_at,
        ) = row?;
        chats.push(ProjectChat {
            messages: parse_json(&messages, "project_chats.messages")?,
            mode: parse_json(&format!("\"{mode}\""), "project_chats.mode")?,
            active_requirement_id,
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

fn requirement_failure_stage_text(stage: RequirementFailureStage) -> Result<String, AppError> {
    Ok(serde_json::to_string(&stage)?.trim_matches('"').to_owned())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_uses_a_stable_schema_fingerprint() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("data.db");
        let database = Database::open(&path).unwrap();
        let connection = database.lock_connection();
        let stored: String = connection
            .query_row("SELECT fingerprint FROM schema_meta", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, current_schema_fingerprint(&connection).unwrap());
    }

    #[test]
    fn existing_unidentified_schema_is_rejected_without_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("data.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE old_data (id TEXT PRIMARY KEY);")
            .unwrap();
        drop(connection);
        let error = Database::open(&path).err().expect("old schema must fail");
        assert!(error.to_string().contains("删除项目的 .raccoon-node"));
        let connection = Connection::open(&path).unwrap();
        let old_table: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'old_data')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(old_table);
    }
}
