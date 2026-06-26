use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use chrono::Utc;

use crate::error::AppError;
use crate::models::{
    AppData, ClarificationAnswer, ModelSettings, PiModel, Project, ProjectCanvasResponse,
    ProjectChat, ProjectChatInput, ProjectChatMessage, ProjectChatMessageRole, ProjectChatOutput,
    ProjectChatResponse, Requirement, RequirementAnalysisInput, RequirementAnalysisOutput,
    RequirementConversationItem, RequirementConversationPrompt, RequirementConversationResponse,
    RequirementExecutionPlan, RequirementMessage, RequirementMessageRole, RequirementNoticeLevel,
    RequirementPlanInput, RequirementProcessStatus, RequirementRecoveryStage,
    RequirementReviewStatus, RequirementStatus, RequirementTaskExecutionInput,
    RequirementTaskExecutionOutput, RequirementTaskKind, RequirementTaskStatus,
};
use crate::requirement_execution::effective_model_tier;
use crate::utils::{
    build_clarification_answer_summary, clarification_has_answer, clone_git_repo,
    data_root_from_file, derive_requirement_title, ensure_child_path, normalize_local_path,
    remove_dir_if_exists, slugify, sort_requirements_desc, validate_git_url,
    validate_model_settings, write_json,
};

const MAX_REVIEW_REJECTIONS: u32 = 5;
const MAX_EXECUTION_FAILURES: u32 = 4;
const PI_SESSION_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RESTART_INTERRUPTION: &str = "应用重启中断";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskExecutionDisposition {
    Continue,
    FinalFailure,
}

pub enum ProjectScheduleAction {
    Plan {
        requirement_id: String,
        input: Box<RequirementPlanInput>,
    },
    Execute {
        requirement_id: String,
    },
}

pub struct JsonStore {
    pub path: PathBuf,
    pub data_root: PathBuf,
    pub data: AppData,
    pub db: Option<crate::db::Database>,
}

impl JsonStore {
    pub async fn open(path: PathBuf) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let data_root = data_root_from_file(&path)?;
        let db_path = data_root.join("data.db");
        let db = crate::db::Database::open(&db_path).ok();

        // If a legacy app.json exists, migrate it to SQLite once.
        if path.exists() {
            let content = tokio::fs::read_to_string(&path).await?;
            let mut data: AppData = serde_json::from_str(&content)?;
            let paths_changed = normalize_stored_paths(&mut data)?;

            // Migrate to SQLite if DB is available.
            if let Some(ref db) = db {
                if db.save_all(&data).is_ok() {
                    tracing::info!("migrated app.json data to SQLite");
                    // Rename the old JSON so we don't re-migrate on restart.
                    let migrated_path = path.with_extension("json.migrated");
                    let _ = tokio::fs::rename(&path, &migrated_path).await;
                }
            }

            for requirement in &mut data.requirements {
                if requirement.status == RequirementStatus::Completed {
                    continue;
                }
                if let Some(plan) = requirement.execution_plan.as_mut() {
                    for task in &mut plan.tasks {
                        let tier =
                            if task.recovery_stage == RequirementRecoveryStage::HighTierExecution {
                                crate::models::RequirementModelTier::High
                            } else {
                                effective_model_tier(task.kind)
                            };
                        task.model_tier = tier;
                    }
                }
            }

            if paths_changed {
                write_json(&path, &data).await?;
            }
            return Ok(Self {
                path,
                data_root,
                data,
                db,
            });
        }

