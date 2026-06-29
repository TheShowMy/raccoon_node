fn is_terminal_agent_end(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("agent_end")
        && event.get("willRetry").and_then(Value::as_bool) != Some(true)
}

fn attach_session_usage(
    mut trace: Option<Value>,
    stats: &Value,
    session_reused: bool,
) -> Option<Value> {
    let trace_data = trace.as_mut()?.get_mut("trace")?.as_object_mut()?;
    let tokens = stats.get("tokens").unwrap_or(&Value::Null);
    let context = stats.get("contextUsage").unwrap_or(&Value::Null);
    let input = tokens.get("input").and_then(Value::as_u64).unwrap_or(0);
    let output = tokens.get("output").and_then(Value::as_u64).unwrap_or(0);
    let cache_read = tokens.get("cacheRead").and_then(Value::as_u64).unwrap_or(0);
    let cache_write = tokens
        .get("cacheWrite")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    trace_data.insert(
        "usage".to_owned(),
        json!({
            "sessionReused": session_reused,
            "callCount": stats.get("assistantMessages").and_then(Value::as_u64).unwrap_or(0),
            "input": input,
            "output": output,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
            "context": {
                "tokens": context.get("tokens").and_then(Value::as_u64).unwrap_or(0),
                "window": context.get("contextWindow").and_then(Value::as_u64).unwrap_or(0),
                "percent": context.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
            },
        }),
    );
    trace
}

fn requirement_analysis_failure(
    failure: PiResponseFailure,
    pi_session_file: Option<String>,
) -> RequirementAnalysisOutput {
    RequirementAnalysisOutput {
        status: crate::models::RequirementStatus::Failed,
        assistant_message: failure.message.clone(),
        progress: String::new(),
        clarifications: Vec::new(),
        draft: None,
        pi_session_file,
        error: Some(failure.message),
        trace: failure.trace,
    }
}

fn pi_response_failure_error(failure: PiResponseFailure) -> AppError {
    let trace_summary = failure
        .trace
        .as_ref()
        .map(trace_summary)
        .unwrap_or_else(|| "none".to_owned());
    tracing::error!(
        error = %failure.message,
        trace_summary = %trace_summary,
        "Pi Agent RPC returned a failed run"
    );
    if let Some(trace) = &failure.trace {
        tracing::debug!(error = %failure.message, trace = %trace, "Pi Agent RPC failed trace");
    }
    AppError::internal(failure.message)
}

fn trace_summary(trace: &Value) -> String {
    let trace_obj = match trace.get("trace") {
        Some(Value::Object(obj)) => obj,
        _ => return "malformed".to_owned(),
    };
    let status_count = trace_obj
        .get("statuses")
        .and_then(Value::as_array)
        .map(|statuses| statuses.len())
        .unwrap_or(0);
    let last_status = trace_obj
        .get("statuses")
        .and_then(Value::as_array)
        .and_then(|statuses| statuses.last())
        .and_then(|status| status.get("message").and_then(Value::as_str))
        .unwrap_or("");
    let truncated = if last_status.chars().count() > 80 {
        format!("{}...", last_status.chars().take(80).collect::<String>())
    } else {
        last_status.to_owned()
    };
    format!("statuses={status_count} last=\"{truncated}\"")
}

