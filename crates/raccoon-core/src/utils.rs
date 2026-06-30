use std::{
    path::{Component, Path, PathBuf},
    process::Command,
};

use chrono::Utc;

use crate::error::AppError;
use crate::models::{
    AppData, ClarificationAnswer, ClarificationQuestionType, ModelSettings, PiModel, Requirement,
    RequirementClarification,
};

pub fn ensure_child_path(root: &Path, child: &Path) -> Result<(), AppError> {
    let root_canonical = normalize_local_path(
        &std::fs::canonicalize(root).map_err(|_| AppError::bad_request("无法解析根目录"))?,
    )?;

    let resolved = if child.is_absolute() {
        child.to_path_buf()
    } else {
        root_canonical.join(child)
    };

    // For existing paths, canonicalize gives the most robust check.
    if let Ok(child_canonical) = std::fs::canonicalize(&resolved) {
        if !normalize_local_path(&child_canonical)?.starts_with(&root_canonical) {
            return Err(AppError::bad_request("路径必须位于数据目录内"));
        }
        return Ok(());
    }

    // For not-yet-existing paths, normalize `.` and `..` components manually
    // and verify the result still lives under the root. On macOS, temporary
    // directories live under `/var` which symlinks to `/private/var`, so we
    // also attempt to canonicalize the longest existing prefix and append the
    // remaining tail relative to the canonical root.
    let normalized = normalize_local_path(&normalize_path(&resolved))?;
    if normalized.starts_with(&root_canonical) {
        return Ok(());
    }

    if let Some(resolved_under_root) = resolve_under_root(&root_canonical, &resolved)
        && resolved_under_root.starts_with(&root_canonical)
    {
        return Ok(());
    }

    Err(AppError::bad_request("路径必须位于数据目录内"))
}

fn resolve_under_root(_root_canonical: &Path, child: &Path) -> Option<PathBuf> {
    // Walk up from `child` until we find an existing directory, canonicalize
    // it, then append the components we walked back down.
    let mut existing = child.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();

    loop {
        if let Ok(canonical) = std::fs::canonicalize(&existing) {
            let mut result = normalize_local_path(&canonical).ok()?;
            for component in tail.into_iter().rev() {
                result.push(component);
            }
            return Some(result);
        }

        match existing.parent() {
            Some(parent) => {
                if let Some(file_name) = existing.file_name() {
                    tail.push(file_name.to_os_string());
                }
                existing = parent.to_path_buf();
            }
            None => return None,
        }
    }
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    result.push("..");
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

pub fn normalize_local_path(path: &Path) -> Result<PathBuf, AppError> {
    normalize_local_path_impl(path)
        .map_err(|message| AppError::bad_request(format!("不支持的路径：{message}")))
}

pub fn resolve_git_root(explicit: Option<&Path>, cwd: &Path) -> Result<PathBuf, AppError> {
    let start = explicit.unwrap_or(cwd);
    let canonical = std::fs::canonicalize(start)
        .map_err(|_| AppError::bad_request("项目目录不存在或无法访问"))?;
    let canonical = normalize_local_path(&canonical)?;
    if !canonical.is_dir() {
        return Err(AppError::bad_request("项目目录必须是目录"));
    }

    let candidate = if explicit.is_some() {
        if !canonical.join(".git").exists() {
            return Err(AppError::bad_request(
                "--project-root 必须直接指向 Git 仓库根目录",
            ));
        }
        canonical
    } else {
        canonical
            .ancestors()
            .find(|path| path.join(".git").exists())
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::bad_request("当前目录不在 Git 仓库中"))?
    };

    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&candidate)
        .output()
        .map_err(|error| AppError::bad_request(format!("无法执行 Git：{error}")))?;
    if !output.status.success() {
        return Err(AppError::bad_request("无法验证 Git 仓库根目录"));
    }
    let reported = String::from_utf8(output.stdout)
        .map_err(|_| AppError::bad_request("Git 返回了无效的仓库路径"))?;
    let reported = std::fs::canonicalize(reported.trim())
        .map_err(|_| AppError::bad_request("无法解析 Git 仓库根目录"))?;
    let reported = normalize_local_path(&reported)?;
    if reported != candidate {
        return Err(AppError::bad_request(
            "--project-root 必须直接指向 Git 仓库根目录",
        ));
    }
    Ok(candidate)
}