        // No app.json — try loading from SQLite.
        let data = if let Some(ref db) = db {
            let projects = db.load_projects().unwrap_or_default();
            let requirements = db.load_requirements().unwrap_or_default();
            let settings = db.load_settings().ok();
            let model_settings = settings
                .as_ref()
                .and_then(|s| s.get("model_settings"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let settings_summary = settings
                .as_ref()
                .and_then(|s| s.get("settings_summary"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_else(|| crate::models::SummaryNode {
                    title: "设置".to_owned(),
                    description: "基础设置待配置".to_owned(),
                });
            let model_summary = settings
                .as_ref()
                .and_then(|s| s.get("model_summary"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_else(|| crate::models::SummaryNode {
                    title: "模型设置".to_owned(),
                    description: "默认模型待配置".to_owned(),
                });
            AppData {
                projects,
                requirements,
                project_chats: db.load_project_chats().unwrap_or_default(),
                settings_summary,
                model_summary,
                model_settings,
            }
        } else {
            AppData::default()
        };

        // Write initial app.json for backwards compat / debugging.
        if db.is_some() {
            write_json(&path, &data).await?;
        }

        Ok(Self {
            path,
            data_root,
            data,
            db,
        })
    }

    /// Write app.json then sync to SQLite.
    async fn write_persist(&self) -> Result<(), AppError> {
        write_json(&self.path, &self.data).await?;
        self.sync_db();
        Ok(())
    }

    /// Persist in-memory state to SQLite (if available).
    fn sync_db(&self) {
        if let Some(ref db) = self.db {
            if let Err(error) = db.save_all(&self.data) {
                tracing::error!("failed to sync data to SQLite: {error}");
            }
        }
    }

    pub fn prepare_project(
        &self,
        raw_name: &str,
        raw_git_url: &str,
    ) -> Result<(String, PathBuf), AppError> {
        let name = raw_name.trim();
        if name.is_empty() {
            return Err(AppError::bad_request("项目名称不能为空"));
        }

        let git_url = raw_git_url.trim();
        validate_git_url(git_url)?;

        if name
            .chars()
            .any(|ch| matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err(AppError::bad_request("项目名称不能包含文件路径非法字符"));
        }

        if self
            .data
            .projects
            .iter()
            .any(|project| project.name.eq_ignore_ascii_case(name))
        {
            return Err(AppError::bad_request("项目名称已存在"));
        }

        let now = Utc::now();
        let id = format!("{}-{}", slugify(name), now.timestamp_millis());
        let project_dir = self.project_dir(&id)?;
        let repo_dir = project_dir.join("repo");
        if repo_dir.exists() {
            return Err(AppError::bad_request("项目本地目录已存在"));
        }

        Ok((id, repo_dir))
    }

    pub async fn commit_project(
        &mut self,
        id: String,
        name: String,
        git_url: String,
        repo_dir: PathBuf,
    ) -> Result<Project, AppError> {
        let now = Utc::now();
        let project = Project {
            id,
            name,
            git_url,
            local_path: repo_dir.to_string_lossy().to_string(),
            created_at: now,
            updated_at: now,
        };

        self.data.projects.push(project.clone());
        self.write_persist().await?;
        Ok(project)
    }

    pub async fn create_project(
        &mut self,
        raw_name: String,
        raw_git_url: String,
    ) -> Result<Project, AppError> {
        let (id, repo_dir) = self.prepare_project(&raw_name, &raw_git_url)?;
        let name = raw_name.trim().to_owned();
        let git_url = raw_git_url.trim().to_owned();

        tokio::fs::create_dir_all(repo_dir.parent().unwrap()).await?;
        if let Err(error) = clone_git_repo(&git_url, &repo_dir).await {
            remove_dir_if_exists(&repo_dir).await?;
            return Err(error);
        }

        self.commit_project(id, name, git_url, repo_dir).await
    }

    pub async fn delete_project(&mut self, id: &str) -> Result<(), AppError> {
        let index = self
            .data
            .projects
            .iter()
            .position(|project| project.id == id)
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let project_dir = self.project_dir(id)?;
        if project_dir.exists() {
            remove_dir_if_exists(&project_dir).await?;
        }

        self.data.projects.remove(index);
        self.data
            .requirements
            .retain(|requirement| requirement.project_id != id);
        self.data.project_chats.retain(|chat| chat.project_id != id);
        self.write_persist().await?;
        if let Some(ref db) = self.db {
            let _ = db.delete_project(id);
        }
        Ok(())
    }

    pub async fn delete_requirement(&mut self, requirement_id: &str) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let project_id = self.data.requirements[index].project_id.clone();
        self.data.requirements.remove(index);
        self.write_persist().await?;
        if let Some(ref db) = self.db {
            let _ = db.delete_requirement(requirement_id);
        }
        Ok(project_id)
    }

    pub async fn save_model_settings(
        &mut self,
        settings: ModelSettings,
        models: &[PiModel],
    ) -> Result<(), AppError> {
        validate_model_settings(&settings, models)?;
        self.data.model_settings = settings;
        self.data.model_summary.description =
            crate::utils::model_summary_description(&self.data.model_settings);
        self.write_persist().await?;
        Ok(())
    }

    pub fn project_canvas(&self, project_id: &str) -> Result<ProjectCanvasResponse, AppError> {
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let mut active = self
            .data
            .requirements
            .iter()
            .filter(|requirement| {
                requirement.project_id == project_id
                    && matches!(
                        requirement.status,
                        RequirementStatus::Analyzing
                            | RequirementStatus::Clarifying
                            | RequirementStatus::DraftReady
                            | RequirementStatus::Failed
                    )
                    && (requirement.status != RequirementStatus::Failed
                        || requirement.draft.is_none())
            })
            .cloned()
            .collect::<Vec<_>>();
        sort_requirements_desc(&mut active);

        let mut queued_requirements = self
            .data
            .requirements
            .iter()
            .filter(|requirement| {
                requirement.project_id == project_id
                    && matches!(
                        requirement.status,
                        RequirementStatus::Queued
                            | RequirementStatus::Planning
                            | RequirementStatus::PlanReady
                            | RequirementStatus::Running
                            | RequirementStatus::Failed
                    )
                    && (requirement.status != RequirementStatus::Failed
                        || requirement.draft.is_some())
            })
            .cloned()
            .collect::<Vec<_>>();
        sort_requirements_desc(&mut queued_requirements);

        let mut completed_requirements = self
            .data
            .requirements
            .iter()
            .filter(|requirement| {
                requirement.project_id == project_id
                    && requirement.status == RequirementStatus::Completed
            })
            .cloned()
            .collect::<Vec<_>>();
        sort_requirements_desc(&mut completed_requirements);

        for requirement in active
            .iter_mut()
            .chain(queued_requirements.iter_mut())
            .chain(completed_requirements.iter_mut())
        {
            requirement.messages.clear();
            if let Some(plan) = requirement.execution_plan.as_mut() {
                for task in plan.tasks.iter_mut() {
                    task.trace = None;
                }
            }
        }

        Ok(ProjectCanvasResponse {
            project,
            active_requirement: active.into_iter().next(),
            queued_requirements,
            completed_requirements,
        })
    }

    pub fn requirement_conversation(
        &self,
        requirement_id: &str,
    ) -> Result<RequirementConversationResponse, AppError> {
        let requirement = self
            .data
            .requirements
            .iter()
            .find(|requirement| requirement.id == requirement_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("需求不存在"))?;

        Ok(build_requirement_conversation(requirement))
    }

    pub async fn project_chat_response(
        &mut self,
        project_id: &str,
    ) -> Result<ProjectChatResponse, AppError> {
        self.ensure_project_chat(project_id).await?;
        self.project_chat_response_inner(project_id)
    }

    pub async fn start_project_chat_message(
        &mut self,
        project_id: &str,
        message: String,
    ) -> Result<(ProjectChatInput, ProjectChatResponse), AppError> {
        self.ensure_project_chat(project_id).await?;
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;
        let index = self.project_chat_index(project_id)?;
        if self.data.project_chats[index].running {
            return Err(AppError::bad_request("项目问答正在回答，请稍后再发送"));
        }

        let now = Utc::now();
        let chat = &mut self.data.project_chats[index];
        chat.messages.push(ProjectChatMessage {
            role: ProjectChatMessageRole::User,
            content: message,
            metadata: None,
            created_at: now,
        });
        chat.running = true;
        chat.error = None;
        chat.updated_at = now;

        let input = ProjectChatInput {
            project,
            messages: chat.messages.clone(),
            model_settings: self.data.model_settings.clone(),
            pi_session_file: chat.pi_session_file.clone(),
        };
        let response = project_chat_response_from(chat);
        self.write_persist().await?;
        Ok((input, response))
    }

    pub async fn apply_project_chat_result(
        &mut self,
        project_id: &str,
        output: Result<ProjectChatOutput, AppError>,
    ) -> Result<ProjectChatResponse, AppError> {
        let index = self.project_chat_index(project_id)?;
        let now = Utc::now();
        let chat = &mut self.data.project_chats[index];
        chat.running = false;
        chat.updated_at = now;
        match output {
            Ok(output) => {
                chat.error = None;
                chat.pi_session_file = output.pi_session_file;
                let content = output.assistant_message.trim();
                if !content.is_empty() {
                    chat.messages.push(ProjectChatMessage {
                        role: ProjectChatMessageRole::Assistant,
                        content: content.to_owned(),
                        metadata: output.trace,
                        created_at: now,
                    });
                }
            }
            Err(error) => {
                chat.error = Some(error.to_string());
            }
        }
        let response = project_chat_response_from(chat);
        self.write_persist().await?;
        Ok(response)
    }

    async fn ensure_project_chat(&mut self, project_id: &str) -> Result<(), AppError> {
        if !self
            .data
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(AppError::not_found("项目不存在"));
        }
        if self
            .data
            .project_chats
            .iter()
            .any(|chat| chat.project_id == project_id)
        {
            return Ok(());
        }

        let now = Utc::now();
        self.data.project_chats.push(ProjectChat {
            project_id: project_id.to_owned(),
            messages: Vec::new(),
            running: false,
            error: None,
            pi_session_file: None,
            created_at: now,
            updated_at: now,
        });
        self.write_persist().await
    }

    fn project_chat_index(&self, project_id: &str) -> Result<usize, AppError> {
        self.data
            .project_chats
            .iter()
            .position(|chat| chat.project_id == project_id)
            .ok_or_else(|| AppError::not_found("项目问答不存在"))
    }

    fn project_chat_response_inner(
        &self,
        project_id: &str,
    ) -> Result<ProjectChatResponse, AppError> {
        let index = self.project_chat_index(project_id)?;
        Ok(project_chat_response_from(&self.data.project_chats[index]))
    }

    pub async fn create_requirement(
        &mut self,
        project_id: &str,
        message: String,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let now = Utc::now();
        let id = format!("requirement-{}", now.timestamp_millis());
        let requirement = Requirement {
            id: id.clone(),
            project_id: project_id.to_owned(),
            title: derive_requirement_title(&message),
            original_message: message.clone(),
            status: RequirementStatus::Analyzing,
            messages: vec![RequirementMessage {
                role: RequirementMessageRole::User,
                content: message,
                metadata: None,
                created_at: now,
            }],
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: None,
            execution_plan: None,
            pi_session_file: None,
            error: None,
            queued_at: None,
            created_at: now,
            updated_at: now,
        };

        let input = RequirementAnalysisInput {
            project,
            messages: requirement.messages.clone(),
            clarifications: requirement.clarifications.clone(),
            draft: None,
            model_settings: self.data.model_settings.clone(),
            pi_session_file: None,
        };
        self.data.requirements.push(requirement);
        self.write_persist().await?;
        Ok((id, input))
    }

    pub async fn append_requirement_message(
        &mut self,
        requirement_id: &str,
        message: String,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        let index = self.requirement_index(requirement_id)?;
        if !matches!(
            self.data.requirements[index].status,
            RequirementStatus::Clarifying
                | RequirementStatus::Analyzing
                | RequirementStatus::Failed
                | RequirementStatus::DraftReady
                | RequirementStatus::Planning
                | RequirementStatus::PlanReady
        ) {
            return Err(AppError::bad_request("当前需求状态不允许继续补充"));
        }

        let project_id = self.data.requirements[index].project_id.clone();
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;
        let now = Utc::now();
        {
            let requirement = &mut self.data.requirements[index];
            requirement.status = RequirementStatus::Analyzing;
            requirement.error = None;
            requirement.clarifications.clear();
            requirement.draft = None;
            requirement.execution_plan = None;
            requirement.updated_at = now;
            requirement.messages.push(RequirementMessage {
                role: RequirementMessageRole::User,
                content: message,
                metadata: None,
                created_at: now,
            });
        }

        let requirement = self.data.requirements[index].clone();
        self.write_persist().await?;
        Ok((
            project_id,
            RequirementAnalysisInput {
                project,
                messages: requirement.messages,
                clarifications: requirement.clarifications,
                draft: requirement.draft,
                model_settings: self.data.model_settings.clone(),
                pi_session_file: requirement.pi_session_file,
            },
        ))
    }

    pub async fn submit_requirement_clarifications(
        &mut self,
        requirement_id: &str,
        answers: Vec<crate::models::ClarificationAnswerRequest>,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        if answers.is_empty() {
            return Err(AppError::bad_request("请先回答澄清问题"));
        }

        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status != RequirementStatus::Clarifying {
            return Err(AppError::bad_request("当前需求不在澄清状态"));
        }

        let project_id = self.data.requirements[index].project_id.clone();
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let mut clarifications = self.data.requirements[index].clarifications.clone();
        for request in answers {
            let clarification = clarifications
                .iter_mut()
                .find(|item| item.id == request.clarification_id)
                .ok_or_else(|| AppError::bad_request("澄清项不存在"))?;
            let answer = ClarificationAnswer {
                selected_options: request.selected_options,
                custom_text: request.custom_text.filter(|text| !text.trim().is_empty()),
            };
            if !clarification_has_answer(clarification, &answer) {
                return Err(AppError::bad_request("澄清答案不能为空"));
            }
            clarification.answer = Some(answer);
        }

        if clarifications
            .iter()
            .any(|clarification| clarification.answer.is_none())
        {
            return Err(AppError::bad_request("请完成全部澄清问题"));
        }

        let summary = build_clarification_answer_summary(&clarifications);
        let now = Utc::now();
        {
            let requirement = &mut self.data.requirements[index];
            requirement.status = RequirementStatus::Analyzing;
            requirement.error = None;
            requirement.clarifications = clarifications;
            requirement.updated_at = now;
            requirement.messages.push(RequirementMessage {
                role: RequirementMessageRole::User,
                content: summary,
                metadata: None,
                created_at: now,
            });
        }

        let requirement = self.data.requirements[index].clone();
        self.write_persist().await?;
        Ok((
            project_id,
            RequirementAnalysisInput {
                project,
                messages: requirement.messages,
                clarifications: requirement.clarifications,
                draft: requirement.draft,
                model_settings: self.data.model_settings.clone(),
                pi_session_file: requirement.pi_session_file,
            },
        ))
    }

    pub async fn apply_requirement_analysis(
        &mut self,
        requirement_id: &str,
        output: Result<RequirementAnalysisOutput, AppError>,
    ) -> Result<(), AppError> {
        let index = self.requirement_index(requirement_id)?;
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        match output {
            Ok(output) => {
                requirement.status = output.status;
                requirement.draft = output.draft;
                if requirement.status == RequirementStatus::DraftReady {
                    requirement.execution_plan = None;
                }
                requirement.pi_session_file = output.pi_session_file;
                requirement.error = output.error;
                requirement.updated_at = now;
                if !output.clarifications.is_empty() {
                    requirement.clarification_round =
                        requirement.clarification_round.saturating_add(1);
                    requirement.clarifications = output.clarifications;
                } else if output.status == RequirementStatus::DraftReady {
                    requirement.clarifications.clear();
                }
                if !output.assistant_message.trim().is_empty() {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Assistant,
                        content: output.assistant_message,
                        metadata: None,
                        created_at: now,
                    });
                }
                if let Some(trace) = output.trace {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Trace,
                        content: "Pi Agent 分析过程".to_owned(),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
            }
            Err(error) => {
                requirement.status = RequirementStatus::Failed;
                requirement.error = Some(error.to_string());
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: format!("需求分析失败：{error}"),
                    metadata: None,
                    created_at: now,
                });
            }
        }
        self.write_persist().await?;
        Ok(())
    }