async fn prepare_task_workspace(
    data_root: &Path,
    input: &RequirementTaskExecutionInput,
) -> Result<(PathBuf, Option<String>, Option<PathBuf>), AppError> {
    match input.task.kind {
        RequirementTaskKind::Review
        | RequirementTaskKind::ReviewSubAgent
        | RequirementTaskKind::ReviewSummary => {
            let review_for = input
                .task
                .review_for
                .as_deref()
                .ok_or_else(|| AppError::bad_request("审核节点缺少 review_for"))?;
            let reviewed = input
                .plan
                .tasks
                .iter()
                .find(|task| task.id == review_for)
                .ok_or_else(|| AppError::bad_request("审核目标不存在"))?;
            let worktree = reviewed
                .worktree_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(&input.project.local_path));
            let worktree = normalize_local_path(&worktree)?;
            ensure_child_path(data_root, &worktree)?;
            if !worktree.exists() {
                return Err(AppError::internal("恢复审核失败：目标 worktree 不存在"));
            }
            let commit = reviewed
                .commit_sha
                .as_deref()
                .ok_or_else(|| AppError::internal("恢复审核失败：审核目标缺少提交"))?;
            ensure_commit_exists(&worktree, commit).await?;
            ensure_head_matches(&worktree, commit).await?;
            Ok((worktree, None, None))
        }
        RequirementTaskKind::Implementation
        | RequirementTaskKind::BranchMerge
        | RequirementTaskKind::MergeReview => {
            let repo = resolve_project_working_dir(data_root, &input.project.local_path)?;
            let branch = input
                .task
                .branch_name
                .clone()
                .unwrap_or_else(|| task_branch_name(&input.requirement.id, &input.task.id));
            let worktree = input
                .task
                .worktree_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    task_worktree_path(data_root, &input.project.id, &input.task.id)
                });
            let worktree = normalize_local_path(&worktree)?;
            ensure_child_path(data_root, &worktree)?;

            let existed = worktree.join(".git").exists();
            let recovering = input.task.worktree_path.is_some()
                || input.task.branch_name.is_some()
                || input.task.commit_sha.is_some();
            if recovering && !existed {
                return Err(AppError::internal("恢复节点失败：worktree 不存在"));
            }
            if let Some(existing_branch) = input.task.branch_name.as_deref() {
                ensure_branch_exists(&repo, existing_branch).await?;
            }
            if let Some(commit) = input.task.commit_sha.as_deref() {
                ensure_commit_exists(&repo, commit).await?;
            }
            if !existed {
                if let Some(parent) = worktree.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                let dependency_commits = task_dependency_commits(input);
                let base_ref = dependency_commits
                    .first()
                    .map(String::as_str)
                    .unwrap_or("HEAD");
                git(
                    &repo,
                    &[
                        "worktree",
                        "add",
                        "-B",
                        &branch,
                        path_str(&worktree)?,
                        base_ref,
                    ],
                )
                .await?;
                merge_dependency_commits(&worktree, dependency_commits.into_iter().skip(1)).await?;
            }
            Ok((worktree.clone(), Some(branch), Some(worktree)))
        }
    }
}

async fn ensure_branch_exists(repo: &Path, branch: &str) -> Result<(), AppError> {
    git(repo, &["rev-parse", "--verify", branch])
        .await
        .map(|_| ())
        .map_err(|_| AppError::internal(format!("恢复节点失败：分支 {branch} 不存在")))
}

async fn ensure_commit_exists(repo: &Path, commit: &str) -> Result<(), AppError> {
    let commit_ref = format!("{commit}^{{commit}}");
    git(repo, &["cat-file", "-e", &commit_ref])
        .await
        .map(|_| ())
        .map_err(|_| AppError::internal(format!("恢复节点失败：提交 {commit} 不可达")))
}

async fn ensure_head_matches(repo: &Path, expected: &str) -> Result<(), AppError> {
    let head = git(repo, &["rev-parse", "HEAD"]).await?;
    if head.trim() != expected {
        return Err(AppError::internal(format!(
            "恢复审核失败：worktree HEAD {} 与审核提交 {expected} 不一致",
            head.trim()
        )));
    }
    Ok(())
}

fn task_dependency_commits(input: &RequirementTaskExecutionInput) -> Vec<String> {
    dependency_commits_for_task(&input.task, &input.plan)
}

fn dependency_commits_for_task(
    task: &crate::models::RequirementExecutionTask,
    plan: &crate::models::RequirementExecutionPlan,
) -> Vec<String> {
    match task.kind {
        RequirementTaskKind::Implementation
        | RequirementTaskKind::BranchMerge
        | RequirementTaskKind::MergeReview => task
            .depends_on
            .iter()
            .filter_map(|dependency| {
                plan.tasks
                    .iter()
                    .find(|task| task.id == *dependency)
                    .and_then(|task| task.commit_sha.clone())
            })
            .collect(),
        RequirementTaskKind::Review
        | RequirementTaskKind::ReviewSubAgent
        | RequirementTaskKind::ReviewSummary => Vec::new(),
    }
}

async fn merge_dependency_commits(
    worktree: &Path,
    commits: impl Iterator<Item = String>,
) -> Result<(), AppError> {
    for commit in commits {
        git(worktree, &["merge", "--no-ff", "--no-edit", &commit]).await?;
    }
    Ok(())
}