pub fn git_remote_origin(project_root: &Path) -> String {
    Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(project_root)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

#[cfg(windows)]
fn normalize_local_path_impl(path: &Path) -> Result<PathBuf, &'static str> {
    normalize_windows_path_value(&path.to_string_lossy())
}

#[cfg(any(windows, test))]
fn normalize_windows_path_value(value: &str) -> Result<PathBuf, &'static str> {
    if value.starts_with(r"\\?\UNC\") {
        return Err("Windows 仅支持本地磁盘路径，不支持 UNC 网络路径");
    }
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        let bytes = stripped.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/')
        {
            return Ok(PathBuf::from(stripped));
        }
        return Err("Windows 扩展路径不是本地磁盘绝对路径");
    }
    if value.starts_with(r"\\") || value.starts_with("//") {
        return Err("Windows 仅支持本地磁盘路径，不支持 UNC 网络路径");
    }
    Ok(PathBuf::from(value))
}

#[cfg(not(windows))]
fn normalize_local_path_impl(path: &Path) -> Result<PathBuf, &'static str> {
    Ok(path.to_path_buf())
}

pub fn derive_requirement_title(message: &str) -> String {
    let compact = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(24)
        .collect::<String>();
    if compact.is_empty() {
        "未命名需求".to_owned()
    } else {
        compact
    }
}

pub fn sort_requirements_desc(requirements: &mut [Requirement]) {
    requirements.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
}

pub fn data_root_from_file(path: &Path) -> Result<PathBuf, AppError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let canonical =
        std::fs::canonicalize(parent).map_err(|_| AppError::bad_request("无法解析数据目录"))?;
    normalize_local_path(&canonical)
}

pub fn model_summary_description(settings: &ModelSettings) -> String {
    if settings.low.model_id.is_some()
        && settings.medium.model_id.is_some()
        && settings.high.model_id.is_some()
    {
        "低 / 中 / 高档模型已配置".to_owned()
    } else {
        "默认模型待配置".to_owned()
    }
}

pub fn validate_model_settings(
    settings: &ModelSettings,
    models: &[PiModel],
) -> Result<(), AppError> {
    for (tier_name, tier) in [
        ("低", &settings.low),
        ("中", &settings.medium),
        ("高", &settings.high),
    ] {
        let model_id = tier
            .model_id
            .as_deref()
            .ok_or_else(|| AppError::bad_request(format!("{tier_name}档模型不能为空")))?;
        if !models.iter().any(|model| model.id == model_id) {
            return Err(AppError::bad_request(format!(
                "{tier_name}档模型不存在于 Pi Agent 已配置模型列表"
            )));
        }
    }
    Ok(())
}

pub fn clarification_has_answer(
    clarification: &RequirementClarification,
    answer: &ClarificationAnswer,
) -> bool {
    match clarification.question_type {
        ClarificationQuestionType::FreeText => answer
            .custom_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty()),
        ClarificationQuestionType::SingleChoice | ClarificationQuestionType::MultiChoice => {
            !answer.selected_options.is_empty()
                || answer
                    .custom_text
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty())
        }
    }
}

pub async fn write_json(path: &Path, data: &AppData) -> Result<(), AppError> {
    let mut content = serde_json::to_vec(data)?;
    content.push(b'\n');
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal(format!("无法获取 {} 的父目录", path.display())))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("app.json");
    let temp_name = format!(".{file_name}.{}.tmp", Utc::now().timestamp_millis());
    let temp_path = parent.join(temp_name);

    tokio::fs::write(&temp_path, content).await?;
    if let Err(error) = tokio::fs::rename(&temp_path, path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error.into());
    }
    Ok(())
}

