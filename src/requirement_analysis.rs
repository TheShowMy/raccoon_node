use serde_json::{json, Value};

use crate::models::{
    ClarificationOption, ClarificationQuestionType, RawClarificationOption,
    RawRequirementAnalysisJson, RawRequirementClarification, RequirementAnalysisInput,
    RequirementAnalysisOutput, RequirementAnalysisStatus, RequirementClarification,
    RequirementMessageRole, RequirementStatus,
};
use crate::utils::format_clarification_answer;

const REQUIREMENT_PROMPT_TEMPLATE: &str = include_str!("../prompts/requirement_coordinator.txt");

pub fn build_requirement_prompt(input: &RequirementAnalysisInput) -> String {
    let mut history = String::new();
    for message in &input.messages {
        let role = match message.role {
            RequirementMessageRole::User => "用户",
            RequirementMessageRole::Assistant => "Coordinator",
            RequirementMessageRole::System => "系统",
            RequirementMessageRole::Trace => "过程记录",
        };
        if message.role == RequirementMessageRole::Trace {
            continue;
        }
        let content = message.content.replace("###", "\\#\\#\\#");
        history.push_str(&format!(
            "{role}: ### BEGIN USER INPUT ###\n{content}\n### END USER INPUT ###\n"
        ));
    }

    let clarifications = if input.clarifications.is_empty() {
        "当前没有待澄清项。\n".to_owned()
    } else {
        let mut lines = String::new();
        for item in &input.clarifications {
            lines.push_str(&format!("- {}：{}\n", item.id, item.question));
            if let Some(answer) = &item.answer {
                lines.push_str(&format!(
                    "  用户回答：{}\n",
                    format_clarification_answer(item, answer)
                ));
            }
        }
        lines
    };

    let existing_draft = input
        .draft
        .as_ref()
        .map(|draft| {
            format!(
                "当前确认草案：{}\n{}\n验收标准：{}\n",
                draft.title,
                draft.summary,
                draft.acceptance_criteria.join("；")
            )
        })
        .unwrap_or_else(|| "当前还没有确认草案。\n".to_owned());

    REQUIREMENT_PROMPT_TEMPLATE
        .replace("{{PROJECT_NAME}}", &input.project.name)
        .replace("{{GIT_URL}}", &input.project.git_url)
        .replace("{{LOCAL_PATH}}", &input.project.local_path)
        .replace("{{EXISTING_DRAFT}}", &existing_draft)
        .replace("{{CLARIFICATIONS}}", &clarifications)
        .replace("{{HISTORY}}", &history)
}

pub fn parse_requirement_analysis(
    assistant_text: &str,
    pi_session_file: Option<String>,
    trace: Option<Value>,
) -> RequirementAnalysisOutput {
    let Some(json_text) = extract_json_object(assistant_text) else {
        let message = if looks_like_html(assistant_text) {
            "Pi Agent 返回了 HTML 内容，未能提取结构化澄清结果。".to_owned()
        } else {
            assistant_text.to_owned()
        };
        return RequirementAnalysisOutput {
            status: RequirementStatus::Failed,
            assistant_message: message,
            progress: String::new(),
            clarifications: Vec::new(),
            draft: None,
            pi_session_file,
            error: Some("Pi Agent 未返回结构化 JSON".to_owned()),
            trace,
        };
    };

    match serde_json::from_str::<RawRequirementAnalysisJson>(&json_text) {
        Ok(parsed) => match parsed.status {
            RequirementAnalysisStatus::NeedsClarification => {
                let progress = if parsed.progress.trim().is_empty() {
                    parsed.message.clone()
                } else {
                    parsed.progress
                };
                let clarifications = normalize_requirement_clarifications(parsed.clarifications);
                RequirementAnalysisOutput {
                    status: RequirementStatus::Clarifying,
                    assistant_message: parsed.message,
                    progress,
                    clarifications,
                    draft: None,
                    pi_session_file,
                    error: None,
                    trace,
                }
            }
            RequirementAnalysisStatus::Ready => {
                let Some(draft) = parsed.draft else {
                    return RequirementAnalysisOutput {
                        status: RequirementStatus::Failed,
                        assistant_message: parsed.message,
                        progress: parsed.progress,
                        clarifications: Vec::new(),
                        draft: None,
                        pi_session_file,
                        error: Some("ready 状态缺少确认需求草案".to_owned()),
                        trace,
                    };
                };
                RequirementAnalysisOutput {
                    status: RequirementStatus::DraftReady,
                    assistant_message: parsed.message,
                    progress: parsed.progress,
                    clarifications: Vec::new(),
                    draft: Some(draft),
                    pi_session_file,
                    error: None,
                    trace,
                }
            }
        },
        Err(error) => RequirementAnalysisOutput {
            status: RequirementStatus::Failed,
            assistant_message: if looks_like_html(assistant_text) {
                "Pi Agent 返回了 HTML 内容，解析结构化澄清结果失败。".to_owned()
            } else {
                assistant_text.to_owned()
            },
            progress: String::new(),
            clarifications: Vec::new(),
            draft: None,
            pi_session_file,
            error: Some(format!("解析 Pi Agent JSON 失败：{error}")),
            trace,
        },
    }
}

