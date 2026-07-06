use std::path::{Component, Path, PathBuf};

use axum::http::header;

use crate::{
    error::AppError,
    models::{AttachmentUploadRequest, FileReference, ImageAttachment, PromptImage},
    utils::{ensure_child_path, normalize_local_path},
};

const MAX_REF_BYTES: u64 = 64 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_FILE_RESULTS: usize = 100;

pub async fn list_repo_files(
    repo_path: &Path,
    search: &str,
) -> Result<Vec<FileReference>, AppError> {
    let repo_path = normalize_local_path(repo_path)?;
    ensure_child_path(&repo_path, &repo_path)?;
    let query = search.trim().to_ascii_lowercase();
    let mut stack = vec![repo_path.clone()];
    let mut files = Vec::new();

    while let Some(dir) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().await?.is_dir() {
                if matches!(
                    name.as_str(),
                    ".git" | ".raccoon-node" | "node_modules" | "target" | "dist"
                ) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if files.len() >= MAX_FILE_RESULTS {
                files.sort_by(|left: &FileReference, right| left.path.cmp(&right.path));
                return Ok(files);
            }
            let Ok(relative) = relative_repo_path(&repo_path, &path) else {
                continue;
            };
            if !query.is_empty() && !relative.to_ascii_lowercase().contains(&query) {
                continue;
            }
            if looks_binary(&path).await? {
                continue;
            }
            files.push(FileReference { path: relative });
        }
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub async fn read_repo_file(repo_path: &Path, relative_path: &str) -> Result<String, AppError> {
    let repo_path = normalize_local_path(repo_path)?;
    let first = Path::new(relative_path.trim())
        .components()
        .next()
        .and_then(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        });
    if matches!(first, Some(".git" | ".raccoon-node")) {
        return Err(AppError::bad_request(
            "不能引用 Git 或 raccoon-node 内部文件",
        ));
    }
    let path = resolve_relative_path(&repo_path, relative_path)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| AppError::bad_request(format!("引用文件不存在：{}", relative_path.trim())))?;
    if !metadata.is_file() {
        return Err(AppError::bad_request("引用路径必须是文件"));
    }
    if metadata.len() > MAX_REF_BYTES {
        return Err(AppError::bad_request("引用文件超过 64KB"));
    }
    let bytes = tokio::fs::read(path).await?;
    if bytes.iter().take(1024).any(|byte| *byte == 0) {
        return Err(AppError::bad_request("引用文件必须是 UTF-8 文本"));
    }
    String::from_utf8(bytes).map_err(|_| AppError::bad_request("引用文件必须是 UTF-8 文本"))
}

pub async fn build_reference_context(
    repo_path: &Path,
    references: &[FileReference],
    images: &[ImageAttachment],
) -> Result<Option<String>, AppError> {
    if references.is_empty() && images.is_empty() {
        return Ok(None);
    }

    let mut blocks = Vec::new();
    for reference in references {
        let content = read_repo_file(repo_path, &reference.path).await?;
        blocks.push(format!(
            r#"<file path="{}">
{}
</file>"#,
            escape_attr(&reference.path),
            content
        ));
    }
    for image in images {
        blocks.push(format!(
            r#"<image name="{}" path="{}" />"#,
            escape_attr(&image.name),
            escape_attr(&image.path),
        ));
    }

    Ok(Some(format!(
        "以下是用户引用的上下文：\n{}",
        blocks.join("\n\n")
    )))
}

pub async fn build_prompt_images(
    project_dir: &Path,
    images: &[ImageAttachment],
) -> Result<Vec<PromptImage>, AppError> {
    let mut prompt_images = Vec::with_capacity(images.len());
    for image in images {
        let (bytes, mime_type) = read_attachment(project_dir, &image.path).await?;
        prompt_images.push(PromptImage {
            data_base64: base64_encode(&bytes),
            mime_type: mime_type.to_owned(),
        });
    }
    Ok(prompt_images)
}

pub async fn save_attachment(
    project_dir: &Path,
    payload: AttachmentUploadRequest,
) -> Result<ImageAttachment, AppError> {
    let mime_type = normalize_image_mime(&payload.mime_type)?;
    let bytes = base64_decode(strip_data_url(&payload.data_base64))?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::bad_request("图片大小必须在 1B 到 5MB 之间"));
    }

    let dir = project_dir.join("attachments");
    ensure_child_path(project_dir, &dir)?;
    tokio::fs::create_dir_all(&dir).await?;

    let safe_name = safe_file_name(&payload.name);
    let extension = image_extension(mime_type);
    let stem = safe_name
        .trim_end_matches(extension)
        .trim_end_matches('.')
        .to_owned();
    let file_name = format!(
        "{}-{}.{}",
        chrono::Utc::now().timestamp_millis(),
        stem,
        extension
    );
    let path = dir.join(&file_name);
    ensure_child_path(project_dir, &path)?;
    tokio::fs::write(&path, bytes).await?;

    Ok(ImageAttachment {
        name: safe_name,
        path: format!("attachments/{file_name}"),
    })
}

