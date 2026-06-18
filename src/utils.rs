use std::{
    env,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
};

use chrono::Utc;

use crate::error::AppError;
use crate::models::{
    AppData, ClarificationAnswer, ClarificationQuestionType, ModelSettings, ModelTierSetting,
    PiModel, Requirement, RequirementClarification,
};

pub fn ensure_child_path(root: &Path, child: &Path) -> Result<(), AppError> {
    let root_canonical = strip_unc_prefix(
        std::fs::canonicalize(root).map_err(|_| AppError::bad_request("无法解析根目录"))?,
    );

    let resolved = if child.is_absolute() {
        child.to_path_buf()
    } else {
        root_canonical.join(child)
    };

    // For existing paths, canonicalize gives the most robust check.
    if let Ok(child_canonical) = std::fs::canonicalize(&resolved) {
        if !strip_unc_prefix(child_canonical).starts_with(&root_canonical) {
            return Err(AppError::bad_request("路径必须位于数据目录内"));
        }
        return Ok(());
    }

    // For not-yet-existing paths, normalize `.` and `..` components manually
    // and verify the result still lives under the root.
    let normalized = strip_unc_prefix(normalize_path(&resolved));
    if !normalized.starts_with(&root_canonical) {
        return Err(AppError::bad_request("路径必须位于数据目录内"));
    }
    Ok(())
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

#[cfg(windows)]
pub fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

#[cfg(not(windows))]
pub fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    path
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn slugify(value: &str) -> String {
    let mut slug = String::new();

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch.is_whitespace() || matches!(ch, '-' | '_')) && !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        "project".to_owned()
    } else {
        slug
    }
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
    Ok(path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf())
}

pub fn public_dir_path() -> PathBuf {
    if let Ok(path) = env::var("RACCOON_PUBLIC_DIR") {
        return PathBuf::from(path);
    }

    if let Some(build_root) = build_root_from_current_exe() {
        return build_root.join("public");
    }

    PathBuf::from("frontend/dist")
}

pub fn server_addr() -> SocketAddr {
    let host = env::var("RACCOON_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = env::var("RACCOON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3001);

    format!("{host}:{port}")
        .parse()
        .expect("invalid RACCOON_HOST or RACCOON_PORT")
}

pub fn data_file_path() -> PathBuf {
    if let Ok(path) = env::var("RACCOON_DATA_FILE") {
        return PathBuf::from(path);
    }

    if let Some(build_root) = build_root_from_current_exe() {
        return build_root.join("data/app.json");
    }

    PathBuf::from("data/app.json")
}

pub fn build_root_from_current_exe() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let bin_dir = exe.parent()?;
    if bin_dir.file_name()?.to_string_lossy() != "bin" {
        return None;
    }
    let build_root = bin_dir.parent()?.to_path_buf();
    if build_root.join("public").exists() || build_root.join("data").exists() {
        Some(build_root)
    } else {
        None
    }
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

pub fn validate_git_url(url: &str) -> Result<(), AppError> {
    if url.is_empty() {
        return Err(AppError::bad_request("Git 链接不能为空"));
    }
    if url.starts_with('-') {
        return Err(AppError::bad_request("Git 链接不能以 '-' 开头"));
    }
    // Reject shell metacharacters
    if url.contains(';') || url.contains('|') || url.contains('&') || url.contains('`') {
        return Err(AppError::bad_request("Git 链接包含非法字符"));
    }
    // Only allow http://, https://, and git@
    let is_valid = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("git@")
        || cfg!(test);
    if !is_valid {
        return Err(AppError::bad_request("Git 链接协议不支持"));
    }
    Ok(())
}

pub fn validate_model_settings(
    settings: &ModelSettings,
    models: &[PiModel],
) -> Result<(), AppError> {
    validate_tier_model("低", &settings.low, models)?;
    validate_tier_model("中", &settings.medium, models)?;
    validate_tier_model("高", &settings.high, models)?;
    Ok(())
}

pub fn validate_tier_model(
    tier_name: &str,
    tier: &ModelTierSetting,
    models: &[PiModel],
) -> Result<(), AppError> {
    let Some(model_id) = tier.model_id.as_deref() else {
        return Err(AppError::bad_request(format!("{tier_name}档模型不能为空")));
    };

    if models.iter().any(|model| model.id == model_id) {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "{tier_name}档模型不存在于 Pi Agent 已配置模型列表"
        )))
    }
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

pub async fn remove_dir_if_exists(path: &Path) -> Result<(), AppError> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Io(error)),
    }
}

pub async fn clone_git_repo(git_url: &str, repo_dir: &Path) -> Result<(), AppError> {
    let output = tokio::process::Command::new("git")
        .arg("clone")
        .arg(git_url)
        .arg(repo_dir)
        .output()
        .await?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let message = if stderr.is_empty() {
        "Git clone 失败".to_owned()
    } else {
        format!("Git clone 失败：{stderr}")
    };
    Err(AppError::bad_request(message))
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
    if let Some(custom_text) = answer.custom_text.as_deref() {
        if !custom_text.trim().is_empty() {
            parts.push(custom_text.trim().to_owned());
        }
    }
    if parts.is_empty() {
        "未填写".to_owned()
    } else {
        parts.join("；")
    }
}
