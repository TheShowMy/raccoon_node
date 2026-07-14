use std::{
    collections::HashSet,
    io::BufRead,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Utc};
use serde_json::Value;

pub mod db;

use crate::error::AppError;
use crate::file_refs::{build_prompt_images, build_reference_context};
use crate::models::{
    AppData, ChangeSpec, ClarificationAnswer, FileReference, ImageAttachment, ModelSettings,
    PiModel, Project, ProjectCanvasResponse, ProjectChat, ProjectChatInput, ProjectChatMessage,
    ProjectChatMessageRole, ProjectChatOutput, ProjectChatResponse, ProjectTokenUsage,
    PromptSourceUsage, Requirement, RequirementAnalysisInput, RequirementAnalysisOutput,
    RequirementClarificationRound, RequirementConversationItem, RequirementConversationPrompt,
    RequirementConversationResponse, RequirementFailureStage, RequirementMessage,
    RequirementMessageRole, RequirementNoticeLevel, RequirementProcessStatus,
    RequirementPromptState, RequirementStatus, SessionContentBlock, SessionEntry,
    SessionTranscriptPage, SubagentReview, TerminalCommandProfile, TerminalCommandProfileUpdate,
    TokenCompactionUsage, TokenUsageCategory, TokenUsageHotspot, TokenUsageRole,
};
use crate::requirement::change_spec_semantics_equal;
use crate::utils::{
    build_clarification_answer_summary, clarification_has_answer, derive_requirement_title,
    ensure_child_path, git_remote_origin, resolve_git_root, sort_requirements_desc,
    validate_model_settings,
};
use crate::workflow::{
    WorkflowPlanInput, WorkflowPlanOutput, WorkflowRunStatus, change_spec_from_requirement,
    compile_work_plan,
};