pub fn extract_json_object(value: &str) -> Option<String> {
    let trimmed = value.trim();

    if let Some(json) = extract_markdown_json(trimmed) {
        return Some(json);
    }

    let (start, end) = find_balanced_braces(trimmed)?;
    Some(sanitize_json_fragment(trimmed[start..=end].trim()))
}

fn extract_markdown_json(text: &str) -> Option<String> {
    for marker in ["```json\n", "```json ", "```\n", "``` "] {
        if let Some(start) = text.find(marker) {
            let after_marker = &text[start + marker.len()..];
            if let Some(end) = after_marker.find("```") {
                let content = after_marker[..end].trim();
                if content.starts_with('{') {
                    return Some(content.to_owned());
                }
            }
        }
    }
    None
}

pub fn find_balanced_braces(text: &str) -> Option<(usize, usize)> {
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape_next = false;

    for (index, ch) in text.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }

        match ch {
            '\\' if in_string => escape_next = true,
            '"' => in_string = !in_string,
            '{' if !in_string => {
                if start.is_none() {
                    start = Some(index);
                }
                depth += 1;
            }
            '}' if !in_string => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        return start.map(|start| (start, index));
                    }
                }
            }
            _ => {}
        }
    }
    None
}

pub fn sanitize_json_fragment(text: &str) -> String {
    text.replace(",\n}", "\n}")
        .replace(",\n]", "\n]")
        .replace(",}", "}")
        .replace(",]", "]")
}

fn looks_like_html(text: &str) -> bool {
    let trimmed = text.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!doctype") || trimmed.starts_with("<html")
}

pub fn normalize_requirement_clarifications(
    items: Vec<RawRequirementClarification>,
) -> Vec<RequirementClarification> {
    items
        .into_iter()
        .take(6)
        .enumerate()
        .filter_map(|(index, item)| {
            let question = item.question.trim().to_owned();
            if question.is_empty() {
                return None;
            }

            let question_type = item
                .question_type
                .unwrap_or(ClarificationQuestionType::FreeText);
            let options = if question_type == ClarificationQuestionType::FreeText {
                Vec::new()
            } else {
                normalize_clarification_options(item.options)
            };

            Some(RequirementClarification {
                id: item.id.unwrap_or_else(|| format!("q{}", index + 1)),
                question,
                question_type,
                options,
                answer: None,
            })
        })
        .collect()
}

fn normalize_clarification_options(items: Vec<RawClarificationOption>) -> Vec<ClarificationOption> {
    let mut options = items
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let label = item.label.trim().to_owned();
            if label.is_empty() {
                return None;
            }
            let value = item
                .value
                .unwrap_or_else(|| format!("option-{}", index + 1));
            Some(ClarificationOption {
                value,
                label,
                description: item.description.trim().to_owned(),
                recommended: item.recommended,
            })
        })
        .collect::<Vec<_>>();

    if options.len() > 4 {
        options.sort_by(|left, right| right.recommended.cmp(&left.recommended));
        options.truncate(4);
    }
    options
}