async fn commit_task_changes(
    task: &crate::models::RequirementExecutionTask,
    output: &mut RequirementTaskExecutionOutput,
) -> Result<String, AppError> {
    let fixing_commit = if task.kind == RequirementTaskKind::Implementation
        && task.status == crate::models::RequirementTaskStatus::Fixing
    {
        Some(
            task.commit_sha
                .as_deref()
                .ok_or_else(|| AppError::internal("修复实现节点缺少旧 commit_sha"))?,
        )
    } else {
        None
    };
    let worktree = task
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::internal("执行节点缺少 worktree_path"))?;
    let status = git(&worktree, &["status", "--porcelain"]).await?;
    if !status.trim().is_empty() {
        git(&worktree, &["add", "-A"]).await?;
        let message = format!("raccoon_node: {}", task.title);
        git(&worktree, &["commit", "-m", &message]).await?;
    } else if task.kind == RequirementTaskKind::Implementation {
        if fixing_commit.is_some() {
            return Err(AppError::internal("修复实现节点必须产生实际代码改动"));
        }
        let no_op_reason = output
            .no_op_reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| !reason.is_empty());
        if output.changed == Some(false) {
            if let Some(no_op_reason) = no_op_reason {
                output.execution_warning = Some(format!(
                    "未产生新提交：{no_op_reason}。按 no-op 完成并进入审核。"
                ));
            } else {
                return Err(AppError::internal(
                    "实现节点未产生提交，且缺少 no_op_reason",
                ));
            }
        } else {
            return Err(AppError::internal("实现节点没有产生可提交改动"));
        }
    }
    let commit = git(&worktree, &["rev-parse", "HEAD"])
        .await
        .map(|sha| sha.trim().to_owned())?;
    if fixing_commit == Some(commit.as_str()) {
        return Err(AppError::internal("修复实现节点没有产生新的代码版本"));
    }
    Ok(commit)
}

struct PublishResult {
    pull_request_url: String,
    merged_into: String,
    cleanup_summary: String,
}

async fn publish_merge_review(
    data_root: &Path,
    input: &RequirementTaskExecutionInput,
    output: &RequirementTaskExecutionOutput,
) -> Result<PublishResult, AppError> {
    let repo = resolve_project_working_dir(data_root, &input.project.local_path)?;
    let branch = output
        .branch_name
        .as_deref()
        .ok_or_else(|| AppError::internal("最终合并节点缺少分支名"))?;
    let commit = output
        .commit_sha
        .as_deref()
        .ok_or_else(|| AppError::internal("最终合并节点缺少提交"))?;
    let base_branch = default_branch(&repo).await?;

    git(&repo, &["push", "-u", "origin", branch]).await?;
    let pr_url = ensure_pull_request(&repo, &base_branch, branch, input).await?;
    if !pull_request_is_merged(&repo, &pr_url).await {
        let merge_args = build_pr_merge_args(&pr_url, commit);
        run_gh(
            &repo,
            &merge_args.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        .await?;
    }
    git(&repo, &["fetch", "origin"]).await?;
    git(&repo, &["checkout", &base_branch]).await?;
    git(
        &repo,
        &["reset", "--hard", &format!("origin/{base_branch}")],
    )
    .await?;
    let cleanup_summary = cleanup_requirement_branches(data_root, &repo, input).await;

    Ok(PublishResult {
        pull_request_url: pr_url,
        merged_into: base_branch,
        cleanup_summary,
    })
}

async fn default_branch(repo: &Path) -> Result<String, AppError> {
    let output = git(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
    .unwrap_or_default();
    Ok(parse_default_branch(&output))
}

fn parse_default_branch(output: &str) -> String {
    let branch = output
        .trim()
        .strip_prefix("origin/")
        .unwrap_or(output.trim())
        .trim();
    if branch.is_empty() {
        "main".to_owned()
    } else {
        branch.to_owned()
    }
}

async fn ensure_pull_request(
    repo: &Path,
    base_branch: &str,
    branch: &str,
    input: &RequirementTaskExecutionInput,
) -> Result<String, AppError> {
    if let Ok(url) = run_gh(
        repo,
        &["pr", "view", branch, "--json", "url", "--jq", ".url"],
    )
    .await
    {
        let url = url.trim();
        if !url.is_empty() {
            return Ok(url.to_owned());
        }
    }

    let title = format!("raccoon_node: {}", input.requirement.title);
    let body = format!(
        "自动合并需求：{}\n\n{}",
        input.requirement.title,
        input
            .requirement
            .draft
            .as_ref()
            .map(|draft| draft.summary.as_str())
            .unwrap_or("无摘要")
    );
    let args = [
        "pr",
        "create",
        "--base",
        base_branch,
        "--head",
        branch,
        "--title",
        &title,
        "--body",
        &body,
    ];
    let url = run_gh(repo, &args).await?;
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::internal("gh pr create 未返回 PR 地址"));
    }
    Ok(url.to_owned())
}

async fn pull_request_is_merged(repo: &Path, pr_url: &str) -> bool {
    run_gh(
        repo,
        &["pr", "view", pr_url, "--json", "state", "--jq", ".state"],
    )
    .await
    .is_ok_and(|state| state.trim() == "MERGED")
}

fn build_pr_merge_args(pr_url: &str, commit: &str) -> Vec<String> {
    vec![
        "pr".to_owned(),
        "merge".to_owned(),
        pr_url.to_owned(),
        "--merge".to_owned(),
        "--match-head-commit".to_owned(),
        commit.to_owned(),
    ]
}

