use crate::models::{ProjectChatInput, ProjectChatMessageRole};
use crate::prompt::{PromptRenderer, PromptSourceDelivery, PromptSourceKind, RenderedPrompt};

pub fn build_project_chat_prompt(input: &ProjectChatInput, session_reused: bool) -> RenderedPrompt {
    let latest_question = input
        .messages
        .iter()
        .rev()
        .find(|message| message.role == ProjectChatMessageRole::User)
        .map(|message| message.content.trim())
        .unwrap_or("");
    let history = if session_reused {
        String::new()
    } else {
        input
            .messages
            .iter()
            .map(|message| {
                let role = match message.role {
                    ProjectChatMessageRole::User => "用户",
                    ProjectChatMessageRole::Assistant => "助手",
                    ProjectChatMessageRole::System => "系统",
                };
                format!("{role}: {}", message.content.trim())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let body = format!(
        r#"你是 raccoon_node 的项目问答助手。

项目：{project_name}
仓库：{repo_path}

规则：
- 只能读取、搜索、解释当前仓库代码。
- 禁止修改文件、创建提交、切换分支、创建需求、规划工作项、创建 WorkflowRun 或触发执行。
- 如果需要确认现状，请优先用只读命令，例如 ls、rg、git status --short、git log。
- 用简体中文回答，直接给结论和必要依据。

{history_block}

当前问题：
{latest_question}

"#,
        project_name = input.project.name,
        repo_path = input.project.local_path,
        history_block = if history.is_empty() {
            "已恢复历史 Pi session，请基于当前会话继续。".to_owned()
        } else {
            format!("历史消息：\n{history}")
        },
        latest_question = latest_question,
    );
    let mut renderer = PromptRenderer::new("project_chat");
    if session_reused {
        renderer = renderer.add_source(
            PromptSourceKind::TaskContext,
            "latest_question",
            format!("继续当前项目问答会话。\n\n当前问题：\n{latest_question}"),
        );
    } else {
        renderer = renderer.add_source(PromptSourceKind::TaskContext, "project_chat", body);
    }
    if let Some(reference_context) = &input.reference_context {
        for part in &reference_context.parts {
            renderer = renderer.add_reference_source(
                &part.path,
                &part.markdown,
                if part.inline {
                    PromptSourceDelivery::Inline
                } else {
                    PromptSourceDelivery::PathOnly
                },
                part.bytes,
            );
        }
    }
    renderer.render()
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::models::{ModelSettings, Project, ProjectChatMessage};

    #[test]
    fn project_chat_prompt_is_read_only() {
        let input = ProjectChatInput {
            project: Project {
                name: "Demo".to_owned(),
                git_url: "https://example.com/demo.git".to_owned(),
                local_path: "/tmp/demo".to_owned(),
            },
            messages: vec![ProjectChatMessage {
                role: ProjectChatMessageRole::User,
                content: "入口在哪里？".to_owned(),
                references: Vec::new(),
                images: Vec::new(),
                metadata: None,
                created_at: Utc::now(),
            }],
            reference_context: None,
            prompt_images: Vec::new(),
            model_settings: ModelSettings::default(),
            pi_session_file: None,
        };

        let prompt = build_project_chat_prompt(&input, false).markdown;
        assert!(prompt.contains("禁止修改文件"));
        assert!(prompt.contains("禁止"));
        assert!(prompt.contains("创建 WorkflowRun"));
        assert!(prompt.contains("入口在哪里？"));
    }
}