pub fn build_pi_trace_metadata(events: &[Value]) -> Option<Value> {
    if events.is_empty() {
        return None;
    }

    let mut thinking = String::new();
    // output remains empty: text_delta is parsed into the assistant message,
    // so the raw structured JSON is not duplicated in the trace.
    let output = String::new();
    let mut statuses = Vec::new();
    let mut tools = Vec::new();

    for event in events {
        let pi_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match pi_type {
            "message_update" => collect_message_update(event, &mut thinking),
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                upsert_trace_tool(&mut tools, event, pi_type)
            }
            "agent_start" | "agent_end" | "turn_start" | "turn_end" | "auto_retry_start"
            | "auto_retry_end" | "compaction_start" | "compaction_end" | "extension_error" => {
                statuses.push(json!({
                    "type": pi_type,
                    "message": summarize_pi_event(pi_type, event),
                }));
            }
            _ => {}
        }
    }

    Some(json!({
        "type": "pi_trace",
        "version": 1,
        "trace": {
            "thinking": thinking,
            "output": output,
            "tools": tools,
            "statuses": statuses,
            "completed": true,
            "live": false,
        }
    }))
}

fn collect_message_update(event: &Value, thinking: &mut String) {
    let assistant_event = match event.get("assistantMessageEvent") {
        Some(Value::Object(_)) => &event["assistantMessageEvent"],
        _ => return,
    };
    let delta_type = assistant_event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let delta = assistant_event
        .get("delta")
        .or_else(|| assistant_event.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if delta_type == "thinking_delta" {
        thinking.push_str(delta);
    }
    // text_delta contains the structured JSON response; it is parsed into the
    // assistant message and should not be duplicated in the trace output.
}

fn upsert_trace_tool(tools: &mut Vec<Value>, event: &Value, pi_type: &str) {
    let tool_call_id = event
        .get("toolCallId")
        .or_else(|| event.get("tool_call_id"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let existing_index = tools.iter().position(|tool| {
        tool.get("toolCallId")
            .and_then(Value::as_str)
            .is_some_and(|id| id == tool_call_id)
    });
    let tool_name = event
        .get("toolName")
        .or_else(|| event.get("tool_name"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let status = match pi_type {
        "tool_execution_start" | "tool_execution_update" => "running",
        "tool_execution_end" => "done",
        _ => "unknown",
    };
    let is_error = event
        .get("isError")
        .or_else(|| event.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut tool = existing_index
        .and_then(|index| tools.get(index).cloned())
        .unwrap_or_else(|| {
            json!({
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "status": status,
                "output": "",
                "isError": false,
            })
        });

    tool["toolName"] = json!(tool_name);
    tool["status"] = json!(if is_error { "error" } else { status });
    tool["isError"] = json!(is_error);
    if let Some(output) = extract_tool_text(event) {
        tool["output"] = json!(output);
    }

    if let Some(index) = existing_index {
        tools[index] = tool;
    } else {
        tools.push(tool);
    }
}

fn extract_tool_text(event: &Value) -> Option<String> {
    let result = event
        .get("partialResult")
        .or_else(|| event.get("partial_result"))
        .or_else(|| event.get("result"))?;
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
}

pub fn summarize_pi_event(pi_type: &str, payload: &Value) -> String {
    match pi_type {
        "agent_start" => "Pi Agent 开始处理。".to_owned(),
        "agent_end" => "Pi Agent 处理完成。".to_owned(),
        "turn_start" => "开始新一轮推理。".to_owned(),
        "turn_end" => "本轮推理完成。".to_owned(),
        "message_start" => "开始生成消息。".to_owned(),
        "message_update" => "正在生成内容。".to_owned(),
        "message_end" => "消息生成完成。".to_owned(),
        "tool_execution_start" => format!(
            "开始调用工具：{}",
            payload
                .get("toolName")
                .or_else(|| payload.get("tool_name"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
        ),
        "tool_execution_update" => "工具执行中。".to_owned(),
        "tool_execution_end" => "工具执行完成。".to_owned(),
        "extension_error" => "扩展执行出错。".to_owned(),
        _ => format!("Pi Agent 事件：{pi_type}"),
    }
}