pub const CURRENT_PROJECT_ID: &str = "current";
const MAX_TERMINAL_COMMAND_PROFILES: usize = 20;
const MAX_TERMINAL_COMMAND_NAME_LEN: usize = 64;
const MAX_TERMINAL_COMMAND_LEN: usize = 4096;
const PI_SESSION_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RESTART_INTERRUPTION: &str = "应用重启中断";
static REQUIREMENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static REQUIREMENT_PROMPT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next_requirement_prompt_id() -> String {
    format!(
        "prompt-{}-{}",
        Utc::now().timestamp_millis(),
        REQUIREMENT_PROMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn supersede_active_prompt(requirement: &mut Requirement) {
    if let Some(RequirementPromptState::Clarification { prompt_id, .. }) =
        &requirement.active_prompt
        && let Some(round) = requirement
            .clarification_history
            .iter_mut()
            .find(|round| round.prompt_id == *prompt_id)
    {
        round.superseded = true;
    }
    requirement.active_prompt = None;
}

fn set_requirement_failure(
    requirement: &mut Requirement,
    stage: RequirementFailureStage,
    code: &str,
    message: String,
) {
    requirement.status = RequirementStatus::Failed;
    requirement.error = Some(message.clone());
    requirement.failure_stage = Some(stage);
    requirement.failure_code = Some(code.to_owned());
    requirement.active_prompt = None;
    requirement.updated_at = Utc::now();
    let content = match stage {
        RequirementFailureStage::ChangeSpecValidation => {
            format!("需求规格校验失败：{message}")
        }
        RequirementFailureStage::PlanValidation => format!("WorkPlan 校验失败：{message}"),
        RequirementFailureStage::Persistence => format!("Workflow 持久化失败：{message}"),
        RequirementFailureStage::Analysis => format!("需求分析失败：{message}"),
        RequirementFailureStage::Planning => format!("WorkPlan 生成失败：{message}"),
    };
    let duplicate = requirement
        .messages
        .iter()
        .rev()
        .find(|item| item.role == RequirementMessageRole::System)
        .is_some_and(|item| {
            item.content == content
                && item
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("analysis_revision"))
                    .and_then(Value::as_u64)
                    == Some(u64::from(requirement.analysis_revision))
        });
    if !duplicate {
        requirement.messages.push(RequirementMessage {
            role: RequirementMessageRole::System,
            content,
            references: Vec::new(),
            images: Vec::new(),
            metadata: Some(serde_json::json!({
                "failure_stage": stage,
                "failure_code": code,
                "analysis_revision": requirement.analysis_revision,
            })),
            created_at: requirement.updated_at,
        });
    }
}

pub enum ProjectScheduleAction {
    Plan {
        requirement_id: String,
        input: Box<WorkflowPlanInput>,
    },
    Execute {
        requirement_id: String,
        run_id: String,
    },
}

pub enum FailedRequirementWorkflowAction {
    Plan {
        project_id: String,
    },
    RepairChangeSpec {
        input: Box<RequirementAnalysisInput>,
    },
}

pub struct JsonStore {
    pub data_root: PathBuf,
    pub data: AppData,
    persisted: AppData,
    pub db: crate::store::db::Database,
}

impl JsonStore {
    pub async fn open_project(project_root: PathBuf) -> Result<Self, AppError> {
        let project_root = resolve_git_root(Some(&project_root), &project_root)?;
        let data_root = project_root.join(".raccoon-node");
        ensure_child_path(&project_root, &data_root)?;
        tokio::fs::create_dir_all(&data_root).await?;
        {
            let file = data_root.join("data.db");
            ensure_child_path(&data_root, &file)?;
            if std::fs::symlink_metadata(&file)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(AppError::bad_request(
                    ".raccoon-node 中的存储文件不能是符号链接",
                ));
            }
        }
        for directory in ["sessions", "worktrees", "attachments", "extensions", "logs"] {
            let directory = data_root.join(directory);
            ensure_child_path(&data_root, &directory)?;
            tokio::fs::create_dir_all(directory).await?;
        }
        let mut store = Self::open(data_root).await?;
        let now = Utc::now();
        let created_at = store
            .data
            .projects
            .iter()
            .find(|project| project.id == CURRENT_PROJECT_ID)
            .map(|project| project.created_at)
            .unwrap_or(now);
        let project = Project {
            id: CURRENT_PROJECT_ID.to_owned(),
            name: project_root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "repository".to_owned()),
            git_url: git_remote_origin(&project_root),
            local_path: project_root.to_string_lossy().into_owned(),
            created_at,
            updated_at: now,
        };
        store.data.projects = vec![project];
        for requirement in &mut store.data.requirements {
            requirement.project_id = CURRENT_PROJECT_ID.to_owned();
        }
        for chat in &mut store.data.project_chats {
            chat.project_id = CURRENT_PROJECT_ID.to_owned();
        }
        store.write_persist().await?;
        Ok(store)
    }

    pub async fn open(data_root: PathBuf) -> Result<Self, AppError> {
        tokio::fs::create_dir_all(&data_root).await?;
        let db_path = data_root.join("data.db");
        let db = crate::store::db::Database::open(&db_path)?;
        db.recover_interrupted_workflows()?;

        let data = db.load()?;
        let persisted = data.clone();
        Ok(Self {
            data_root,
            data,
            persisted,
            db,
        })
    }

    async fn write_persist(&mut self) -> Result<(), AppError> {
        self.db.sync_changes(&self.persisted, &self.data)?;
        self.persisted = self.data.clone();
        Ok(())
    }

    pub async fn persist(&mut self) -> Result<(), AppError> {
        self.write_persist().await
    }

    pub async fn delete_requirement(&mut self, requirement_id: &str) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let project_id = self.data.requirements[index].project_id.clone();
        let session_files = self.db.requirement_sessions(requirement_id)?;
        self.data.requirements.remove(index);
        self.write_persist().await?;
        for session_file in session_files {
            if let Ok(path) = self.resolve_managed_session_path(&session_file) {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
        Ok(project_id)
    }

    fn resolve_managed_session_path(&self, session_file: &str) -> Result<PathBuf, AppError> {
        let path = Path::new(session_file);
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.data_root.join("sessions").join(path)
        };
        ensure_child_path(&self.data_root.join("sessions"), &candidate)?;
        Ok(candidate)
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

    pub fn terminal_command_profiles(
        &self,
        project_id: &str,
    ) -> Result<Vec<TerminalCommandProfile>, AppError> {
        if !self
            .data
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(AppError::not_found("项目不存在"));
        }
        Ok(self.data.terminal_command_profiles.clone())
    }

    pub async fn replace_terminal_command_profiles(
        &mut self,
        project_id: &str,
        profiles: Vec<TerminalCommandProfileUpdate>,
    ) -> Result<Vec<TerminalCommandProfile>, AppError> {
        if !self
            .data
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(AppError::not_found("项目不存在"));
        }
        if profiles.len() > MAX_TERMINAL_COMMAND_PROFILES {
            return Err(AppError::bad_request(format!(
                "终端启动命令最多只能保存 {MAX_TERMINAL_COMMAND_PROFILES} 条"
            )));
        }

        let mut normalized = Vec::with_capacity(profiles.len());
        let now = Utc::now();
        for (index, profile) in profiles.into_iter().enumerate() {
            let name = profile.name.trim().to_owned();
            let command = profile.command.trim().to_owned();
            if name.is_empty() {
                return Err(AppError::bad_request("终端启动命令名称不能为空"));
            }
            if name.chars().count() > MAX_TERMINAL_COMMAND_NAME_LEN {
                return Err(AppError::bad_request(format!(
                    "终端启动命令名称不能超过 {MAX_TERMINAL_COMMAND_NAME_LEN} 个字符"
                )));
            }
            if command.is_empty() {
                return Err(AppError::bad_request("终端启动命令不能为空"));
            }
            if command.chars().count() > MAX_TERMINAL_COMMAND_LEN {
                return Err(AppError::bad_request(format!(
                    "终端启动命令不能超过 {MAX_TERMINAL_COMMAND_LEN} 个字符"
                )));
            }
            let existing = profile.id.as_deref().and_then(|id| {
                self.data
                    .terminal_command_profiles
                    .iter()
                    .find(|candidate| candidate.id == id)
            });
            normalized.push(TerminalCommandProfile {
                id: profile
                    .id
                    .filter(|id| !id.trim().is_empty())
                    .unwrap_or_else(|| {
                        format!("terminal-command-{}-{}", now.timestamp_millis(), index + 1)
                    }),
                name,
                command,
                created_at: existing.map(|item| item.created_at).unwrap_or(now),
                updated_at: now,
            });
        }

        self.data.terminal_command_profiles = normalized;
        self.write_persist().await?;
        Ok(self.data.terminal_command_profiles.clone())
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

        let workflow_runs = self
            .data
            .requirements
            .iter()
            .filter(|requirement| requirement.project_id == project_id)
            .map(|requirement| self.db.active_workflow_for_requirement(&requirement.id))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        let token_usage = aggregate_project_token_usage(
            self.data
                .project_chats
                .iter()
                .filter(|chat| chat.project_id == project_id),
            self.data
                .requirements
                .iter()
                .filter(|requirement| requirement.project_id == project_id),
            workflow_runs.iter(),
        );

        for requirement in active
            .iter_mut()
            .chain(queued_requirements.iter_mut())
            .chain(completed_requirements.iter_mut())
        {
            requirement.messages.clear();
        }

        Ok(ProjectCanvasResponse {
            project,
            active_requirement: active.into_iter().next(),
            queued_requirements,
            completed_requirements,
            workflow_runs,
            token_usage,
        })
    }

    pub fn project_canvas_for_view(
        &self,
        project_id: &str,
        workflow_requirement_id: Option<&str>,
    ) -> Result<ProjectCanvasResponse, AppError> {
        let canvas = self.project_canvas(project_id)?;
        let selected_found = workflow_requirement_id.is_none()
            || canvas
                .active_requirement
                .iter()
                .chain(canvas.queued_requirements.iter())
                .chain(canvas.completed_requirements.iter())
                .any(|requirement| workflow_requirement_id == Some(requirement.id.as_str()));
        if !selected_found {
            return Err(AppError::not_found("需求不存在"));
        }
        Ok(canvas)
    }

    pub fn workflow_attempt_session_sources(
        &self,
        run_id: &str,
        attempt_id: &str,
    ) -> Result<Vec<(String, PathBuf)>, AppError> {
        let snapshot = self.db.workflow_snapshot(run_id)?;
        let attempt = snapshot
            .attempts
            .iter()
            .find(|attempt| attempt.id == attempt_id)
            .ok_or_else(|| AppError::not_found("Workflow attempt 不存在"))?;
        let Some(session_file) = attempt.pi_session_file.as_deref() else {
            return Ok(Vec::new());
        };
        Ok(vec![(
            format!("{:?} · 尝试 {}", attempt.kind, attempt.ordinal),
            self.resolve_managed_session_path(session_file)?,
        )])
    }

    pub fn requirement_session(
        &self,
        requirement_id: &str,
        before: Option<usize>,
        limit: usize,
    ) -> Result<SessionTranscriptPage, AppError> {
        read_session_transcript(
            &self.requirement_session_sources(requirement_id)?,
            before,
            limit,
        )
    }

    pub fn requirement_session_sources(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<(String, PathBuf)>, AppError> {
        self.requirement_index(requirement_id)?;
        let sources = self
            .db
            .requirement_sessions(requirement_id)?
            .into_iter()
            .enumerate()
            .map(|(index, session_file)| {
                Ok((
                    format!("需求分析 {}", index + 1),
                    self.resolve_managed_session_path(&session_file)?,
                ))
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        if sources.is_empty() {
            return Err(AppError::not_found("需求没有会话记录"));
        }
        Ok(sources)
    }

    pub fn project_chat_session(
        &self,
        project_id: &str,
        before: Option<usize>,
        limit: usize,
    ) -> Result<SessionTranscriptPage, AppError> {
        read_session_transcript(
            &self.project_chat_session_sources(project_id)?,
            before,
            limit,
        )
    }

    pub fn project_chat_session_sources(
        &self,
        project_id: &str,
    ) -> Result<Vec<(String, PathBuf)>, AppError> {
        let chat = self
            .data
            .project_chats
            .iter()
            .find(|chat| chat.project_id == project_id)
            .ok_or_else(|| AppError::not_found("项目问答不存在"))?;
        let session_file = chat
            .pi_session_file
            .as_deref()
            .ok_or_else(|| AppError::not_found("项目问答没有会话记录"))?;
        Ok(vec![(
            "项目问答".to_owned(),
            self.resolve_managed_session_path(session_file)?,
        )])
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
        references: Vec<FileReference>,
        images: Vec<ImageAttachment>,
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
        if self.has_active_requirement(project_id) {
            return Err(AppError::conflict(
                "需求分支尚未确认或放弃，暂时无法继续普通会话",
            ));
        }
        let project_dir = self.project_dir(project_id)?;
        let reference_context =
            build_reference_context(Path::new(&project.local_path), &references, &images).await?;
        let prompt_images = build_prompt_images(&project_dir, &images).await?;

        let now = Utc::now();
        let chat = &mut self.data.project_chats[index];
        chat.messages.push(ProjectChatMessage {
            role: ProjectChatMessageRole::User,
            content: message,
            references,
            images,
            metadata: None,
            created_at: now,
        });
        chat.running = true;
        chat.error = None;
        chat.updated_at = now;

        let input = ProjectChatInput {
            project,
            messages: chat.messages.clone(),
            reference_context,
            prompt_images,
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
                        references: Vec::new(),
                        images: Vec::new(),
                        metadata: output.trace,
                        created_at: now,
                    });
                }
            }
            Err(error) => {
                chat.error = Some(error.to_string());
                if let Some(trace) = error.trace().cloned() {
                    chat.messages.push(ProjectChatMessage {
                        role: ProjectChatMessageRole::System,
                        content: "项目问答失败过程".to_owned(),
                        references: Vec::new(),
                        images: Vec::new(),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
            }
        }
        let response = project_chat_response_from(chat);
        self.write_persist().await?;
        Ok(response)
    }

    pub async fn reset_project_chat(
        &mut self,
        project_id: &str,
    ) -> Result<ProjectChatResponse, AppError> {
        self.ensure_project_chat(project_id).await?;
        let index = self.project_chat_index(project_id)?;
        if self.data.project_chats[index].running {
            return Err(AppError::bad_request("项目问答正在回答，暂时无法关闭会话"));
        }
        if self.has_active_requirement(project_id) {
            return Err(AppError::conflict(
                "需求分支尚未确认或放弃，暂时无法新建普通会话",
            ));
        }
        let chat = &mut self.data.project_chats[index];
        chat.messages.clear();
        chat.error = None;
        chat.pi_session_file = None;
        chat.updated_at = Utc::now();
        let response = project_chat_response_from(chat);
        self.write_persist().await?;
        Ok(response)
    }

    pub async fn start_project_chat_requirement_branch(
        &mut self,
        project_id: &str,
    ) -> Result<Option<ProjectChatInput>, AppError> {
        self.ensure_project_chat(project_id).await?;
        let index = self.project_chat_index(project_id)?;
        let chat = &self.data.project_chats[index];
        if chat.running {
            return Err(AppError::conflict("项目问答正在运行，暂时无法创建需求分支"));
        }
        if self.has_active_requirement(project_id) {
            return Err(AppError::conflict("已有尚未确认的需求分支"));
        }
        let has_user = chat
            .messages
            .iter()
            .any(|message| message.role == ProjectChatMessageRole::User);
        let has_assistant = chat
            .messages
            .iter()
            .any(|message| message.role == ProjectChatMessageRole::Assistant);
        if !has_user || !has_assistant {
            return Ok(None);
        }
        if chat.pi_session_file.is_none() {
            return Err(AppError::conflict(
                "普通会话已有完整上下文，但 Pi session 已丢失，无法创建需求分支",
            ));
        }
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;
        let input = ProjectChatInput {
            project,
            messages: chat.messages.clone(),
            reference_context: None,
            prompt_images: Vec::new(),
            model_settings: self.data.model_settings.clone(),
            pi_session_file: chat.pi_session_file.clone(),
        };
        let chat = &mut self.data.project_chats[index];
        chat.running = true;
        chat.error = None;
        chat.updated_at = Utc::now();
        self.write_persist().await?;
        Ok(Some(input))
    }

    pub async fn finish_project_chat_requirement_branch(
        &mut self,
        project_id: &str,
    ) -> Result<(), AppError> {
        let index = self.project_chat_index(project_id)?;
        let chat = &mut self.data.project_chats[index];
        chat.running = false;
        chat.updated_at = Utc::now();
        self.write_persist().await
    }

    fn has_active_requirement(&self, project_id: &str) -> bool {
        self.data.requirements.iter().any(|requirement| {
            requirement.project_id == project_id
                && matches!(
                    requirement.status,
                    RequirementStatus::Analyzing
                        | RequirementStatus::Clarifying
                        | RequirementStatus::DraftReady
                        | RequirementStatus::Failed
                )
                && (requirement.status != RequirementStatus::Failed || requirement.draft.is_none())
        })
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
        references: Vec<FileReference>,
        images: Vec<ImageAttachment>,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        self.create_requirement_with_session(project_id, message, references, images, None)
            .await
    }

    pub async fn create_requirement_with_session(
        &mut self,
        project_id: &str,
        message: String,
        references: Vec<FileReference>,
        images: Vec<ImageAttachment>,
        pi_session_file: Option<String>,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        let origin = if pi_session_file.is_some() {
            crate::models::RequirementOrigin::ProjectChatBranch
        } else {
            crate::models::RequirementOrigin::Standalone
        };
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;
        let project_dir = self.project_dir(project_id)?;
        let reference_context =
            build_reference_context(Path::new(&project.local_path), &references, &images).await?;
        let prompt_images = build_prompt_images(&project_dir, &images).await?;

        let now = Utc::now();
        let id = format!(
            "requirement-{}-{}",
            now.timestamp_millis(),
            REQUIREMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let requirement = Requirement {
            id: id.clone(),
            project_id: project_id.to_owned(),
            title: derive_requirement_title(&message),
            original_message: message.clone(),
            origin,
            status: RequirementStatus::Analyzing,
            messages: vec![RequirementMessage {
                role: RequirementMessageRole::User,
                content: message,
                references,
                images,
                metadata: None,
                created_at: now,
            }],
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: None,
            analysis_revision: 0,
            active_prompt: None,
            clarification_history: Vec::new(),
            pi_session_file: pi_session_file.clone(),
            error: None,
            failure_stage: None,
            failure_code: None,
            queued_at: None,
            created_at: now,
            updated_at: now,
        };

        let input = RequirementAnalysisInput {
            project,
            messages: requirement.messages.clone(),
            reference_context,
            prompt_images,
            clarifications: requirement.clarifications.clone(),
            draft: None,
            model_settings: self.data.model_settings.clone(),
            pi_session_file,
            repair_change_spec_only: false,
        };
        self.data.requirements.push(requirement);
        self.write_persist().await?;
        Ok((id, input))
    }

    pub async fn append_requirement_message(
        &mut self,
        requirement_id: &str,
        message: String,
        references: Vec<FileReference>,
        images: Vec<ImageAttachment>,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status == RequirementStatus::Analyzing {
            return Err(AppError::conflict("需求正在分析，请等待本轮完成"));
        }
        if !matches!(
            self.data.requirements[index].status,
            RequirementStatus::Clarifying
                | RequirementStatus::Analyzing
                | RequirementStatus::Failed
                | RequirementStatus::DraftReady
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
        let project_dir = self.project_dir(&project_id)?;
        let reference_context =
            build_reference_context(Path::new(&project.local_path), &references, &images).await?;
        let prompt_images = build_prompt_images(&project_dir, &images).await?;
        let previous_clarifications = self.data.requirements[index].clarifications.clone();
        let previous_draft = self.data.requirements[index].draft.clone();
        let now = Utc::now();
        {
            let requirement = &mut self.data.requirements[index];
            requirement.status = RequirementStatus::Analyzing;
            requirement.error = None;
            requirement.failure_stage = None;
            requirement.failure_code = None;
            supersede_active_prompt(requirement);
            requirement.clarifications.clear();
            requirement.draft = None;
            requirement.updated_at = now;
            requirement.messages.push(RequirementMessage {
                role: RequirementMessageRole::User,
                content: message,
                references,
                images,
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
                reference_context,
                prompt_images,
                clarifications: previous_clarifications,
                draft: previous_draft,
                model_settings: self.data.model_settings.clone(),
                pi_session_file: requirement.pi_session_file,
                repair_change_spec_only: false,
            },
        ))
    }

    pub async fn submit_requirement_clarifications(
        &mut self,
        requirement_id: &str,
        prompt_id: Option<String>,
        revision: Option<u32>,
        answers: Vec<crate::models::ClarificationAnswerRequest>,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        if answers.is_empty() {
            return Err(AppError::bad_request("请先回答澄清问题"));
        }

        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status != RequirementStatus::Clarifying {
            return Err(AppError::bad_request("当前需求不在澄清状态"));
        }
        let active_prompt = self.data.requirements[index].active_prompt.clone();
        if let Some(RequirementPromptState::Clarification {
            prompt_id: active_prompt_id,
            revision: active_revision,
            ..
        }) = active_prompt
        {
            if prompt_id
                .as_deref()
                .is_some_and(|value| value != active_prompt_id)
            {
                return Err(AppError::conflict("澄清问题已更新，请刷新后重试"));
            }
            if revision.is_some_and(|value| value != active_revision) {
                return Err(AppError::conflict("澄清问题版本已更新，请刷新后重试"));
            }
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
            if let Some(RequirementPromptState::Clarification { prompt_id, .. }) =
                &requirement.active_prompt
                && let Some(round) = requirement
                    .clarification_history
                    .iter_mut()
                    .find(|round| round.prompt_id == *prompt_id)
            {
                round.questions = clarifications.clone();
                round.answered_at = Some(now);
            }
            requirement.status = RequirementStatus::Analyzing;
            requirement.error = None;
            requirement.failure_stage = None;
            requirement.failure_code = None;
            requirement.clarifications = clarifications;
            requirement.active_prompt = None;
            requirement.updated_at = now;
            requirement.messages.push(RequirementMessage {
                role: RequirementMessageRole::User,
                content: summary,
                references: Vec::new(),
                images: Vec::new(),
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
                reference_context: None,
                prompt_images: Vec::new(),
                clarifications: requirement.clarifications,
                draft: requirement.draft,
                model_settings: self.data.model_settings.clone(),
                pi_session_file: requirement.pi_session_file,
                repair_change_spec_only: false,
            },
        ))
    }

    pub async fn bind_requirement_session(
        &mut self,
        requirement_id: &str,
        session_file: String,
    ) -> Result<(), AppError> {
        self.resolve_managed_session_path(&session_file)?;
        let index = self.requirement_index(requirement_id)?;
        self.data.requirements[index].pi_session_file = Some(session_file);
        self.data.requirements[index].updated_at = Utc::now();
        self.write_persist().await
    }

    pub async fn apply_requirement_clarification_request(
        &mut self,
        requirement_id: &str,
        clarifications: Vec<crate::models::RequirementClarification>,
    ) -> Result<(), AppError> {
        if clarifications.is_empty() {
            return Err(AppError::bad_request("澄清问题不能为空"));
        }
        let index = self.requirement_index(requirement_id)?;
        let requirement = &mut self.data.requirements[index];
        if requirement.status != RequirementStatus::Analyzing {
            return Err(AppError::conflict("需求当前不在分析状态"));
        }
        let now = Utc::now();
        requirement.status = RequirementStatus::Clarifying;
        requirement.clarification_round = requirement.clarification_round.saturating_add(1);
        requirement.clarifications = clarifications.clone();
        requirement.error = None;
        requirement.failure_stage = None;
        requirement.failure_code = None;
        requirement.updated_at = now;
        requirement.messages.push(RequirementMessage {
            role: RequirementMessageRole::Trace,
            content: format!("第 {} 轮需求澄清", requirement.clarification_round),
            references: Vec::new(),
            images: Vec::new(),
            metadata: Some(serde_json::json!({
                "type": "requirement_clarifications",
                "questions": clarifications,
            })),
            created_at: now,
        });
        self.write_persist().await
    }

    pub async fn retry_requirement_analysis(
        &mut self,
        requirement_id: &str,
    ) -> Result<(String, RequirementAnalysisInput), AppError> {
        let index = self.requirement_index(requirement_id)?;
        let requirement = &self.data.requirements[index];
        if requirement.status != RequirementStatus::Failed || requirement.draft.is_some() {
            return Err(AppError::bad_request("只有失败的需求分析才能重试"));
        }
        let project_id = requirement.project_id.clone();
        let project = self
            .data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("项目不存在"))?;
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        requirement.status = RequirementStatus::Analyzing;
        requirement.error = None;
        requirement.failure_stage = None;
        requirement.failure_code = None;
        requirement.pi_session_file = None;
        requirement.updated_at = now;
        requirement.messages.push(RequirementMessage {
            role: RequirementMessageRole::System,
            content: "正在使用新的 Pi 会话重新分析需求。".to_owned(),
            references: Vec::new(),
            images: Vec::new(),
            metadata: None,
            created_at: now,
        });
        let requirement = requirement.clone();
        self.write_persist().await?;
        Ok((
            project_id,
            RequirementAnalysisInput {
                project,
                messages: requirement.messages,
                reference_context: None,
                prompt_images: Vec::new(),
                clarifications: requirement.clarifications,
                draft: requirement.draft,
                model_settings: self.data.model_settings.clone(),
                pi_session_file: None,
                repair_change_spec_only: false,
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
                if output.status != RequirementStatus::Failed || output.draft.is_some() {
                    requirement.draft = output.draft;
                }
                requirement.analysis_revision = requirement.analysis_revision.saturating_add(1);
                requirement.active_prompt = None;
                requirement.pi_session_file = output.pi_session_file;
                requirement.error = output.error;
                requirement.failure_stage = output.failure_stage;
                requirement.failure_code = output.failure_code;
                requirement.updated_at = now;
                if !output.clarifications.is_empty() {
                    requirement.clarification_round =
                        requirement.clarification_round.saturating_add(1);
                    let prompt_id = next_requirement_prompt_id();
                    let revision = requirement.analysis_revision;
                    let round = requirement.clarification_round;
                    let clarifications = output.clarifications;
                    requirement.active_prompt = Some(RequirementPromptState::Clarification {
                        prompt_id: prompt_id.clone(),
                        revision,
                        round,
                        questions: clarifications.clone(),
                    });
                    requirement
                        .clarification_history
                        .push(RequirementClarificationRound {
                            round,
                            prompt_id,
                            revision,
                            questions: clarifications.clone(),
                            superseded: false,
                            answered_at: None,
                            created_at: now,
                        });
                    requirement.clarifications = clarifications;
                } else if requirement.status == RequirementStatus::DraftReady {
                    if let Some(draft) = requirement.draft.clone() {
                        requirement.active_prompt = Some(RequirementPromptState::Confirmation {
                            prompt_id: next_requirement_prompt_id(),
                            revision: requirement.analysis_revision,
                            draft,
                        });
                    }
                    requirement.clarifications.clear();
                }
                if !output.assistant_message.trim().is_empty() {
                    requirement.messages.push(RequirementMessage {
                        role: if requirement.status == RequirementStatus::Failed {
                            RequirementMessageRole::System
                        } else {
                            RequirementMessageRole::Assistant
                        },
                        content: output.assistant_message,
                        references: Vec::new(),
                        images: Vec::new(),
                        metadata: (requirement.status == RequirementStatus::Failed).then(|| {
                            serde_json::json!({
                                "failure_stage": requirement.failure_stage,
                                "failure_code": requirement.failure_code,
                            })
                        }),
                        created_at: now,
                    });
                }
                if let Some(trace) = output.trace {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Trace,
                        content: "Pi Agent 分析过程".to_owned(),
                        references: Vec::new(),
                        images: Vec::new(),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
            }
            Err(error) => {
                let failure_trace = error.trace().cloned();
                requirement.status = RequirementStatus::Failed;
                requirement.error = Some(error.to_string());
                if requirement.failure_stage == Some(RequirementFailureStage::ChangeSpecValidation)
                {
                    requirement.failure_code =
                        Some("change_spec_repair_transport_failed".to_owned());
                } else {
                    requirement.failure_stage = Some(RequirementFailureStage::Analysis);
                    requirement.failure_code = Some("analysis_transport_failed".to_owned());
                }
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: format!("需求分析失败：{error}"),
                    references: Vec::new(),
                    images: Vec::new(),
                    metadata: None,
                    created_at: now,
                });
                if let Some(trace) = failure_trace {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Trace,
                        content: "Pi Agent 分析过程".to_owned(),
                        references: Vec::new(),
                        images: Vec::new(),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
            }
        }
        self.write_persist().await?;
        Ok(())
    }

    pub async fn confirm_requirement(
        &mut self,
        requirement_id: &str,
        prompt_id: Option<String>,
        revision: Option<u32>,
    ) -> Result<String, AppError> {
        let index = self.requirement_index(requirement_id)?;
        if self.data.requirements[index].status != RequirementStatus::DraftReady {
            return Err(AppError::bad_request("只有已生成确认卡片的需求才能确认"));
        }
        if let Err(error) = change_spec_from_requirement(&self.data.requirements[index]) {
            let requirement = &mut self.data.requirements[index];
            set_requirement_failure(
                requirement,
                RequirementFailureStage::ChangeSpecValidation,
                "constraint_evidence_invalid",
                error.to_string(),
            );
            self.write_persist().await?;
            return Err(AppError::bad_request(
                "需求规格引用无效，已转入自动修复入口",
            ));
        }
        if let Some(RequirementPromptState::Confirmation {
            prompt_id: active_prompt_id,
            revision: active_revision,
            ..
        }) = &self.data.requirements[index].active_prompt
        {
            if prompt_id
                .as_deref()
                .is_some_and(|value| value != active_prompt_id)
            {
                return Err(AppError::conflict("确认卡片已更新，请刷新后重试"));
            }
            if revision.is_some_and(|value| value != *active_revision) {
                return Err(AppError::conflict("确认卡片版本已更新，请刷新后重试"));
            }
        }
        let now = Utc::now();
        let project_id = self.data.requirements[index].project_id.clone();
        let requirement = &mut self.data.requirements[index];
        requirement.status = RequirementStatus::Queued;
        requirement.error = None;
        requirement.failure_stage = None;
        requirement.failure_code = None;
        requirement.active_prompt = None;
        requirement.queued_at = Some(now);
        requirement.updated_at = now;
        self.write_persist().await?;
        Ok(project_id)
    }

    pub async fn requeue_failed_planning(
        &mut self,
        requirement_id: &str,
    ) -> Result<FailedRequirementWorkflowAction, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let has_workflow = self
            .db
            .active_workflow_for_requirement(requirement_id)?
            .is_some();
        let requirement = self.data.requirements[index].clone();
        if requirement.status != RequirementStatus::Failed
            || has_workflow
            || requirement.draft.is_none()
        {
            return Err(AppError::bad_request(
                "只有尚未创建 WorkflowRun 的规划失败需求才能重新规划",
            ));
        }
        let project_id = requirement.project_id.clone();
        match change_spec_from_requirement(&requirement) {
            Ok(_) => {
                let requirement = &mut self.data.requirements[index];
                requirement.status = RequirementStatus::Queued;
                requirement.error = None;
                requirement.failure_stage = None;
                requirement.failure_code = None;
                requirement.active_prompt = None;
                requirement.queued_at.get_or_insert(requirement.updated_at);
                requirement.updated_at = Utc::now();
                self.write_persist().await?;
                Ok(FailedRequirementWorkflowAction::Plan { project_id })
            }
            Err(_) => {
                let project = self
                    .data
                    .projects
                    .iter()
                    .find(|project| project.id == project_id)
                    .cloned()
                    .ok_or_else(|| AppError::not_found("项目不存在"))?;
                debug_assert!(requirement.draft.is_some());
                let now = Utc::now();
                let requirement = &mut self.data.requirements[index];
                requirement.status = RequirementStatus::Analyzing;
                requirement.error = None;
                requirement.failure_stage = Some(RequirementFailureStage::ChangeSpecValidation);
                requirement.failure_code = Some("change_spec_repair_in_progress".to_owned());
                requirement.active_prompt = None;
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: "正在修复 ChangeSpec 的用户消息证据引用。".to_owned(),
                    references: Vec::new(),
                    images: Vec::new(),
                    metadata: Some(serde_json::json!({
                        "event": "change_spec_repair_started",
                    })),
                    created_at: now,
                });
                let input = RequirementAnalysisInput {
                    project,
                    messages: requirement.messages.clone(),
                    reference_context: None,
                    prompt_images: Vec::new(),
                    clarifications: requirement.clarifications.clone(),
                    draft: requirement.draft.clone(),
                    model_settings: self.data.model_settings.clone(),
                    pi_session_file: requirement.pi_session_file.clone(),
                    repair_change_spec_only: true,
                };
                self.write_persist().await?;
                Ok(FailedRequirementWorkflowAction::RepairChangeSpec {
                    input: Box::new(input),
                })
            }
        }
    }

    pub async fn auto_queue_repaired_requirement(
        &mut self,
        requirement_id: &str,
        baseline: &ChangeSpec,
    ) -> Result<Option<String>, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let requirement = &self.data.requirements[index];
        if requirement.status != RequirementStatus::DraftReady {
            return Ok(None);
        }
        let repaired = change_spec_from_requirement(requirement)?;
        if !change_spec_semantics_equal(baseline, &repaired) {
            return Ok(None);
        }
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        requirement.status = RequirementStatus::Queued;
        requirement.error = None;
        requirement.failure_stage = None;
        requirement.failure_code = None;
        requirement.active_prompt = None;
        requirement.queued_at.get_or_insert(now);
        requirement.updated_at = now;
        requirement.messages.push(RequirementMessage {
            role: RequirementMessageRole::System,
            content: "ChangeSpec 仅修正了证据引用，已自动继续生成 WorkPlan。".to_owned(),
            references: Vec::new(),
            images: Vec::new(),
            metadata: Some(serde_json::json!({
                "event": "change_spec_repair_completed",
                "auto_resumed": true,
            })),
            created_at: now,
        });
        let project_id = requirement.project_id.clone();
        self.write_persist().await?;
        Ok(Some(project_id))
    }

    pub async fn start_requirement_planning(
        &mut self,
        requirement_id: &str,
    ) -> Result<(String, WorkflowPlanInput), AppError> {
        let index = self.requirement_index(requirement_id)?;
        if !matches!(
            self.data.requirements[index].status,
            RequirementStatus::Queued | RequirementStatus::Failed
        ) {
            return Err(AppError::bad_request("只有待执行需求才能生成 WorkPlan"));
        }
        if let Err(error) = change_spec_from_requirement(&self.data.requirements[index]) {
            let requirement = &mut self.data.requirements[index];
            set_requirement_failure(
                requirement,
                RequirementFailureStage::ChangeSpecValidation,
                "planning_preflight_failed",
                error.to_string(),
            );
            self.write_persist().await?;
            return Err(AppError::bad_request(
                "ChangeSpec preflight 失败，未启动 Planner",
            ));
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
            requirement.failure_stage = None;
            requirement.failure_code = None;
            requirement.updated_at = now;
        }
        let requirement = self.data.requirements[index].clone();
        let input = WorkflowPlanInput {
            project,
            requirement,
            model_settings: self.data.model_settings.clone(),
        };
        self.write_persist().await?;
        Ok((project_id, input))
    }

    pub async fn apply_workflow_plan(
        &mut self,
        requirement_id: &str,
        output: Result<WorkflowPlanOutput, AppError>,
    ) -> Result<Option<String>, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let now = Utc::now();
        match output {
            Ok(output) => {
                let requirement = self.data.requirements[index].clone();
                let spec = match change_spec_from_requirement(&requirement) {
                    Ok(spec) => spec,
                    Err(error) => {
                        set_requirement_failure(
                            &mut self.data.requirements[index],
                            RequirementFailureStage::ChangeSpecValidation,
                            "planning_preflight_failed",
                            error.to_string(),
                        );
                        self.write_persist().await?;
                        return Ok(None);
                    }
                };
                let trace = output.trace;
                let compiled = match compile_work_plan(
                    &requirement.id,
                    &requirement.project_id,
                    requirement.analysis_revision,
                    spec,
                    output.plan,
                ) {
                    Ok(compiled) => compiled,
                    Err(error) => {
                        set_requirement_failure(
                            &mut self.data.requirements[index],
                            RequirementFailureStage::PlanValidation,
                            "work_plan_invalid",
                            error.to_string(),
                        );
                        self.write_persist().await?;
                        return Ok(None);
                    }
                };
                let run_id = compiled.run.id.clone();
                if let Err(error) = self.db.create_workflow(&compiled) {
                    set_requirement_failure(
                        &mut self.data.requirements[index],
                        RequirementFailureStage::Persistence,
                        "workflow_create_failed",
                        error.to_string(),
                    );
                    self.write_persist().await?;
                    return Ok(None);
                }
                let requirement = &mut self.data.requirements[index];
                requirement.status = RequirementStatus::Running;
                requirement.error = None;
                requirement.failure_stage = None;
                requirement.failure_code = None;
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::Assistant,
                    content: format!(
                        "WorkPlan 已生成：{} 个真实工作项，开始执行。",
                        compiled.work_items.len()
                    ),
                    references: Vec::new(),
                    images: Vec::new(),
                    metadata: Some(serde_json::json!({
                        "workflow_run_id": run_id,
                    })),
                    created_at: now,
                });
                if let Some(trace) = trace {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Trace,
                        content: "WorkPlan 生成过程".to_owned(),
                        references: Vec::new(),
                        images: Vec::new(),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
                self.write_persist().await?;
                Ok(Some(run_id))
            }
            Err(error) => {
                let trace = error.trace().cloned();
                let requirement = &mut self.data.requirements[index];
                let message = error.to_string();
                let (stage, code) = if message.contains("WorkPlan 修正后仍不合法")
                    || message.contains("WorkPlan 未通过结构或业务校验")
                {
                    (RequirementFailureStage::PlanValidation, "work_plan_invalid")
                } else {
                    (RequirementFailureStage::Planning, "planner_failed")
                };
                set_requirement_failure(requirement, stage, code, message);
                if let Some(trace) = trace {
                    requirement.messages.push(RequirementMessage {
                        role: RequirementMessageRole::Trace,
                        content: "WorkPlan 失败过程".to_owned(),
                        references: Vec::new(),
                        images: Vec::new(),
                        metadata: Some(trace),
                        created_at: now,
                    });
                }
                self.write_persist().await?;
                Ok(None)
            }
        }
    }

    pub async fn finish_requirement_from_workflow(
        &mut self,
        requirement_id: &str,
        status: WorkflowRunStatus,
        message: Option<&str>,
    ) -> Result<RequirementStatus, AppError> {
        let index = self.requirement_index(requirement_id)?;
        let now = Utc::now();
        let requirement = &mut self.data.requirements[index];
        let requirement_status = match status {
            WorkflowRunStatus::Completed => RequirementStatus::Completed,
            WorkflowRunStatus::Blocked | WorkflowRunStatus::Cancelled => RequirementStatus::Failed,
            _ => RequirementStatus::Running,
        };
        requirement.status = requirement_status;
        requirement.error = (requirement_status == RequirementStatus::Failed)
            .then(|| message.unwrap_or("WorkflowRun 未完成").to_owned());
        requirement.failure_stage = None;
        requirement.failure_code = None;
        requirement.updated_at = now;
        if requirement_status != RequirementStatus::Running {
            requirement.messages.push(RequirementMessage {
                role: if requirement_status == RequirementStatus::Completed {
                    RequirementMessageRole::Assistant
                } else {
                    RequirementMessageRole::System
                },
                content: message
                    .unwrap_or(if requirement_status == RequirementStatus::Completed {
                        "WorkflowRun 已完成。"
                    } else {
                        "WorkflowRun 已阻塞。"
                    })
                    .to_owned(),
                references: Vec::new(),
                images: Vec::new(),
                metadata: None,
                created_at: now,
            });
        }
        self.write_persist().await?;
        Ok(requirement_status)
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
            let snapshot = self.db.active_workflow_for_requirement(&requirement_id)?;
            if let Some(snapshot) = snapshot {
                if snapshot.run.status.is_terminal() {
                    self.finish_requirement_from_workflow(
                        &requirement_id,
                        snapshot.run.status,
                        snapshot.run.blocked_reason.as_deref(),
                    )
                    .await?;
                    return Ok(None);
                }
                return Ok(Some(ProjectScheduleAction::Execute {
                    requirement_id,
                    run_id: snapshot.run.id,
                }));
            }
            let requirement_index = self.requirement_index(&requirement_id)?;
            let requirement = &mut self.data.requirements[requirement_index];
            requirement.status = RequirementStatus::Failed;
            requirement.error = Some("运行中的需求缺少 WorkflowRun".to_owned());
            requirement.failure_stage = Some(RequirementFailureStage::Persistence);
            requirement.failure_code = Some("workflow_missing".to_owned());
            requirement.updated_at = Utc::now();
            self.write_persist().await?;
            return Ok(None);
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
        let workflow_states = self
            .data
            .requirements
            .iter()
            .map(|requirement| {
                self.db
                    .active_workflow_for_requirement(&requirement.id)
                    .map(|snapshot| {
                        snapshot.map(|snapshot| (snapshot.run.status, snapshot.run.blocked_reason))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let now = Utc::now();
        let mut changed = false;
        let mut project_ids = HashSet::new();

        for (requirement, workflow_state) in self.data.requirements.iter_mut().zip(workflow_states)
        {
            if matches!(
                requirement.status,
                RequirementStatus::Analyzing | RequirementStatus::Clarifying
            ) {
                requirement.status = RequirementStatus::Failed;
                requirement.error = Some("需求澄清会话因应用重启中断，请重新分析".to_owned());
                requirement.failure_stage = Some(RequirementFailureStage::Analysis);
                requirement.failure_code = Some("analysis_interrupted".to_owned());
                requirement.updated_at = now;
                changed = true;
            } else if requirement.status == RequirementStatus::Planning {
                requirement.status = RequirementStatus::Queued;
                requirement.error = None;
                requirement.failure_stage = None;
                requirement.failure_code = None;
                requirement.queued_at.get_or_insert(requirement.updated_at);
                requirement.updated_at = now;
                project_ids.insert(requirement.project_id.clone());
                changed = true;
            } else if let Some((status, blocked_reason)) = workflow_state {
                let next_status = match status {
                    WorkflowRunStatus::Completed => RequirementStatus::Completed,
                    WorkflowRunStatus::Blocked | WorkflowRunStatus::Cancelled => {
                        RequirementStatus::Failed
                    }
                    _ => RequirementStatus::Running,
                };
                if requirement.status != next_status {
                    requirement.status = next_status;
                    requirement.updated_at = now;
                    changed = true;
                }
                requirement.error = (next_status == RequirementStatus::Failed)
                    .then(|| blocked_reason.unwrap_or_else(|| "WorkflowRun 已阻塞".to_owned()));
                requirement.failure_stage = None;
                requirement.failure_code = None;
                if next_status == RequirementStatus::Running {
                    project_ids.insert(requirement.project_id.clone());
                }
            } else if requirement.status == RequirementStatus::Running {
                requirement.status = RequirementStatus::Failed;
                requirement.error = Some("运行中的需求缺少 WorkflowRun".to_owned());
                requirement.failure_stage = Some(RequirementFailureStage::Persistence);
                requirement.failure_code = Some("workflow_missing".to_owned());
                requirement.updated_at = now;
                changed = true;
            } else if requirement.status == RequirementStatus::Queued {
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
        self.data.project_chats.retain(|chat| {
            let keep = project_ids.contains(chat.project_id.as_str());
            if !keep {
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
        let session_dir = self.data_root.join("sessions");
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
        let mut referenced = referenced_pi_session_paths(&self.data, &session_dir);
        match self.db.workflow_session_files() {
            Ok(session_files) => {
                for session_file in session_files {
                    if let Ok(path) = self.resolve_managed_session_path(&session_file) {
                        referenced.insert(std::fs::canonicalize(&path).unwrap_or(path));
                    }
                }
            }
            Err(error) => tracing::warn!(
                error = %error,
                "failed to enumerate WorkflowRun Pi sessions during cleanup"
            ),
        }

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

    pub fn requirement_status(&self, requirement_id: &str) -> Result<RequirementStatus, AppError> {
        let index = self.requirement_index(requirement_id)?;
        Ok(self.data.requirements[index].status)
    }

    pub fn requirement_index(&self, requirement_id: &str) -> Result<usize, AppError> {
        self.data
            .requirements
            .iter()
            .position(|requirement| requirement.id == requirement_id)
            .ok_or_else(|| AppError::not_found("需求不存在"))
    }

    pub fn project_dir(&self, id: &str) -> Result<PathBuf, AppError> {
        if !self.data.projects.iter().any(|project| project.id == id) {
            return Err(AppError::not_found("项目不存在"));
        }
        Ok(self.data_root.clone())
    }

    pub fn project_root(&self, id: &str) -> Result<PathBuf, AppError> {
        self.data
            .projects
            .iter()
            .find(|project| project.id == id)
            .map(|project| PathBuf::from(&project.local_path))
            .ok_or_else(|| AppError::not_found("项目不存在"))
    }
}

fn aggregate_project_token_usage<'a>(
    project_chats: impl Iterator<Item = &'a ProjectChat>,
    requirements: impl Iterator<Item = &'a Requirement>,
    workflows: impl Iterator<Item = &'a crate::workflow::WorkflowSnapshot>,
) -> Option<ProjectTokenUsage> {
    let mut usage = ProjectTokenUsage::default();
    let mut found = false;

    for chat in project_chats {
        let mut previous = None;
        for message in &chat.messages {
            if let Some(metadata) = &message.metadata {
                let previous_for_insights = previous.clone();
                if !add_trace_usage_sequence(&mut usage.chat, metadata, &mut previous) {
                    continue;
                }
                found = true;
                collect_trace_insights(
                    &mut usage,
                    metadata,
                    "项目问答",
                    previous_for_insights.as_ref(),
                );
            }
        }
    }

    for requirement in requirements {
        let mut previous = None;
        for message in &requirement.messages {
            if message.role != RequirementMessageRole::Trace {
                continue;
            }
            let Some(metadata) = &message.metadata else {
                continue;
            };
            let split_operation = matches!(
                message.content.as_str(),
                "Pi Agent 分析过程" | "WorkPlan 生成过程"
            );
            if split_operation {
                let previous_for_insights = previous.clone();
                if !add_trace_usage_sequence(&mut usage.split, metadata, &mut previous) {
                    continue;
                }
                found = true;
                collect_trace_insights(
                    &mut usage,
                    metadata,
                    &requirement.title,
                    previous_for_insights.as_ref(),
                );
            } else if is_operation_trace(metadata) && add_trace_usage(&mut usage.task, metadata) {
                found = true;
                collect_trace_insights(&mut usage, metadata, &message.content, None);
            } else {
                continue;
            }
        }
    }

    for workflow in workflows {
        for attempt in &workflow.attempts {
            if let Some(trace) = &attempt.usage
                && add_trace_usage(&mut usage.task, trace)
            {
                found = true;
                collect_trace_insights(
                    &mut usage,
                    trace,
                    &format!("工作项尝试：{}", attempt.id),
                    None,
                );
            }
        }
        for checkpoint in &workflow.checkpoints {
            if let Some(trace) = &checkpoint.usage
                && add_trace_usage(&mut usage.task, trace)
            {
                found = true;
                collect_trace_insights(
                    &mut usage,
                    trace,
                    &format!("Checkpoint：{}", checkpoint.id),
                    None,
                );
            }
        }
    }

    if !found {
        return None;
    }

    usage.total.input = usage.chat.input + usage.split.input + usage.task.input;
    usage.total.output = usage.chat.output + usage.split.output + usage.task.output;
    usage.total.cache_read = usage.chat.cache_read + usage.split.cache_read + usage.task.cache_read;
    usage.total.cache_write =
        usage.chat.cache_write + usage.split.cache_write + usage.task.cache_write;
    usage
        .hotspots
        .sort_by_key(|item| std::cmp::Reverse(item.usage.total()));
    usage.hotspots.truncate(5);
    usage
        .sources
        .sort_by_key(|item| std::cmp::Reverse(item.chars));
    usage.sources.truncate(5);
    usage
        .roles
        .sort_by_key(|item| std::cmp::Reverse(item.usage.total()));
    usage.roles.truncate(5);
    Some(usage)
}

fn collect_trace_insights(
    usage: &mut ProjectTokenUsage,
    trace: &Value,
    label: &str,
    previous: Option<&TokenUsageCategory>,
) {
    let Some(raw) = trace_usage(trace) else {
        return;
    };
    let current = TokenUsageCategory {
        input: usage_number(raw, "input", "input"),
        output: usage_number(raw, "output", "output"),
        cache_read: usage_number(raw, "cacheRead", "cache_read"),
        cache_write: usage_number(raw, "cacheWrite", "cache_write"),
    };
    let previous = if is_operation_trace(trace) {
        None
    } else {
        previous
    };
    let category = TokenUsageCategory {
        input: current
            .input
            .saturating_sub(previous.map(|item| item.input).unwrap_or(0)),
        output: current
            .output
            .saturating_sub(previous.map(|item| item.output).unwrap_or(0)),
        cache_read: current
            .cache_read
            .saturating_sub(previous.map(|item| item.cache_read).unwrap_or(0)),
        cache_write: current
            .cache_write
            .saturating_sub(previous.map(|item| item.cache_write).unwrap_or(0)),
    };
    let context_percent = raw
        .pointer("/context/percent")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    usage.max_context_percent = usage.max_context_percent.max(context_percent);
    let role = trace
        .pointer("/trace/prompt/role")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    usage.hotspots.push(TokenUsageHotspot {
        label: label.to_owned(),
        role: role.to_owned(),
        usage: category.clone(),
        context_percent,
        budget_exceeded: trace
            .pointer("/trace/budget/exceeded")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    });
    if let Some(existing) = usage.roles.iter_mut().find(|item| item.role == role) {
        existing.usage.input += category.input;
        existing.usage.output += category.output;
        existing.usage.cache_read += category.cache_read;
        existing.usage.cache_write += category.cache_write;
    } else {
        usage.roles.push(TokenUsageRole {
            role: role.to_owned(),
            usage: category,
        });
    }
    collect_compaction_insights(usage, trace);
    if let Some(sources) = trace
        .pointer("/trace/prompt/sources")
        .and_then(Value::as_array)
    {
        for source in sources
            .iter()
            .filter(|source| source.get("included").and_then(Value::as_bool) == Some(true))
        {
            let kind = source
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let source_label = source
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let chars = source.get("chars").and_then(Value::as_u64).unwrap_or(0);
            let estimated_tokens = source
                .get("estimated_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if let Some(existing) = usage
                .sources
                .iter_mut()
                .find(|item| item.kind == kind && item.label == source_label)
            {
                existing.chars += chars;
                existing.estimated_tokens += estimated_tokens;
            } else {
                usage.sources.push(PromptSourceUsage {
                    kind: kind.to_owned(),
                    label: source_label.to_owned(),
                    chars,
                    estimated_tokens,
                });
            }
        }
    }
}

fn collect_compaction_insights(usage: &mut ProjectTokenUsage, trace: &Value) {
    let Some(compaction) = trace.pointer("/trace/compaction") else {
        return;
    };
    let count = compaction.get("count").and_then(Value::as_u64).unwrap_or(0);
    if count == 0 {
        return;
    }
    let summary = usage
        .compaction
        .get_or_insert_with(TokenCompactionUsage::default);
    summary.count += count;
    summary.completed += compaction
        .get("completed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    summary.aborted += compaction
        .get("aborted")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    summary.failed += compaction
        .get("failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    summary.overflow_retries += compaction
        .get("overflowRetries")
        .or_else(|| compaction.get("overflow_retries"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    summary.estimated_tokens_saved += compaction
        .get("estimatedTokensSaved")
        .or_else(|| compaction.get("estimated_tokens_saved"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    summary.usage_known |= compaction
        .get("usageKnown")
        .or_else(|| compaction.get("usage_known"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
}

fn add_trace_usage(category: &mut TokenUsageCategory, trace: &Value) -> bool {
    let Some(usage) = trace_usage(trace) else {
        return false;
    };
    category.input += usage_number(usage, "input", "input");
    category.output += usage_number(usage, "output", "output");
    category.cache_read += usage_number(usage, "cacheRead", "cache_read");
    category.cache_write += usage_number(usage, "cacheWrite", "cache_write");
    true
}

fn add_trace_usage_sequence(
    category: &mut TokenUsageCategory,
    trace: &Value,
    previous: &mut Option<TokenUsageCategory>,
) -> bool {
    let Some(raw) = trace_usage(trace) else {
        return false;
    };
    if raw.get("scope").and_then(Value::as_str) == Some("operation") {
        return add_trace_usage(category, trace);
    }
    let current = TokenUsageCategory {
        input: usage_number(raw, "input", "input"),
        output: usage_number(raw, "output", "output"),
        cache_read: usage_number(raw, "cacheRead", "cache_read"),
        cache_write: usage_number(raw, "cacheWrite", "cache_write"),
    };
    let reused = raw.get("sessionReused").and_then(Value::as_bool) == Some(true);
    let base = if reused { previous.as_ref() } else { None };
    category.input += current
        .input
        .saturating_sub(base.map(|item| item.input).unwrap_or(0));
    category.output += current
        .output
        .saturating_sub(base.map(|item| item.output).unwrap_or(0));
    category.cache_read += current
        .cache_read
        .saturating_sub(base.map(|item| item.cache_read).unwrap_or(0));
    category.cache_write += current
        .cache_write
        .saturating_sub(base.map(|item| item.cache_write).unwrap_or(0));
    *previous = Some(current);
    true
}

fn usage_number(usage: &Value, camel_case: &str, snake_case: &str) -> u64 {
    usage
        .get(camel_case)
        .and_then(Value::as_u64)
        .or_else(|| usage.get(snake_case).and_then(Value::as_u64))
        .unwrap_or(0)
}

fn is_operation_trace(trace: &Value) -> bool {
    trace_usage(trace)
        .and_then(|usage| usage.get("scope"))
        .and_then(Value::as_str)
        == Some("operation")
}

pub fn read_session_transcript(
    sources: &[(String, PathBuf)],
    before: Option<usize>,
    limit: usize,
) -> Result<SessionTranscriptPage, AppError> {
    // ponytail: Pi context files are local and bounded; one pass keeps ordering
    // correct across retry/review sources. Add an on-disk index only if profiling
    // shows session parsing is a real bottleneck.
    let mut entries = Vec::new();
    let mut invalid_lines = 0usize;

    for (source, path) in sources {
        let file = std::fs::File::open(path)
            .map_err(|_| AppError::not_found("会话记录不存在或无法读取"))?;
        for (line_index, line) in std::io::BufReader::new(file).lines().enumerate() {
            let line = match line {
                Ok(line) => line,
                Err(_) => {
                    invalid_lines += 1;
                    continue;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let raw: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => {
                    invalid_lines += 1;
                    continue;
                }
            };
            let kind = raw
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let message = (kind == "message").then(|| raw.get("message")).flatten();
            let public_raw = redact_session_entry(&raw, &kind);
            entries.push(SessionEntry {
                cursor: 0,
                source: source.clone(),
                line: line_index + 1,
                kind: kind.clone(),
                id: raw.get("id").and_then(Value::as_str).map(ToOwned::to_owned),
                role: message
                    .and_then(|value| value.get("role"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                timestamp: raw
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                blocks: if kind == "compaction" {
                    vec![parse_session_compaction(&raw)]
                } else {
                    message.map(parse_session_blocks).unwrap_or_default()
                },
                raw: public_raw,
            });
        }
    }

    entries.sort_by(|left, right| {
        let timestamp = |entry: &SessionEntry| {
            entry
                .timestamp
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        };
        timestamp(left)
            .cmp(&timestamp(right))
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.line.cmp(&right.line))
    });
    for (cursor, entry) in entries.iter_mut().enumerate() {
        entry.cursor = cursor;
    }

    let end = before.unwrap_or(entries.len()).min(entries.len());
    let start = end.saturating_sub(limit.clamp(1, 200));
    let page = entries.drain(start..end).collect();
    Ok(SessionTranscriptPage {
        entries: page,
        next_before: (start > 0).then_some(start),
        invalid_lines,
    })
}

fn redact_session_entry(entry: &Value, kind: &str) -> Value {
    if kind != "compaction" {
        return entry.clone();
    }
    let mut public = entry.clone();
    if let Some(object) = public.as_object_mut() {
        object.remove("summary");
    }
    public
}

fn parse_session_compaction(entry: &Value) -> SessionContentBlock {
    let tokens_before = entry.get("tokensBefore").and_then(Value::as_u64);
    let estimated_tokens_after = entry.get("estimatedTokensAfter").and_then(Value::as_u64);
    let estimated_tokens_saved = tokens_before
        .zip(estimated_tokens_after)
        .map(|(before, after)| before.saturating_sub(after));
    SessionContentBlock::Compaction {
        reason: entry
            .get("reason")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        status: entry
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_owned(),
        tokens_before,
        estimated_tokens_after,
        estimated_tokens_saved,
        first_kept_entry_id: entry
            .get("firstKeptEntryId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        from_hook: entry
            .get("fromHook")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        read_file_count: entry
            .pointer("/details/readFiles")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        modified_file_count: entry
            .pointer("/details/modifiedFiles")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        will_retry: entry
            .get("willRetry")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error: entry
            .get("errorMessage")
            .or_else(|| entry.get("error"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        usage_known: false,
    }
}

fn parse_session_blocks(message: &Value) -> Vec<SessionContentBlock> {
    if message.get("role").and_then(Value::as_str) == Some("toolResult") {
        let content = message.get("content");
        let output = match content {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(content)) => content
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        let mut blocks = vec![SessionContentBlock::ToolResult {
            tool_call_id: message
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            name: message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("未知工具")
                .to_owned(),
            output,
            diff: message
                .get("details")
                .and_then(|details| details.get("diff"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            is_error: message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }];
        if let Some(Value::Array(content)) = content {
            blocks.extend(
                content
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) != Some("text"))
                    .map(|block| SessionContentBlock::Unknown {
                        block_type: block
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_owned(),
                        raw: block.clone(),
                    }),
            );
        }
        if message.get("toolName").and_then(Value::as_str) == Some("run_parallel_code_review")
            && let Some(reviews) = message.pointer("/details/reviews")
        {
            match serde_json::from_value::<Vec<SubagentReview>>(reviews.clone()) {
                Ok(reviews) => blocks.push(SessionContentBlock::Subagents {
                    reviews,
                    selection: message.pointer("/details/selection").cloned(),
                }),
                Err(_) => blocks.push(SessionContentBlock::Unknown {
                    block_type: "subagents".to_owned(),
                    raw: reviews.clone(),
                }),
            }
        }
        return blocks;
    }

    match message.get("content") {
        Some(Value::String(text)) => vec![SessionContentBlock::Text { text: text.clone() }],
        Some(Value::Array(content)) => content.iter().map(parse_session_block).collect(),
        Some(raw) => vec![SessionContentBlock::Unknown {
            block_type: "content".to_owned(),
            raw: raw.clone(),
        }],
        None => Vec::new(),
    }
}

fn parse_session_block(block: &Value) -> SessionContentBlock {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => SessionContentBlock::Text {
            text: block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        },
        Some("thinking") => SessionContentBlock::Thinking {
            text: block
                .get("thinking")
                .or_else(|| block.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        },
        Some("toolCall" | "tool_call") => SessionContentBlock::ToolCall {
            id: block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            name: block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("未知工具")
                .to_owned(),
            arguments: block
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        },
        block_type => SessionContentBlock::Unknown {
            block_type: block_type.unwrap_or("unknown").to_owned(),
            raw: block.clone(),
        },
    }
}

fn trace_usage(trace: &Value) -> Option<&Value> {
    trace.get("trace")?.get("usage")
}

include!("helpers.rs");
#[cfg(test)]
mod tests;
