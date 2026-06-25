use std::path::Path;

use rusqlite::Connection;

use crate::error::AppError;
use crate::models::{AppData, Project, Requirement, RequirementStatus};

/// Minimal SQLite persistence layer.
/// Designed as write-through: the in-memory `AppData` is the source of truth,
/// and every mutation also writes to the DB for crash recovery.
pub struct Database {
    conn: std::sync::Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(path)?;
        let db = Self {
            conn: std::sync::Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute_batch(
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
                execution_plan TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            INSERT OR IGNORE INTO schema_version (version) VALUES (1);
            ",
        )?;
        Ok(())
    }

    // --- Projects ---

    pub fn load_projects(&self) -> Result<Vec<Project>, AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, name, git_url, local_path, created_at, updated_at FROM projects",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                git_url: row.get(2)?,
                local_path: row.get(3)?,
                created_at: row.get::<_, String>(4)?.parse().unwrap_or_default(),
                updated_at: row.get::<_, String>(5)?.parse().unwrap_or_default(),
            })
        })?;
        let mut projects = Vec::new();
        for row in rows {
            projects.push(row?);
        }
        Ok(projects)
    }

    pub fn save_project(&self, project: &Project) -> Result<(), AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute(
            "INSERT OR REPLACE INTO projects (id, name, git_url, local_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
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

    pub fn delete_project(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute("DELETE FROM projects WHERE id = ?1", rusqlite::params![id])?;
        conn.execute(
            "DELETE FROM requirements WHERE project_id = ?1",
            rusqlite::params![id],
        )?;
        Ok(())
    }

    // --- Requirements ---

    pub fn load_requirements(&self) -> Result<Vec<Requirement>, AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, original_message, status, messages,
                    clarification_round, clarifications, draft, execution_plan, error,
                    created_at, updated_at
             FROM requirements",
        )?;
        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(4)?;
            Ok(Requirement {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                original_message: row.get(3)?,
                status: serde_json::from_str(&format!("\"{}\"", status_str))
                    .unwrap_or(RequirementStatus::Failed),
                messages: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                clarification_round: row.get(6)?,
                clarifications: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                draft: row
                    .get::<_, Option<String>>(8)?
                    .and_then(|v| serde_json::from_str(&v).ok()),
                execution_plan: row
                    .get::<_, Option<String>>(9)?
                    .and_then(|v| serde_json::from_str(&v).ok()),
                error: row.get(10)?,
                created_at: row.get::<_, String>(11)?.parse().unwrap_or_default(),
                updated_at: row.get::<_, String>(12)?.parse().unwrap_or_default(),
                pi_session_file: None,
            })
        })?;
        let mut requirements = Vec::new();
        for row in rows {
            requirements.push(row?);
        }
        Ok(requirements)
    }

    pub fn save_requirement(&self, req: &Requirement) -> Result<(), AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute(
            "INSERT OR REPLACE INTO requirements
             (id, project_id, title, original_message, status, messages,
              clarification_round, clarifications, draft, execution_plan, error,
              created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                req.id,
                req.project_id,
                req.title,
                req.original_message,
                serde_json::to_string(&req.status)
                    .unwrap_or_default()
                    .trim_matches('"'),
                serde_json::to_string(&req.messages).unwrap_or_default(),
                req.clarification_round,
                serde_json::to_string(&req.clarifications).unwrap_or_default(),
                req.draft
                    .as_ref()
                    .map(|d| serde_json::to_string(d).unwrap_or_default()),
                req.execution_plan
                    .as_ref()
                    .map(|p| serde_json::to_string(p).unwrap_or_default()),
                req.error,
                req.created_at.to_rfc3339(),
                req.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    // --- Settings ---

    pub fn load_settings(&self) -> Result<serde_json::Value, AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let mut map = serde_json::Map::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (key, value) = row?;
            if let Ok(v) = serde_json::from_str(&value) {
                map.insert(key, v);
            }
        }
        Ok(serde_json::Value::Object(map))
    }

    pub fn save_settings_json(&self, key: &str, value: &str) -> Result<(), AppError> {
        let conn = self.conn.lock().expect("db lock poisoned");
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn save_model_settings(&self, value: &str) -> Result<(), AppError> {
        self.save_settings_json("model_settings", value)
    }

    pub fn save_app_data_metadata(&self, data: &AppData) -> Result<(), AppError> {
        self.save_settings_json(
            "settings_summary",
            &serde_json::to_string(&data.settings_summary)?,
        )?;
        self.save_settings_json(
            "model_summary",
            &serde_json::to_string(&data.model_summary)?,
        )?;
        Ok(())
    }

    /// Bulk-save all data (used on initial migration from app.json).
    pub fn save_all(&self, data: &AppData) -> Result<(), AppError> {
        for project in &data.projects {
            self.save_project(project)?;
        }
        for req in &data.requirements {
            self.save_requirement(req)?;
        }
        self.save_app_data_metadata(data)?;
        if data.model_settings.low.model_id.is_some()
            || data.model_settings.medium.model_id.is_some()
            || data.model_settings.high.model_id.is_some()
        {
            self.save_model_settings(&serde_json::to_string(&data.model_settings)?)?;
        }
        Ok(())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            value.to_string(),
        ))
    }
}
