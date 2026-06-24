use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use chrono::Utc;

use crate::error::AppError;
use crate::models::{
    AppData, ClarificationAnswer, ModelSettings, PiModel, Project, ProjectCanvasResponse,
    Requirement, RequirementAnalysisInput, RequirementAnalysisOutput, RequirementConversationItem,
    RequirementConversationPrompt, RequirementConversationResponse, RequirementExecutionPlan,
    RequirementMessage, RequirementMessageRole, RequirementNoticeLevel, RequirementPlanInput,
    RequirementProcessStatus, RequirementRecoveryStage, RequirementReviewStatus, RequirementStatus,
    RequirementTaskExecutionInput, RequirementTaskExecutionOutput, RequirementTaskKind,
    RequirementTaskStatus,
};
use crate::requirement_execution::effective_model_tier;
use crate::utils::{
    build_clarification_answer_summary, clarification_has_answer, clone_git_repo,
    data_root_from_file, derive_requirement_title, ensure_child_path, remove_dir_if_exists,
    slugify, sort_requirements_desc, validate_git_url, validate_model_settings, write_json,
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

pub struct JsonStore {
    pub path: PathBuf,
    pub data_root: PathBuf,
    pub data: AppData,
}

impl JsonStore {
    pub async fn open(path: PathBuf) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        if !path.exists() {
            let data = AppData::default();
            write_json(&path, &data).await?;
            let data_root = data_root_from_file(&path)?;
            return Ok(Self {
                path,
                data_root,
                data,
            });
        }

        let content = tokio::fs::read_to_string(&path).await?;
        let mut data: AppData = serde_json::from_str(&content)?;
        for requirement in &mut data.requirements {
            if requirement.status == RequirementStatus::Completed {
                continue;
            }
            if let Some(plan) = requirement.execution_plan.as_mut() {
                for task in &mut plan.tasks {
                    let tier = if task.recovery_stage == RequirementRecoveryStage::HighTierExecution
                    {
                        crate::models::RequirementModelTier::High
                    } else {
                        effective_model_tier(task.kind)
                    };
                    task.model_tier = tier;
                }
            }
        }
        let data_root = data_root_from_file(&path)?;
        Ok(Self {
            path,
            data_root,
            data,
        })
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
        Ok(())
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        requirement.updated_at = now;
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
                    content: "执行 DAG 已生成，请确认后开始执行。".to_owned(),
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
        Ok(project_id)
    }

    pub async fn recover_interrupted_requirements(&mut self) -> Result<Vec<String>, AppError> {
        let now = Utc::now();
        let mut changed = false;
        let mut requirement_ids = Vec::new();

        for requirement in &mut self.data.requirements {
            if requirement.status != RequirementStatus::Running {
                continue;
            }

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
                    requirement.error = Some(format!("{RESTART_INTERRUPTION}，任务恢复次数已耗尽"));
                } else {
                    requirement.error = None;
                }
            }

            if requirement.status == RequirementStatus::Running {
                requirement_ids.push(requirement.id.clone());
            }
        }

        if changed {
            write_json(&self.path, &self.data).await?;
        }
        Ok(requirement_ids)
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
        let Some(plan) = requirement.execution_plan.clone() else {
            return Err(AppError::bad_request("执行 DAG 不存在"));
        };

        let task_indexes = runnable_task_indexes(&plan)?;
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
        write_json(&self.path, &self.data).await?;

        Ok(task_indexes
            .into_iter()
            .map(|task_index| RequirementTaskExecutionInput {
                project: project.clone(),
                requirement: requirement.clone(),
                plan: plan.clone(),
                task: plan.tasks[task_index].clone(),
                model_settings: self.data.model_settings.clone(),
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
                    write_json(&self.path, &self.data).await?;
                    return Ok(TaskExecutionDisposition::Continue);
                }
                let task_kind = plan.tasks[task_index].kind;
                let task_title = plan.tasks[task_index].title.clone();
                let effective_review_status = match task_kind {
                    RequirementTaskKind::ReviewSummary
                        if has_rejected_review_sub_agent(plan, task_index) =>
                    {
                        Some(RequirementReviewStatus::Rejected)
                    }
                    RequirementTaskKind::Review
                    | RequirementTaskKind::ReviewSubAgent
                    | RequirementTaskKind::ReviewSummary
                    | RequirementTaskKind::MergeReview => output.review_status,
                    _ => None,
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
                    task.result_summary = Some(output.result_summary.clone());
                    task.error = None;
                    match task_kind {
                        RequirementTaskKind::Implementation => {
                            task.status = RequirementTaskStatus::AwaitingReview;
                        }
                        RequirementTaskKind::Review | RequirementTaskKind::ReviewSubAgent => {
                            let review_status = effective_review_status
                                .unwrap_or(RequirementReviewStatus::Rejected);
                            task.review_status = review_status;
                            task.last_review_feedback = output.review_feedback.clone();
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
                            task.last_review_feedback = output.review_feedback.clone();
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
                                    output.review_feedback.clone(),
                                )?;
                            }
                            RequirementReviewStatus::Rejected => {
                                reject_reviewed_task(
                                    plan,
                                    task_id,
                                    output.review_feedback.clone(),
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
                    content: format!("任务「{}」已完成：{}", task_title, output.result_summary),
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await?;
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
        write_json(&self.path, &self.data).await
    }

    fn requirement_index(&self, requirement_id: &str) -> Result<usize, AppError> {
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

fn runnable_task_indexes(plan: &RequirementExecutionPlan) -> Result<Vec<usize>, AppError> {
    let mut indexes = Vec::new();
    for (index, task) in plan.tasks.iter().enumerate() {
        let runnable_status = matches!(
            task.status,
            RequirementTaskStatus::Pending | RequirementTaskStatus::Fixing
        );
        if !runnable_status {
            continue;
        }
        if matches!(
            task.kind,
            RequirementTaskKind::Review | RequirementTaskKind::ReviewSubAgent
        ) {
            let Some(review_for) = task.review_for.as_deref() else {
                continue;
            };
            let reviewed_ready = plan.tasks.iter().any(|candidate| {
                candidate.id == review_for
                    && candidate.status == RequirementTaskStatus::AwaitingReview
            });
            if reviewed_ready {
                indexes.push(index);
            }
            continue;
        }
        if task.kind == RequirementTaskKind::ReviewSummary {
            if review_sub_agents_finished(plan, task) {
                indexes.push(index);
            }
            continue;
        }

        if dependencies_completed(plan, task) {
            indexes.push(index);
        }
    }
    if !indexes.is_empty() {
        return Ok(indexes);
    }

    if plan
        .tasks
        .iter()
        .any(|task| task.status == RequirementTaskStatus::Running)
    {
        return Ok(Vec::new());
    }

    if plan.tasks.iter().any(|task| {
        matches!(
            task.status,
            RequirementTaskStatus::Pending | RequirementTaskStatus::Fixing
        )
    }) {
        return Err(AppError::internal("执行 DAG 存在无法满足的依赖"));
    }

    Ok(Vec::new())
}

fn dependencies_completed(
    plan: &RequirementExecutionPlan,
    task: &crate::models::RequirementExecutionTask,
) -> bool {
    task.depends_on.iter().all(|dependency| {
        plan.tasks.iter().any(|candidate| {
            candidate.id == *dependency && candidate.status == RequirementTaskStatus::Completed
        })
    })
}

fn review_sub_agents_finished(
    plan: &RequirementExecutionPlan,
    task: &crate::models::RequirementExecutionTask,
) -> bool {
    let Some(review_for) = task.review_for.as_deref() else {
        return false;
    };
    let sub_agents = plan
        .tasks
        .iter()
        .filter(|candidate| {
            candidate.kind == RequirementTaskKind::ReviewSubAgent
                && candidate.review_for.as_deref() == Some(review_for)
        })
        .collect::<Vec<_>>();
    !sub_agents.is_empty()
        && sub_agents.iter().all(|candidate| {
            matches!(
                candidate.status,
                RequirementTaskStatus::Completed | RequirementTaskStatus::Rejected
            )
        })
}

fn has_rejected_review_sub_agent(plan: &RequirementExecutionPlan, task_index: usize) -> bool {
    let Some(review_for) = plan.tasks[task_index].review_for.as_deref() else {
        return false;
    };
    plan.tasks.iter().any(|task| {
        task.kind == RequirementTaskKind::ReviewSubAgent
            && task.review_for.as_deref() == Some(review_for)
            && task.review_status == RequirementReviewStatus::Rejected
    })
}

fn reset_review_for(plan: &mut RequirementExecutionPlan, task_id: &str) {
    for candidate in &mut plan.tasks {
        if candidate.review_for.as_deref() == Some(task_id) {
            candidate.status = RequirementTaskStatus::Pending;
            candidate.review_status = RequirementReviewStatus::Pending;
            candidate.error = None;
        }
    }
}

fn approve_reviewed_task(
    plan: &mut RequirementExecutionPlan,
    review_task_id: &str,
    feedback: Option<String>,
) -> Result<(), AppError> {
    let review_for = plan
        .tasks
        .iter()
        .find(|task| task.id == review_task_id)
        .and_then(|task| task.review_for.clone())
        .ok_or_else(|| AppError::bad_request("审核节点缺少 review_for"))?;
    let task_kind = plan
        .tasks
        .iter()
        .find(|task| task.id == review_task_id)
        .map(|task| task.kind)
        .ok_or_else(|| AppError::bad_request("审核节点不存在"))?;
    let all_reviews_approved = task_kind == RequirementTaskKind::ReviewSummary
        || plan
            .tasks
            .iter()
            .filter(|task| {
                task.kind == RequirementTaskKind::Review
                    && task.review_for.as_deref() == Some(&review_for)
            })
            .all(|task| {
                task.id == review_task_id
                    || (task.status == RequirementTaskStatus::Completed
                        && task.review_status == RequirementReviewStatus::Approved)
            });

    let reviewed = plan
        .tasks
        .iter_mut()
        .find(|task| task.id == review_for)
        .ok_or_else(|| AppError::bad_request("审核目标不存在"))?;
    if all_reviews_approved {
        reviewed.status = RequirementTaskStatus::Completed;
        reviewed.review_status = RequirementReviewStatus::Approved;
    } else {
        reviewed.status = RequirementTaskStatus::AwaitingReview;
    }
    reviewed.last_review_feedback = feedback;
    Ok(())
}

fn reject_reviewed_task(
    plan: &mut RequirementExecutionPlan,
    review_task_id: &str,
    feedback: Option<String>,
) -> Result<(), AppError> {
    let review_for = plan
        .tasks
        .iter()
        .find(|task| task.id == review_task_id)
        .and_then(|task| task.review_for.clone())
        .ok_or_else(|| AppError::bad_request("审核节点缺少 review_for"))?;
    let reviewed_index = plan
        .tasks
        .iter()
        .position(|task| task.id == review_for)
        .ok_or_else(|| AppError::bad_request("审核目标不存在"))?;
    let reviewed = &mut plan.tasks[reviewed_index];
    reviewed.review_rejection_count = reviewed.review_rejection_count.saturating_add(1);
    reviewed.review_status = RequirementReviewStatus::Rejected;
    reviewed.last_review_feedback = feedback;
    match reviewed.review_rejection_count {
        count if count < MAX_REVIEW_REJECTIONS => {
            reviewed.status = RequirementTaskStatus::Fixing;
            reviewed.recovery_stage = RequirementRecoveryStage::None;
        }
        MAX_REVIEW_REJECTIONS => {
            reviewed.status = RequirementTaskStatus::Fixing;
            reviewed.recovery_stage = RequirementRecoveryStage::GuidedRetry;
        }
        count if count == MAX_REVIEW_REJECTIONS + 1 => {
            reviewed.status = RequirementTaskStatus::Fixing;
            reviewed.recovery_stage = RequirementRecoveryStage::HighTierExecution;
        }
        _ => {
            reviewed.status = RequirementTaskStatus::Failed;
            reviewed.recovery_stage = RequirementRecoveryStage::Exhausted;
        }
    }
    for task in &mut plan.tasks {
        if matches!(
            task.kind,
            RequirementTaskKind::Review
                | RequirementTaskKind::ReviewSubAgent
                | RequirementTaskKind::ReviewSummary
        ) && task.review_for.as_deref() == Some(review_for.as_str())
            && task.id != review_task_id
        {
            task.status = RequirementTaskStatus::Pending;
            task.review_status = RequirementReviewStatus::Pending;
            task.error = None;
        }
    }
    Ok(())
}

fn downstream_task_ids(
    plan: &RequirementExecutionPlan,
    task_id: &str,
) -> Result<Vec<String>, AppError> {
    if !plan.tasks.iter().any(|task| task.id == task_id) {
        return Err(AppError::bad_request("执行任务不存在"));
    }
    let mut affected = Vec::new();
    let mut changed = true;
    while changed {
        changed = false;
        for task in &plan.tasks {
            let downstream = task
                .depends_on
                .iter()
                .any(|dependency| dependency == task_id)
                || task
                    .depends_on
                    .iter()
                    .any(|dependency| affected.iter().any(|id| id == dependency));
            if downstream && !affected.iter().any(|id| id == &task.id) {
                affected.push(task.id.clone());
                changed = true;
            }
        }
    }
    Ok(affected)
}

fn reset_recovery_state(task: &mut crate::models::RequirementExecutionTask) {
    task.execution_failure_count = 0;
    task.review_rejection_count = 0;
    task.recovery_stage = RequirementRecoveryStage::None;
    task.failure_summary = None;
    task.recovery_guidance = None;
    task.high_tier_execution_used = false;
}

fn register_execution_failure(
    task: &mut crate::models::RequirementExecutionTask,
    summary: &str,
    error: &str,
    retryable: bool,
) -> bool {
    task.execution_failure_count = task.execution_failure_count.saturating_add(1);
    task.failure_summary = Some(summary.to_owned());
    task.error = Some(error.to_owned());
    if let Some(stage) = next_execution_recovery_stage(task.execution_failure_count, retryable) {
        task.recovery_stage = stage;
        task.status = if task.kind == RequirementTaskKind::Implementation {
            RequirementTaskStatus::Fixing
        } else {
            RequirementTaskStatus::Pending
        };
        true
    } else {
        task.status = RequirementTaskStatus::Failed;
        task.recovery_stage = RequirementRecoveryStage::Exhausted;
        false
    }
}

fn referenced_pi_session_paths(data: &AppData, session_dir: &Path) -> HashSet<PathBuf> {
    data.requirements
        .iter()
        .flat_map(|requirement| {
            requirement.pi_session_file.iter().chain(
                requirement
                    .execution_plan
                    .iter()
                    .flat_map(|plan| plan.tasks.iter())
                    .filter_map(|task| task.pi_session_file.as_ref()),
            )
        })
        .filter_map(|session_file| {
            let path = PathBuf::from(session_file);
            let resolved = if path.is_absolute() {
                path
            } else {
                session_dir.join(path)
            };
            if ensure_child_path(session_dir, &resolved).is_err() {
                return None;
            }
            Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
        })
        .collect()
}

fn ensure_no_running_tasks(plan: &RequirementExecutionPlan) -> Result<(), AppError> {
    if plan
        .tasks
        .iter()
        .any(|task| task.status == RequirementTaskStatus::Running)
    {
        return Err(AppError::bad_request(
            "需求正在执行，请等待当前任务结束后再恢复",
        ));
    }
    Ok(())
}

fn short_failure_summary(error: &AppError) -> String {
    error.to_string().chars().take(240).collect()
}

fn is_retryable_execution_error(error: &AppError) -> bool {
    match error {
        AppError::BadRequest(_) | AppError::NotFound(_) => false,
        AppError::Io(_) | AppError::Json(_) => true,
        AppError::Internal(message) | AppError::TaskExecution { message, .. } => ![
            "请先在模型设置",
            "模型不存在",
            "路径必须",
            "路径越界",
            "worktree 不存在",
            "aborted",
            "已中止",
            "分支",
            "提交",
            "commit",
        ]
        .iter()
        .any(|marker| message.contains(marker)),
    }
}

fn next_execution_recovery_stage(
    failure_count: u32,
    retryable: bool,
) -> Option<RequirementRecoveryStage> {
    if !retryable || failure_count > MAX_EXECUTION_FAILURES {
        return None;
    }
    Some(match failure_count {
        1 | 2 => RequirementRecoveryStage::AutoRetry,
        3 => RequirementRecoveryStage::GuidedRetry,
        _ => RequirementRecoveryStage::HighTierExecution,
    })
}

fn build_requirement_conversation(requirement: Requirement) -> RequirementConversationResponse {
    let mut items = Vec::new();
    for (index, message) in requirement.messages.iter().enumerate() {
        let id = format!("message-{index}");
        match message.role {
            RequirementMessageRole::User => items.push(RequirementConversationItem::User {
                id,
                text: message.content.clone(),
                created_at: message.created_at,
            }),
            RequirementMessageRole::Assistant => {
                items.push(RequirementConversationItem::Assistant {
                    id,
                    text: message.content.clone(),
                    created_at: message.created_at,
                })
            }
            RequirementMessageRole::System => items.push(RequirementConversationItem::Notice {
                id,
                level: RequirementNoticeLevel::Warn,
                text: message.content.clone(),
                created_at: message.created_at,
            }),
            RequirementMessageRole::Trace => items.push(RequirementConversationItem::Process {
                id,
                title: message.content.clone(),
                status: if requirement.status == RequirementStatus::Failed {
                    RequirementProcessStatus::Error
                } else {
                    RequirementProcessStatus::Done
                },
                metadata: message.metadata.clone(),
                created_at: message.created_at,
            }),
        }
    }

    let prompt = match requirement.status {
        RequirementStatus::Clarifying if !requirement.clarifications.is_empty() => {
            Some(RequirementConversationPrompt::Clarification {
                round: requirement.clarification_round,
                questions: requirement.clarifications.clone(),
            })
        }
        RequirementStatus::DraftReady => requirement
            .draft
            .clone()
            .map(|draft| RequirementConversationPrompt::Confirmation { draft }),
        _ => None,
    };

    let running = matches!(
        requirement.status,
        RequirementStatus::Analyzing | RequirementStatus::Planning | RequirementStatus::Running
    );

    if let Some(error) = &requirement.error {
        let has_error_notice = items.iter().any(|item| {
            matches!(
                item,
                RequirementConversationItem::Notice {
                    level: RequirementNoticeLevel::Warn,
                    text,
                    ..
                } if text.contains(error)
            )
        });
        if !has_error_notice {
            items.push(RequirementConversationItem::Notice {
                id: "requirement-error".to_owned(),
                level: RequirementNoticeLevel::Warn,
                text: error.clone(),
                created_at: requirement.updated_at,
            });
        }
    }

    RequirementConversationResponse {
        id: requirement.id,
        project_id: requirement.project_id,
        title: requirement.title,
        status: requirement.status,
        running,
        items,
        prompt,
        error: requirement.error,
        updated_at: requirement.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use chrono::Utc;

    use super::{
        next_execution_recovery_stage, reject_reviewed_task, runnable_task_indexes, JsonStore,
        RESTART_INTERRUPTION,
    };
    use crate::models::{
        Requirement, RequirementExecutionPlan, RequirementExecutionTask, RequirementMessage,
        RequirementMessageRole, RequirementModelTier, RequirementRecoveryStage,
        RequirementReviewStatus, RequirementStatus, RequirementTaskKind, RequirementTaskStatus,
    };

    #[test]
    fn runnable_tasks_wait_without_error_while_dependencies_are_running() {
        let plan = RequirementExecutionPlan {
            summary: "plan".to_owned(),
            tasks: vec![
                task(
                    "task-a",
                    RequirementTaskKind::Implementation,
                    RequirementTaskStatus::Running,
                ),
                task_with_dependencies(
                    "task-b",
                    RequirementTaskKind::Implementation,
                    RequirementTaskStatus::Pending,
                    vec!["task-a"],
                    None,
                ),
            ],
        };

        assert_eq!(runnable_task_indexes(&plan).unwrap(), Vec::<usize>::new());
    }

    #[test]
    fn runnable_tasks_can_start_review_while_parallel_task_is_running() {
        let plan = RequirementExecutionPlan {
            summary: "plan".to_owned(),
            tasks: vec![
                task(
                    "fast-task",
                    RequirementTaskKind::Implementation,
                    RequirementTaskStatus::AwaitingReview,
                ),
                task(
                    "slow-task",
                    RequirementTaskKind::Implementation,
                    RequirementTaskStatus::Running,
                ),
                task_with_dependencies(
                    "review-fast",
                    RequirementTaskKind::ReviewSubAgent,
                    RequirementTaskStatus::Pending,
                    vec!["fast-task"],
                    Some("fast-task"),
                ),
            ],
        };

        assert_eq!(runnable_task_indexes(&plan).unwrap(), vec![2]);
    }

    #[test]
    fn review_rejections_escalate_after_five_rounds() {
        let mut plan = RequirementExecutionPlan {
            summary: "plan".to_owned(),
            tasks: vec![
                task(
                    "implementation",
                    RequirementTaskKind::Implementation,
                    RequirementTaskStatus::AwaitingReview,
                ),
                task_with_dependencies(
                    "summary",
                    RequirementTaskKind::ReviewSummary,
                    RequirementTaskStatus::Rejected,
                    vec!["implementation"],
                    Some("implementation"),
                ),
            ],
        };

        for count in 1..=7 {
            reject_reviewed_task(&mut plan, "summary", Some(format!("第 {count} 轮"))).unwrap();
            let implementation = &plan.tasks[0];
            assert_eq!(implementation.review_rejection_count, count);
            assert_eq!(
                implementation.recovery_stage,
                match count {
                    1..=4 => RequirementRecoveryStage::None,
                    5 => RequirementRecoveryStage::GuidedRetry,
                    6 => RequirementRecoveryStage::HighTierExecution,
                    _ => RequirementRecoveryStage::Exhausted,
                }
            );
        }
        assert_eq!(plan.tasks[0].status, RequirementTaskStatus::Failed);
    }

    #[test]
    fn execution_failures_have_a_finite_escalation_path() {
        assert_eq!(
            next_execution_recovery_stage(1, true),
            Some(RequirementRecoveryStage::AutoRetry)
        );
        assert_eq!(
            next_execution_recovery_stage(2, true),
            Some(RequirementRecoveryStage::AutoRetry)
        );
        assert_eq!(
            next_execution_recovery_stage(3, true),
            Some(RequirementRecoveryStage::GuidedRetry)
        );
        assert_eq!(
            next_execution_recovery_stage(4, true),
            Some(RequirementRecoveryStage::HighTierExecution)
        );
        assert_eq!(next_execution_recovery_stage(5, true), None);
        assert_eq!(next_execution_recovery_stage(1, false), None);
    }

    #[tokio::test]
    async fn startup_recovery_persists_interrupted_tasks_and_returns_all_running_requirements() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("data/app.json");
        let mut store = JsonStore::open(path.clone()).await.unwrap();
        let mut interrupted = requirement("interrupted");
        interrupted.execution_plan = Some(RequirementExecutionPlan {
            summary: "plan".to_owned(),
            tasks: vec![
                task(
                    "implementation",
                    RequirementTaskKind::Implementation,
                    RequirementTaskStatus::Running,
                ),
                task(
                    "merge",
                    RequirementTaskKind::BranchMerge,
                    RequirementTaskStatus::Running,
                ),
            ],
        });
        let mut waiting = requirement("waiting");
        waiting.execution_plan = Some(RequirementExecutionPlan {
            summary: "plan".to_owned(),
            tasks: vec![task(
                "pending",
                RequirementTaskKind::Implementation,
                RequirementTaskStatus::Pending,
            )],
        });
        store.data.requirements = vec![interrupted, waiting];
        crate::utils::write_json(&store.path, &store.data)
            .await
            .unwrap();

        let requirement_ids = store.recover_interrupted_requirements().await.unwrap();

        assert_eq!(requirement_ids, vec!["interrupted", "waiting"]);
        let task = &store.data.requirements[0]
            .execution_plan
            .as_ref()
            .unwrap()
            .tasks[0];
        assert_eq!(task.status, RequirementTaskStatus::Fixing);
        assert_eq!(task.execution_failure_count, 1);
        assert_eq!(task.recovery_stage, RequirementRecoveryStage::AutoRetry);
        assert_eq!(task.failure_summary.as_deref(), Some(RESTART_INTERRUPTION));
        assert_eq!(task.error.as_deref(), Some(RESTART_INTERRUPTION));
        assert_eq!(
            store.data.requirements[0]
                .execution_plan
                .as_ref()
                .unwrap()
                .tasks[1]
                .status,
            RequirementTaskStatus::Pending
        );

        let reopened = JsonStore::open(path).await.unwrap();
        assert_eq!(
            reopened.data.requirements[0]
                .execution_plan
                .as_ref()
                .unwrap()
                .tasks[0]
                .status,
            RequirementTaskStatus::Fixing
        );
    }

    #[tokio::test]
    async fn stale_pi_session_cleanup_keeps_requirement_and_task_references() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut store = JsonStore::open(temp_dir.path().join("data/app.json"))
            .await
            .unwrap();
        let session_dir = store.data_root.join("pi-sessions");
        tokio::fs::create_dir_all(&session_dir).await.unwrap();
        let requirement_session = session_dir.join("requirement.jsonl");
        let task_session = session_dir.join("task.jsonl");
        let stale_session = session_dir.join("stale.jsonl");
        let ignored_file = session_dir.join("ignored.txt");
        for path in [
            &requirement_session,
            &task_session,
            &stale_session,
            &ignored_file,
        ] {
            tokio::fs::write(path, b"session").await.unwrap();
        }

        let mut active = requirement("active");
        active.pi_session_file = Some(requirement_session.to_string_lossy().to_string());
        let mut active_task = task(
            "task",
            RequirementTaskKind::Implementation,
            RequirementTaskStatus::Pending,
        );
        active_task.pi_session_file = Some(task_session.to_string_lossy().to_string());
        active.execution_plan = Some(RequirementExecutionPlan {
            summary: "plan".to_owned(),
            tasks: vec![active_task],
        });
        store.data.requirements.push(active);

        store
            .cleanup_unreferenced_pi_sessions_before(SystemTime::now() + Duration::from_secs(60))
            .await;

        assert!(requirement_session.exists());
        assert!(task_session.exists());
        assert!(!stale_session.exists());
        assert!(ignored_file.exists());
    }

    fn requirement(id: &str) -> Requirement {
        let now = Utc::now();
        Requirement {
            id: id.to_owned(),
            project_id: "project".to_owned(),
            title: id.to_owned(),
            original_message: id.to_owned(),
            status: RequirementStatus::Running,
            messages: vec![RequirementMessage {
                role: RequirementMessageRole::User,
                content: id.to_owned(),
                metadata: None,
                created_at: now,
            }],
            clarification_round: 0,
            clarifications: Vec::new(),
            draft: None,
            execution_plan: None,
            pi_session_file: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn task(
        id: &str,
        kind: RequirementTaskKind,
        status: RequirementTaskStatus,
    ) -> RequirementExecutionTask {
        task_with_dependencies(id, kind, status, Vec::new(), None)
    }

    fn task_with_dependencies(
        id: &str,
        kind: RequirementTaskKind,
        status: RequirementTaskStatus,
        depends_on: Vec<&str>,
        review_for: Option<&str>,
    ) -> RequirementExecutionTask {
        RequirementExecutionTask {
            id: id.to_owned(),
            title: id.to_owned(),
            description: id.to_owned(),
            depends_on: depends_on.into_iter().map(str::to_owned).collect(),
            kind,
            model_tier: RequirementModelTier::Medium,
            timeout_seconds: 60,
            pi_session_file: None,
            branch_name: None,
            worktree_path: None,
            commit_sha: None,
            review_for: review_for.map(str::to_owned),
            review_angle: None,
            review_status: RequirementReviewStatus::Pending,
            attempt: 0,
            execution_failure_count: 0,
            review_rejection_count: 0,
            recovery_stage: RequirementRecoveryStage::None,
            failure_summary: None,
            recovery_guidance: None,
            high_tier_execution_used: false,
            last_review_feedback: None,
            pull_request_url: None,
            merged_into: None,
            cleanup_summary: None,
            execution_warning: None,
            trace: None,
            status,
            target_files: Vec::new(),
            result_summary: None,
            error: None,
        }
    }
}
