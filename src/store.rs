use std::path::PathBuf;

use chrono::Utc;

use crate::error::AppError;
use crate::models::{
    AppData, ClarificationAnswer, ModelSettings, PiModel, Project, ProjectCanvasResponse,
    Requirement, RequirementAnalysisInput, RequirementAnalysisOutput, RequirementConversationItem,
    RequirementConversationPrompt, RequirementConversationResponse, RequirementExecutionPlan,
    RequirementMessage, RequirementMessageRole, RequirementNoticeLevel, RequirementPlanInput,
    RequirementProcessStatus, RequirementReviewStatus, RequirementStatus,
    RequirementTaskExecutionInput, RequirementTaskExecutionOutput, RequirementTaskKind,
    RequirementTaskStatus,
};
use crate::utils::{
    build_clarification_answer_summary, clarification_has_answer, clone_git_repo,
    data_root_from_file, derive_requirement_title, ensure_child_path, remove_dir_if_exists,
    slugify, sort_requirements_desc, validate_git_url, validate_model_settings, write_json,
};

const MAX_REVIEW_ATTEMPTS: u32 = 3;

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
        let data = serde_json::from_str(&content)?;
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
            plan.tasks[*task_index].status = RequirementTaskStatus::Running;
            plan.tasks[*task_index].error = None;
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
    ) -> Result<(), AppError> {
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
                let task_kind = plan.tasks[task_index].kind;
                let task_title = plan.tasks[task_index].title.clone();
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
                    task.attempt = task.attempt.saturating_add(1);
                    task.result_summary = Some(output.result_summary.clone());
                    task.error = None;
                    match task_kind {
                        RequirementTaskKind::Implementation => {
                            task.status = RequirementTaskStatus::AwaitingReview;
                        }
                        RequirementTaskKind::Review => {
                            let review_status = output
                                .review_status
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
                            review_update = Some(review_status);
                        }
                        RequirementTaskKind::MergeReview => {
                            task.review_status = output
                                .review_status
                                .unwrap_or(RequirementReviewStatus::Approved);
                            task.last_review_feedback = output.review_feedback.clone();
                            task.status = if task.review_status == RequirementReviewStatus::Approved
                            {
                                RequirementTaskStatus::Completed
                            } else {
                                RequirementTaskStatus::Rejected
                            };
                        }
                    }
                }
                match task_kind {
                    RequirementTaskKind::Implementation => {
                        reset_review_for(plan, task_id);
                    }
                    RequirementTaskKind::Review => {
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
                    RequirementTaskKind::MergeReview => {}
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
                plan.tasks[task_index].status = RequirementTaskStatus::Failed;
                plan.tasks[task_index].error = Some(error.to_string());
                requirement.status = RequirementStatus::Failed;
                requirement.error = Some(format!("任务「{}」执行失败：{error}", task_title));
                requirement.updated_at = now;
                requirement.messages.push(RequirementMessage {
                    role: RequirementMessageRole::System,
                    content: format!("任务「{}」执行失败：{error}", task_title),
                    metadata: None,
                    created_at: now,
                });
            }
        }
        write_json(&self.path, &self.data).await?;
        Ok(())
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
        let affected = downstream_task_ids(plan, task_id)?;
        for task in &mut plan.tasks {
            if task.id == task_id || affected.iter().any(|id| id == &task.id) {
                task.status = RequirementTaskStatus::Pending;
                task.review_status = RequirementReviewStatus::Pending;
                task.error = None;
                task.result_summary = None;
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
        let task = plan
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| AppError::bad_request("执行任务不存在"))?;
        if task.kind != RequirementTaskKind::Review {
            return Err(AppError::bad_request("只能重跑审核节点"));
        }
        task.status = RequirementTaskStatus::Pending;
        task.review_status = RequirementReviewStatus::Pending;
        task.error = None;
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
        if task.kind == RequirementTaskKind::Review {
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

        if dependencies_completed(plan, task) {
            indexes.push(index);
        }
    }
    if !indexes.is_empty() {
        return Ok(indexes);
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
    let all_reviews_approved = plan
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
    let reviewed_status = if plan.tasks[reviewed_index].attempt >= MAX_REVIEW_ATTEMPTS {
        RequirementTaskStatus::Failed
    } else {
        RequirementTaskStatus::Fixing
    };
    plan.tasks[reviewed_index].review_status = RequirementReviewStatus::Rejected;
    plan.tasks[reviewed_index].last_review_feedback = feedback;
    plan.tasks[reviewed_index].status = reviewed_status;
    for task in &mut plan.tasks {
        if task.kind == RequirementTaskKind::Review
            && task.review_for.as_deref() == Some(review_for.as_str())
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