    pub async fn confirm_requirement(&mut self, requirement_id: &str) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status != RequirementStatus::DraftReady {
            return Err(AppError::bad_request("只有已生成确认卡片的需求才能确认"));
        }
        let now = Utc::now();
        let project_id = self.data.requirements[index].project_id.clone();
        let requirement = &mut self.data.requirements[index];
        requirement.status = RequirementStatus::Queued;
        requirement.error = None;
        requirement.execution_plan = None;
        requirement.queued_at = Some(now);
        requirement.updated_at = now;
        self.write_persist().await?;
        Ok(project_id)
    }

    pub async fn requeue_failed_planning(
        &mut self,
        requirement_id: &str,
    ) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let requirement = &mut self.data.requirements[index];
        if requirement.status != RequirementStatus::Failed
            || requirement.execution_plan.is_some()
            || requirement.draft.is_none()
        {
            return Err(AppError::bad_request(
                "只有执行计划生成失败的需求才能重新规划",
            ));
        }
        requirement.status = RequirementStatus::Queued;
        requirement.error = None;
        requirement.queued_at.get_or_insert(requirement.updated_at);
        requirement.updated_at = Utc::now();
        let project_id = requirement.project_id.clone();
        self.write_persist().await?;
        Ok(project_id)
    }

    pub async fn start_requirement_planning(
        &mut self,
        requirement_id: &str,
    ) -> Result<(String, RequirementPlanInput), AppError> {
        let index = self.requirement_index(requirement_id)?;
        if !matches!(
            self.data.requirements[index].status,
            RequirementStatus::Queued | RequirementStatus::Failed
        ) {
            return Err(AppError::bad_request("只有待执行需求才能生成执行 DAG"));
        }
        let now = Utc::now();
        let project_id = self.data.requirements[index].project_id.clone();
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;
        {
            let requirement = &mut self.data.requirements[index];
            requirement.status = RequirementStatus::Planning;
            requirement.error = None;
            requirement.execution_plan = None;
            requirement.updated_at = now;
        }
        let requirement = self.data.requirements[index].clone();
        let input = RequirementPlanInput {
            project,
            requirement,
            model_settings: self.data.model_settings.clone(),
        };
        self.write_persist().await?;
        Ok((project_id, input))
    }

    pub async fn apply_requirement_execution_plan(
        &mut self,
        requirement_id: &str,
        output: Result<RequirementExecutionPlan, AppError>,
    ) -> Result<(), AppError> {
        let index = self.requirement_index(requirement_id)?;
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        match output {
            Ok(plan) => {
                requirement.status = RequirementStatus::PlanReady;
                requirement.execution_plan = Some(plan);
                requirement.error = None;
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::Assistant,
                    content: "执行 DAG 已生成，开始自动执行。".to_owned(),
                    metadata: None,
                    created_at: now,
                });
            }
            Err(error) => {
                requirement.status = RequirementStatus::Failed;
                requirement.error = Some(error.to_string());
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: format!("执行计划生成失败：{error}"),
                    metadata: None,
                    created_at: now,
                });
            }
        }
        self.write_persist().await?;
        Ok(())
    }

    pub async fn start_requirement_execution(
        &mut self,
        requirement_id: &str,
    ) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status != RequirementStatus::PlanReady {
            return Err(AppError::bad_request(
                "只有已生成执行 DAG 的需求才能开始执行",
            ));
        }
        if self.data.requirements[index].execution_plan.is_none() {
            return Err(AppError::bad_request("执行 DAG 不存在"));
        }
        let now = Utc::now();
        let project_id = self.data.requirements[index].project_id.clone();
        self.data.requirements[index].status = RequirementStatus::Running;
        self.data.requirements[index].error = None;
        self.data.requirements[index].updated_at = now;
        self.write_persist().await?;
        Ok(project_id)
    }

    pub async fn prepare_next_project_action(
        &mut self,
        project_id: &str,
    ) -> Result<Option<ProjectScheduleAction>, AppError> {
        if !self
            .data
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(AppError::not_found("项目不存在"));
        }
        if self.data.requirements.iter().any(|requirement| {
            requirement.project_id == project_id
                && requirement.status == RequirementStatus::Failed
                && requirement.draft.is_some()
        }) {
            return Ok(None);
        }

        let oldest = |status: RequirementStatus| {
            self.data
                .requirements
                .iter()
                .filter(|requirement| {
                    requirement.project_id == project_id && requirement.status == status
                })
                .min_by_key(|requirement| {
                    (
                        requirement.queued_at.unwrap_or(requirement.updated_at),
                        requirement.created_at,
                        requirement.id.clone(),
                    )
                })
                .map(|requirement| requirement.id.clone())
        };

        if let Some(requirement_id) = oldest(RequirementStatus::Running) {
            return Ok(Some(ProjectScheduleAction::Execute { requirement_id }));
        }
        if let Some(requirement_id) = oldest(RequirementStatus::PlanReady) {
            self.start_requirement_execution(&requirement_id).await?;
            return Ok(Some(ProjectScheduleAction::Execute { requirement_id }));
        }
        if self.data.requirements.iter().any(|requirement| {
            requirement.project_id == project_id
                && requirement.status == RequirementStatus::Planning
        }) {
            return Ok(None);
        }
        if let Some(requirement_id) = oldest(RequirementStatus::Queued) {
            let (_, input) = self.start_requirement_planning(&requirement_id).await?;
            return Ok(Some(ProjectScheduleAction::Plan {
                requirement_id,
                input: Box::new(input),
            }));
        }
        Ok(None)
    }

    pub async fn recover_interrupted_requirements(&mut self) -> Result<Vec<String>, AppError> {
        let now = Utc::now();
        let mut changed = false;
        let mut project_ids = HashSet::new();

        for requirement in &mut self.data.requirements {
            if requirement.status == RequirementStatus::Planning {
                requirement.status = RequirementStatus::Queued;
                requirement.error = None;
                requirement.execution_plan = None;
                requirement.queued_at.get_or_insert(requirement.updated_at);
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: format!("执行 DAG 生成因{RESTART_INTERRUPTION}，已重新排队。"),
                    metadata: None,
                    created_at: now,
                });
                changed = true;
            }

            if requirement.status == RequirementStatus::Running {
                let mut interrupted_tasks = Vec::new();
                let mut final_failure = false;
                if let Some(plan) = requirement.execution_plan.as_mut() {
                    for task in &mut plan.tasks {
                        if task.status != RequirementTaskStatus::Running {
                            continue;
                        }

                        let recoverable = register_execution_failure(
                            task,
                            RESTART_INTERRUPTION,
                            RESTART_INTERRUPTION,
                            true,
                        );
                        interrupted_tasks.push((task.title.clone(), recoverable));
                        final_failure |= !recoverable;
                        changed = true;
                    }
                }

                if !interrupted_tasks.is_empty() {
                    requirement.updated_at = now;
                    for (task_title, recoverable) in interrupted_tasks {
                        requirement.messages.push(RequirementMessage {
                            role: RequirementMessageRole::System,
                            content: if recoverable {
                                format!(
                                    "任务「{task_title}」因{RESTART_INTERRUPTION}，将按恢复策略重试。"
                                )
                            } else {
                                format!(
                                    "任务「{task_title}」因{RESTART_INTERRUPTION}，恢复次数已耗尽。"
                                )
                            },
                            metadata: None,
                            created_at: now,
                        });
                    }
                    if final_failure {
                        requirement.status = RequirementStatus::Failed;
                        requirement.error =
                            Some(format!("{RESTART_INTERRUPTION}，任务恢复次数已耗尽"));
                    } else {
                        requirement.error = None;
                    }
                }
            }

            if matches!(
                requirement.status,
                RequirementStatus::Queued
                    | RequirementStatus::PlanReady
                    | RequirementStatus::Running
            ) {
                project_ids.insert(requirement.project_id.clone());
            }
        }

        if changed {
            self.write_persist().await?;
        }
        let mut project_ids = project_ids.into_iter().collect::<Vec<_>>();
        project_ids.sort();
        Ok(project_ids)
    }

    pub async fn recover_interrupted_project_chats(&mut self) -> Result<(), AppError> {
        let now = Utc::now();
        let project_ids = self
            .data
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<HashSet<_>>();
        let mut changed = false;
        let mut removed_project_ids = Vec::new();
        self.data.project_chats.retain(|chat| {
            let keep = project_ids.contains(chat.project_id.as_str());
            if !keep {
                removed_project_ids.push(chat.project_id.clone());
                changed = true;
            }
            keep
        });
        for chat in &mut self.data.project_chats {
            if chat.running {
                chat.running = false;
                chat.error = Some(format!(
                    "项目问答因{RESTART_INTERRUPTION}，请重新发送问题。"
                ));
                chat.updated_at = now;
                changed = true;
            }
        }
        if changed {
            self.write_persist().await?;
            if let Some(ref db) = self.db {
                for project_id in removed_project_ids {
                    let _ = db.delete_project_chat(&project_id);
                }
            }
        }
        Ok(())
    }

    pub async fn cleanup_stale_pi_sessions(&self) {
        let cutoff = SystemTime::now()
            .checked_sub(PI_SESSION_RETENTION)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        self.cleanup_unreferenced_pi_sessions_before(cutoff).await;
    }

    async fn cleanup_unreferenced_pi_sessions_before(&self, cutoff: SystemTime) {
        let session_dir = self.data_root.join("pi-sessions");
        let mut entries = match tokio::fs::read_dir(&session_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                tracing::warn!(
                    path = %session_dir.display(),
                    error = %error,
                    "failed to scan stale Pi session files"
                );
                return;
            }
        };
        let referenced = referenced_pi_session_paths(&self.data, &session_dir);

        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(
                        path = %session_dir.display(),
                        error = %error,
                        "failed to read Pi session directory entry"
                    );
                    break;
                }
            };
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            if let Err(error) = ensure_child_path(&session_dir, &path) {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "refused to clean Pi session outside session directory"
                );
                continue;
            }
            let normalized_path = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if referenced.contains(&normalized_path) {
                continue;
            }

            let metadata = match entry.metadata().await {
                Ok(metadata) => metadata,
                Err(error) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %error,
                        "failed to inspect Pi session file"
                    );
                    continue;
                }
            };
            if !metadata.is_file()
                || metadata
                    .modified()
                    .map_or(true, |modified| modified >= cutoff)
            {
                continue;
            }
            if let Err(error) = tokio::fs::remove_file(&path).await {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "failed to remove stale Pi session file"
                );
            }
        }
    }

    pub async fn prepare_runnable_execution_tasks(
        &mut self,
        requirement_id: &str,
    ) -> Result<Vec<RequirementTaskExecutionInput>, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let requirement = self.data.requirements[index].clone();
        if requirement.status != RequirementStatus::Running {
            return Ok(Vec::new());
        }
        let Some(runnable_plan) = requirement.execution_plan.clone() else {
            return Err(AppError::bad_request("执行 DAG 不存在"));
        };

        let task_indexes = runnable_task_indexes(&runnable_plan)?;
        if task_indexes.is_empty() {
            return Ok(Vec::new());
        }

        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == requirement.project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;

        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        let plan = requirement
            .execution_plan
            .as_mut()
            .ok_or_else(|| AppError::bad_request("执行 DAG 不存在"))?;
        for task_index in &task_indexes {
            let task = &mut plan.tasks[*task_index];
            if task.status == RequirementTaskStatus::Fixing {
                task.result_summary = None;
                task.execution_warning = None;
            }
            task.model_tier = if task.recovery_stage == RequirementRecoveryStage::HighTierExecution
            {
                task.high_tier_execution_used = true;
                crate::models::RequirementModelTier::High
            } else {
                effective_model_tier(task.kind)
            };
            task.status = RequirementTaskStatus::Running;
            task.error = None;
        }
        requirement.updated_at = now;
        let plan = plan.clone();
        let requirement = requirement.clone();
        self.write_persist().await?;

        Ok(task_indexes
            .into_iter()
            .map(|task_index| {
                let mut task = plan.tasks[task_index].clone();
                if runnable_plan.tasks[task_index].status == RequirementTaskStatus::Fixing {
                    task.status = RequirementTaskStatus::Fixing;
                }
                RequirementTaskExecutionInput {
                    project: project.clone(),
                    requirement: requirement.clone(),
                    plan: plan.clone(),
                    task,
                    model_settings: self.data.model_settings.clone(),
                }
            })
            .collect())
    }

    pub async fn apply_task_execution_result(
        &mut self,
        requirement_id: &str,
        task_id: &str,
        output: Result<RequirementTaskExecutionOutput, AppError>,
    ) -> Result<TaskExecutionDisposition, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        let plan = requirement
            .execution_plan
            .as_mut()
            .ok_or_else(|| AppError::bad_request("执行 DAG 不存在"))?;
        let task_index = plan
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or_else(|| AppError::bad_request("执行任务不存在"))?;

        match output {
            Ok(output) => {
                if output.recovery_guidance.is_some()
                    && plan.tasks[task_index].recovery_stage
                        == RequirementRecoveryStage::GuidedRetry
                    && plan.tasks[task_index].recovery_guidance.is_none()
                {
                    let task = &mut plan.tasks[task_index];
                    task.pi_session_file = output
                        .pi_session_file
                        .clone()
                        .or(task.pi_session_file.take());
                    task.recovery_guidance = output.recovery_guidance;
                    task.trace = output.trace;
                    task.failure_summary = task
                        .failure_summary
                        .take()
                        .or_else(|| Some("已生成高档模型恢复方案".to_owned()));
                    task.status = if task.kind == RequirementTaskKind::Implementation {
                        RequirementTaskStatus::Fixing
                    } else {
                        RequirementTaskStatus::Pending
                    };
                    task.error = None;
                    requirement.status = RequirementStatus::Running;
                    requirement.error = None;
                    requirement.updated_at = now;
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::System,
                        content: format!("任务「{}」已生成高档模型恢复方案。", task.title),
                        metadata: None,
                        created_at: now,
                    });
                    self.write_persist().await?;
                    return Ok(TaskExecutionDisposition::Continue);
                }
                let task_kind = plan.tasks[task_index].kind;
                let task_title = plan.tasks[task_index].title.clone();
                let rejected_sub_agent_feedback =
                    rejected_review_sub_agent_feedback(plan, task_index);
                let forced_summary_rejection = task_kind == RequirementTaskKind::ReviewSummary
                    && rejected_sub_agent_feedback.is_some();
                let effective_review_status = match task_kind {
                    RequirementTaskKind::ReviewSummary if forced_summary_rejection => {
                        Some(RequirementReviewStatus::Rejected)
                    }
                    RequirementTaskKind::Review
                    | RequirementTaskKind::ReviewSubAgent
                    | RequirementTaskKind::ReviewSummary
                    | RequirementTaskKind::MergeReview => output.review_status,
                    _ => None,
                };
                let effective_review_feedback =
                    rejected_sub_agent_feedback.or_else(|| output.review_feedback.clone());
                let effective_result_summary = if forced_summary_rejection {
                    format!(
                        "审核不通过：{}",
                        effective_review_feedback
                            .as_deref()
                            .unwrap_or("存在未通过的子审核意见")
                    )
                } else {
                    output.result_summary.clone()
                };
                let mut review_update = None;
                {
                    let task = &mut plan.tasks[task_index];
                    task.pi_session_file = output
                        .pi_session_file
                        .clone()
                        .or(task.pi_session_file.take());
                    task.branch_name = output.branch_name.clone().or(task.branch_name.take());
                    task.worktree_path = output.worktree_path.clone().or(task.worktree_path.take());
                    task.commit_sha = output.commit_sha.clone().or(task.commit_sha.take());
                    task.pull_request_url = output
                        .pull_request_url
                        .clone()
                        .or(task.pull_request_url.take());
                    task.merged_into = output.merged_into.clone().or(task.merged_into.take());
                    task.cleanup_summary = output
                        .cleanup_summary
                        .clone()
                        .or(task.cleanup_summary.take());
                    task.execution_warning = output
                        .execution_warning
                        .clone()
                        .or(task.execution_warning.take());
                    task.trace = output.trace.clone().or(task.trace.take());
                    task.attempt = task.attempt.saturating_add(1);
                    task.execution_failure_count = 0;
                    task.failure_summary = None;
                    task.recovery_stage = RequirementRecoveryStage::None;
                    task.recovery_guidance = output
                        .recovery_guidance
                        .clone()
                        .or(task.recovery_guidance.take());
                    task.result_summary = Some(effective_result_summary.clone());
                    task.error = None;
                    match task_kind {
                        RequirementTaskKind::Implementation => {
                            task.status = RequirementTaskStatus::AwaitingReview;
                        }
                        RequirementTaskKind::Review | RequirementTaskKind::ReviewSubAgent => {
                            let review_status = effective_review_status
                                .unwrap_or(RequirementReviewStatus::Rejected);
                            task.review_status = review_status;
                            task.last_review_feedback = effective_review_feedback.clone();
                            task.status = match review_status {
                                RequirementReviewStatus::Approved => {
                                    RequirementTaskStatus::Completed
                                }
                                RequirementReviewStatus::Rejected => {
                                    RequirementTaskStatus::Rejected
                                }
                                RequirementReviewStatus::Pending => RequirementTaskStatus::Pending,
                            };
                            if task_kind == RequirementTaskKind::Review {
                                review_update = Some(review_status);
                            }
                        }
                        RequirementTaskKind::ReviewSummary | RequirementTaskKind::MergeReview => {
                            task.review_status = effective_review_status
                                .unwrap_or(RequirementReviewStatus::Approved);
                            task.last_review_feedback = effective_review_feedback.clone();
                            task.status = if task.review_status == RequirementReviewStatus::Approved
                            {
                                RequirementTaskStatus::Completed
                            } else {
                                RequirementTaskStatus::Rejected
                            };
                            review_update = Some(task.review_status);
                        }
                        RequirementTaskKind::BranchMerge => {
                            task.review_status = RequirementReviewStatus::Approved;
                            task.status = RequirementTaskStatus::Completed;
                        }
                    }
                }
                match task_kind {
                    RequirementTaskKind::Implementation => {
                        reset_review_for(plan, task_id);
                    }
                    RequirementTaskKind::Review | RequirementTaskKind::ReviewSummary => {
                        match review_update.unwrap_or(RequirementReviewStatus::Rejected) {
                            RequirementReviewStatus::Approved => {
                                approve_reviewed_task(
                                    plan,
                                    task_id,
                                    effective_review_feedback.clone(),
                                )?;
                            }
                            RequirementReviewStatus::Rejected => {
                                reject_reviewed_task(
                                    plan,
                                    task_id,
                                    effective_review_feedback.clone(),
                                )?;
                            }
                            RequirementReviewStatus::Pending => {
                                plan.tasks[task_index].status = RequirementTaskStatus::Pending;
                            }
                        }
                    }
                    RequirementTaskKind::ReviewSubAgent
                    | RequirementTaskKind::BranchMerge
                    | RequirementTaskKind::MergeReview => {}
                }
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::Assistant,
                    content: format!("任务「{}」已完成：{effective_result_summary}", task_title),
                    metadata: None,
                    created_at: now,
                });
                if let Some(trace) = output.trace {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Trace,
                        content: format!("任务「{}」执行过程", task_title),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
                if plan.tasks.iter().any(|task| {
                    task.kind == RequirementTaskKind::Implementation
                        && task.status == RequirementTaskStatus::Failed
                }) {
                    requirement.status = RequirementStatus::Failed;
                    requirement.error = Some("审核多次未通过，需求执行已停止".to_owned());
                } else if plan.tasks.iter().any(|task| {
                    task.kind == RequirementTaskKind::MergeReview
                        && task.status == RequirementTaskStatus::Rejected
                }) {
                    requirement.status = RequirementStatus::Failed;
                    requirement.error = Some("最终合并审核未通过".to_owned());
                } else if plan.tasks.iter().any(|task| {
                    task.kind == RequirementTaskKind::MergeReview
                        && task.status == RequirementTaskStatus::Completed
                }) {
                    requirement.status = RequirementStatus::Completed;
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::System,
                        content: "需求执行完成。".to_owned(),
                        metadata: None,
                        created_at: now,
                    });
                }
            }
            Err(error) => {
                let task_title = plan.tasks[task_index].title.clone();
                let retryable = is_retryable_execution_error(&error);
                let task = &mut plan.tasks[task_index];
                if let Some(session_file) = error.pi_session_file() {
                    task.pi_session_file = Some(session_file.to_owned());
                }
                if register_execution_failure(
                    task,
                    &short_failure_summary(&error),
                    &error.to_string(),
                    retryable,
                ) {
                    requirement.status = RequirementStatus::Running;
                    requirement.error = None;
                } else {
                    requirement.status = RequirementStatus::Failed;
                    requirement.error = Some(format!("任务「{}」执行失败：{error}", task_title));
                }
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: if requirement.status == RequirementStatus::Running {
                        format!("任务「{}」执行失败，将按恢复策略重试：{error}", task_title)
                    } else {
                        format!("任务「{}」执行失败：{error}", task_title)
                    },
                    metadata: None,
                    created_at: now,
                });
            }
        }
        self.write_persist().await?;
        Ok(
            if self.data.requirements[index].status == RequirementStatus::Failed {
                TaskExecutionDisposition::FinalFailure
            } else {
                TaskExecutionDisposition::Continue
            },
        )
    }

    pub async fn retry_failed_node(
        &mut self,
        requirement_id: &str,
        task_id: &str,
    ) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let project_id = self.data.requirements[index].project_id.clone();
        let requirement = &mut self.data.requirements[index];
        let plan = requirement
            .execution_plan
            .as_mut()
            .ok_or_else(|| AppError::bad_request("执行 DAG 不存在"))?;
        ensure_no_running_tasks(plan)?;
        let task = plan
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| AppError::bad_request("执行任务不存在"))?;
        if task.status != RequirementTaskStatus::Failed {
            return Err(AppError::bad_request("只能重试失败节点"));
        }
        task.status = if task.kind == RequirementTaskKind::Implementation {
            RequirementTaskStatus::Fixing
        } else {
            RequirementTaskStatus::Pending
        };
        task.error = None;
        task.execution_warning = None;
        reset_recovery_state(task);
        requirement.status = RequirementStatus::Running;
        requirement.error = None;
        requirement.updated_at = Utc::now();
        self.write_persist().await?;
        Ok(project_id)
    }

    pub async fn retry_from_node(
        &mut self,
        requirement_id: &str,
        task_id: &str,
    ) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let project_id = self.data.requirements[index].project_id.clone();
        let requirement = &mut self.data.requirements[index];
        let plan = requirement
            .execution_plan
            .as_mut()
            .ok_or_else(|| AppError::bad_request("执行 DAG 不存在"))?;
        ensure_no_running_tasks(plan)?;
        let affected = downstream_task_ids(plan, task_id)?;
        for task in &mut plan.tasks {
            if task.id == task_id || affected.iter().any(|id| id == &task.id) {
                task.status = RequirementTaskStatus::Pending;
                task.review_status = RequirementReviewStatus::Pending;
                task.error = None;
                task.execution_warning = None;
                task.result_summary = None;
                reset_recovery_state(task);
            }
        }
        requirement.status = RequirementStatus::Running;
        requirement.error = None;
        requirement.updated_at = Utc::now();
        self.write_persist().await?;
        Ok(project_id)
    }

    pub async fn rerun_review(
        &mut self,
        requirement_id: &str,
        task_id: &str,
    ) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let project_id = self.data.requirements[index].project_id.clone();
        let requirement = &mut self.data.requirements[index];
        let plan = requirement
            .execution_plan
            .as_mut()
            .ok_or_else(|| AppError::bad_request("执行 DAG 不存在"))?;
        ensure_no_running_tasks(plan)?;
        let task = plan
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| AppError::bad_request("执行任务不存在"))?;
        if !matches!(
            task.kind,
            RequirementTaskKind::Review
                | RequirementTaskKind::ReviewSubAgent
                | RequirementTaskKind::ReviewSummary
        ) {
            return Err(AppError::bad_request("只能重跑审核节点"));
        }
        let rerun_kind = task.kind;
        let review_for = task.review_for.clone();
        task.status = RequirementTaskStatus::Pending;
        task.review_status = RequirementReviewStatus::Pending;
        task.error = None;
        task.execution_warning = None;
        reset_recovery_state(task);
        if rerun_kind == RequirementTaskKind::ReviewSubAgent {
            for candidate in &mut plan.tasks {
                if candidate.kind == RequirementTaskKind::ReviewSummary
                    && candidate.review_for == review_for
                {
                    candidate.status = RequirementTaskStatus::Pending;
                    candidate.review_status = RequirementReviewStatus::Pending;
                    candidate.error = None;
                    reset_recovery_state(candidate);
                }
            }
        }
        requirement.status = RequirementStatus::Running;
        requirement.error = None;
        requirement.updated_at = Utc::now();
        self.write_persist().await?;
        Ok(project_id)
    }

    pub async fn fail_requirement_execution(
        &mut self,
        requirement_id: &str,
        error: AppError,
    ) -> Result<(), AppError> {
        let index = self.requirement_index(requirement_id)?;
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        requirement.status = RequirementStatus::Failed;
        requirement.error = Some(error.to_string());
        requirement.updated_at = now;
        requirement.messages.push(RequirementMessage {
            role: RequirementMessageRole::System,
            content: format!("需求执行失败：{error}"),
            metadata: None,
            created_at: now,
        });
        self.write_persist().await?;
        Ok(())
    }

    pub fn requirement_status(&self, requirement_id: &str) -> Result<RequirementStatus, AppError> {
        let index = self.requirement_index(requirement_id)?;
        Ok(self.data.requirements[index].status)
    }

    pub async fn reset_running_execution_tasks(
        &mut self,
        requirement_id: &str,
    ) -> Result<(), AppError> {
        let index = self.requirement_index(requirement_id)?;
        if let Some(plan) = self.data.requirements[index].execution_plan.as_mut() {
            for task in &mut plan.tasks {
                if task.status == RequirementTaskStatus::Running {
                    task.status = RequirementTaskStatus::Pending;
                }
            }
        }
        self.write_persist().await
    }

    pub fn requirement_index(&self, requirement_id: &str) -> Result<usize, AppError> {
        self.data
            .requirements
            .iter()
            .position(|requirement| requirement.id == requirement_id)
            .ok_or_else(|| AppError::not_found("需求不存在"))
    }

    pub fn project_dir(&self, id: &str) -> Result<PathBuf, AppError> {
        if id.is_empty()
            || id
                .chars()
                .any(|ch| !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
        {
            return Err(AppError::bad_request("项目 ID 非法"));
        }

        let projects_root = self.data_root.join("projects");
        let project_dir = projects_root.join(id);
        ensure_child_path(&self.data_root, &project_dir)?;
        Ok(project_dir)
    }
}

include!("helpers.rs");
#[cfg(test)]
mod tests;