async fn cleanup_requirement_branches(
    data_root: &Path,
    repo: &Path,
    input: &RequirementTaskExecutionInput,
) -> String {
    let branches = generated_branch_names(
        input
            .plan
            .tasks
            .iter()
            .chain(std::iter::once(&input.task))
            .filter_map(|task| task.branch_name.as_deref()),
    );
    let worktrees = input
        .plan
        .tasks
        .iter()
        .chain(std::iter::once(&input.task))
        .filter_map(|task| task.worktree_path.as_deref())
        .map(PathBuf::from)
        .collect::<BTreeSet<_>>();

    let mut removed_worktrees = 0;
    for worktree in worktrees {
        if ensure_child_path(data_root, &worktree).is_ok() && worktree.exists() {
            let Ok(worktree_str) = path_str(&worktree) else {
                continue;
            };
            if git(repo, &["worktree", "remove", "--force", worktree_str])
                .await
                .is_ok()
            {
                removed_worktrees += 1;
            }
        }
    }

    let mut removed_local = 0;
    let mut removed_remote = 0;
    for branch in branches {
        if git(repo, &["branch", "-D", &branch]).await.is_ok() {
            removed_local += 1;
        }
        if git(repo, &["push", "origin", "--delete", &branch])
            .await
            .is_ok()
        {
            removed_remote += 1;
        }
    }

    format!(
        "已清理 worktree {removed_worktrees} 个、本地分支 {removed_local} 个、远端分支 {removed_remote} 个"
    )
}

fn generated_branch_names<'a>(branches: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    branches
        .filter(|branch| branch.starts_with("rn/"))
        .map(ToOwned::to_owned)
        .collect()
}

async fn git(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let dir = normalize_local_path(dir)?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(args)
        .output()
        .await?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::internal(format!(
        "git {} 失败：{}",
        args.join(" "),
        stderr.trim()
    )))
}

async fn run_gh(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let dir = normalize_local_path(dir)?;
    let output = Command::new("gh")
        .args(args)
        .current_dir(&dir)
        .output()
        .await?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::internal(format!(
        "gh {} 失败：{}",
        args.join(" "),
        stderr.trim()
    )))
}

fn task_branch_name(requirement_id: &str, task_id: &str) -> String {
    format!("rn/{}/{}", slug(requirement_id), slug(task_id))
}

fn task_worktree_path(data_root: &Path, project_id: &str, task_id: &str) -> PathBuf {
    data_root
        .join("projects")
        .join(project_id)
        .join("worktrees")
        .join(safe_worktree_name(task_id))
}

fn safe_worktree_name(value: &str) -> String {
    const MAX_LEN: usize = 80;
    let mut name = slug(value);
    if is_windows_reserved_name(&name) {
        name.insert(0, '_');
    }
    if name.len() <= MAX_LEN {
        return name;
    }
    let hash = value.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{}-{hash:08x}", &name[..MAX_LEN - 17])
}

fn is_windows_reserved_name(value: &str) -> bool {
    let value = value.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    matches!(value.as_str(), "con" | "prn" | "aux" | "nul")
        || matches!(
            value
                .strip_prefix("com")
                .and_then(|value| value.parse::<u8>().ok()),
            Some(1..=9)
        )
        || matches!(
            value
                .strip_prefix("lpt")
                .and_then(|value| value.parse::<u8>().ok()),
            Some(1..=9)
        )
}

fn slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if slug.is_empty() {
        "node".to_owned()
    } else {
        slug
    }
}

fn path_str(path: &Path) -> Result<&str, AppError> {
    path.to_str()
        .ok_or_else(|| AppError::internal("路径不是有效 UTF-8"))
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left)
        .ok()
        .and_then(|path| normalize_local_path(&path).ok())
        .unwrap_or_else(|| left.to_path_buf());
    let right = std::fs::canonicalize(right)
        .ok()
        .and_then(|path| normalize_local_path(&path).ok())
        .unwrap_or_else(|| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn parse_session_header_cwd(line: &str) -> Result<PathBuf, AppError> {
    if line.len() > 8192 {
        return Err(AppError::internal("Pi Agent 会话头过长"));
    }
    let header: Value = serde_json::from_str(line.trim())?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err(AppError::internal("Pi Agent 会话首行类型错误"));
    }
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("Pi Agent 会话缺少 cwd"))?;
    let cwd = normalize_local_path(Path::new(cwd))?;
    if !cwd.is_absolute() {
        return Err(AppError::internal("Pi Agent 会话 cwd 不是绝对路径"));
    }
    Ok(cwd)
}

fn session_header_matches_working_dir(header: &str, expected: &Path) -> bool {
    parse_session_header_cwd(header).is_ok_and(|actual| same_path(&actual, expected))
}

impl Drop for PiRpcClient {
    fn drop(&mut self) {
        if let Ok(mut io) = self.io.try_lock() {
            let _ = io.child.start_kill();
        }
    }
}