pub fn build_clarification_answer_summary(clarifications: &[RequirementClarification]) -> String {
    let mut lines = vec!["已提交澄清答案：".to_owned()];
    for item in clarifications {
        if let Some(answer) = &item.answer {
            lines.push(format!(
                "- {}：{}",
                item.question,
                format_clarification_answer(item, answer)
            ));
        }
    }
    lines.join("\n")
}

pub fn format_clarification_answer(
    item: &RequirementClarification,
    answer: &ClarificationAnswer,
) -> String {
    let mut parts = Vec::new();
    for selected in &answer.selected_options {
        let label = item
            .options
            .iter()
            .find(|option| option.value == *selected)
            .map(|option| option.label.as_str())
            .unwrap_or(selected);
        parts.push(label.to_owned());
    }
    if let Some(custom_text) = answer.custom_text.as_deref()
        && !custom_text.trim().is_empty()
    {
        parts.push(custom_text.trim().to_owned());
    }
    if parts.is_empty() {
        "未填写".to_owned()
    } else {
        parts.join("；")
    }
}

pub async fn git(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let dir = normalize_local_path(dir)?;
    let output = tokio::process::Command::new("git")
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

pub async fn commit_staged_changes(worktree: &Path, message: &str) -> Result<(), AppError> {
    let status = git(worktree, &["status", "--porcelain"]).await?;
    if status.trim().is_empty() {
        return Ok(());
    }
    git(worktree, &["commit", "-m", message]).await?;
    Ok(())
}

pub fn effective_model_tier(
    kind: crate::models::RequirementTaskKind,
) -> crate::models::RequirementModelTier {
    use crate::models::{RequirementModelTier, RequirementTaskKind};
    match kind {
        RequirementTaskKind::Implementation | RequirementTaskKind::ReviewSummary => {
            RequirementModelTier::Low
        }
        RequirementTaskKind::Review
        | RequirementTaskKind::ReviewSubAgent
        | RequirementTaskKind::BranchMerge => RequirementModelTier::Medium,
        RequirementTaskKind::MergeReview => RequirementModelTier::High,
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_local_path, normalize_windows_path_value, resolve_git_root};
    use std::{path::PathBuf, process::Command};

    #[test]
    fn windows_extended_local_path_becomes_drive_path() {
        assert_eq!(
            normalize_windows_path_value(r"\\?\C:\repo").unwrap(),
            PathBuf::from(r"C:\repo")
        );
    }

    #[test]
    fn windows_drive_path_is_unchanged() {
        assert_eq!(
            normalize_windows_path_value(r"D:\repo").unwrap(),
            PathBuf::from(r"D:\repo")
        );
    }

    #[test]
    fn windows_unc_paths_are_rejected() {
        assert!(normalize_windows_path_value(r"\\server\share\repo").is_err());
        assert!(normalize_windows_path_value(r"\\?\UNC\server\share\repo").is_err());
    }

    #[test]
    fn git_root_is_discovered_but_explicit_subdirectory_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(temp.path())
                .status()
                .unwrap()
                .success()
        );
        let child = temp.path().join("nested");
        std::fs::create_dir(&child).unwrap();

        assert_eq!(
            resolve_git_root(None, &child).unwrap(),
            normalize_local_path(&std::fs::canonicalize(temp.path()).unwrap()).unwrap()
        );
        assert!(resolve_git_root(Some(&child), &child).is_err());
        assert_eq!(
            resolve_git_root(Some(temp.path()), &child).unwrap(),
            normalize_local_path(&std::fs::canonicalize(temp.path()).unwrap()).unwrap()
        );
    }

    #[test]
    fn non_git_directory_is_rejected_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        assert!(resolve_git_root(None, temp.path()).is_err());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
}