pub async fn read_attachment(
    project_dir: &Path,
    relative_path: &str,
) -> Result<(Vec<u8>, &'static str), AppError> {
    if !relative_path.starts_with("attachments/") {
        return Err(AppError::bad_request("附件路径非法"));
    }
    let path = resolve_relative_path(project_dir, relative_path)?;
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() || metadata.len() as usize > MAX_ATTACHMENT_BYTES {
        return Err(AppError::bad_request("附件不存在或过大"));
    }
    let mime_type = mime_from_path(&path)?;
    Ok((tokio::fs::read(path).await?, mime_type))
}

pub fn content_type_value(mime_type: &str) -> header::HeaderValue {
    header::HeaderValue::from_str(mime_type)
        .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream"))
}

fn resolve_relative_path(root: &Path, relative_path: &str) -> Result<PathBuf, AppError> {
    let relative = Path::new(relative_path.trim());
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::bad_request("路径必须是安全的相对路径"));
    }
    let path = root.join(relative);
    ensure_child_path(root, &path)?;
    Ok(path)
}

fn relative_repo_path(root: &Path, path: &Path) -> Result<String, AppError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::bad_request("路径必须位于仓库内"))?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

async fn looks_binary(path: &Path) -> Result<bool, AppError> {
    let bytes = tokio::fs::read(path).await?;
    Ok(bytes.iter().take(1024).any(|byte| *byte == 0))
}

fn strip_data_url(value: &str) -> &str {
    value
        .split_once(',')
        .filter(|(head, _)| head.starts_with("data:"))
        .map_or(value, |(_, data)| data)
        .trim()
}

fn normalize_image_mime(value: &str) -> Result<&'static str, AppError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => Ok("image/png"),
        "image/jpeg" | "image/jpg" => Ok("image/jpeg"),
        "image/gif" => Ok("image/gif"),
        "image/webp" => Ok("image/webp"),
        _ => Err(AppError::bad_request("仅支持 png、jpeg、gif、webp 图片")),
    }
}

fn image_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn mime_from_path(path: &Path) -> Result<&'static str, AppError> {
    match path.extension().and_then(|value| value.to_str()) {
        Some("png") => Ok("image/png"),
        Some("jpg" | "jpeg") => Ok("image/jpeg"),
        Some("gif") => Ok("image/gif"),
        Some("webp") => Ok("image/webp"),
        _ => Err(AppError::bad_request("附件类型非法")),
    }
}

fn safe_file_name(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image");
    let safe = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .to_owned();
    if safe.is_empty() {
        "image".to_owned()
    } else {
        safe
    }
}

fn base64_decode(value: &str) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut chunk = [0u8; 4];
    let mut len = 0usize;
    for byte in value.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => return Err(AppError::bad_request("图片 base64 非法")),
        };
        chunk[len] = value;
        len += 1;
        if len == 4 {
            output.push((chunk[0] << 2) | (chunk[1] >> 4));
            if chunk[2] != 64 {
                output.push((chunk[1] << 4) | (chunk[2] >> 2));
            }
            if chunk[3] != 64 {
                output.push((chunk[2] << 6) | chunk[3]);
            }
            len = 0;
            if output.len() > MAX_ATTACHMENT_BYTES {
                return Err(AppError::bad_request("图片超过 5MB"));
            }
        }
    }
    if len != 0 {
        return Err(AppError::bad_request("图片 base64 长度非法"));
    }
    Ok(output)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b11) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((b1 & 0b1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(b2 & 0b111111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn escape_attr(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_repo_file_and_rejects_escape() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        tokio::fs::create_dir(&repo).await.unwrap();
        tokio::fs::write(repo.join("main.rs"), "fn main() {}")
            .await
            .unwrap();

        assert_eq!(
            read_repo_file(&repo, "main.rs").await.unwrap(),
            "fn main() {}"
        );
        assert!(read_repo_file(&repo, "../secret").await.is_err());
        assert!(read_repo_file(&repo, ".").await.is_err());
        tokio::fs::write(repo.join("binary.bin"), b"text\0binary")
            .await
            .unwrap();
        assert!(read_repo_file(&repo, "binary.bin").await.is_err());
        tokio::fs::write(
            repo.join("large.txt"),
            vec![b'x'; MAX_REF_BYTES as usize + 1],
        )
        .await
        .unwrap();
        assert!(read_repo_file(&repo, "large.txt").await.is_err());
    }

    #[tokio::test]
    async fn internal_project_data_is_neither_listed_nor_readable() {
        let temp = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(temp.path().join(".raccoon-node"))
            .await
            .unwrap();
        tokio::fs::write(temp.path().join(".raccoon-node/data.db"), b"secret")
            .await
            .unwrap();
        tokio::fs::write(temp.path().join("visible.txt"), b"visible")
            .await
            .unwrap();

        let files = list_repo_files(temp.path(), "").await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "visible.txt");
        assert!(
            read_repo_file(temp.path(), ".raccoon-node/data.db")
                .await
                .is_err()
        );
    }

    #[test]
    fn base64_roundtrip() {
        let bytes = b"hello image";
        assert_eq!(base64_decode(&base64_encode(bytes)).unwrap(), bytes);
    }
}
