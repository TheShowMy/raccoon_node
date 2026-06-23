use serde_json::{json, Value};

use crate::models::{
    ClarificationOption, ClarificationQuestionType, RawClarificationOption,
    RawRequirementAnalysisJson, RawRequirementClarification, RequirementAnalysisInput,
    RequirementAnalysisOutput, RequirementAnalysisStatus, RequirementClarification,
    RequirementMessageRole, RequirementStatus,
};

const REQUIREMENT_PROMPT_TEMPLATE: &str = include_str!("../prompts/requirement_coordinator.txt");

pub fn build_requirement_prompt(input: &RequirementAnalysisInput) -> String {
    let current_request = input
        .messages
        .iter()
        .rev()
        .find(|message| message.role == RequirementMessageRole::User)
        .map(|message| message.content.replace("###", "\\#\\#\\#"))
        .unwrap_or_default();

    REQUIREMENT_PROMPT_TEMPLATE
        .replace("{{PROJECT_NAME}}", &input.project.name)
        .replace("{{GIT_URL}}", &input.project.git_url)
        .replace("{{LOCAL_PATH}}", &input.project.local_path)
        .replace("{{CURRENT_REQUEST}}", &current_request)
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

    let value = match serde_json::from_str::<Value>(&json_text) {
        Ok(value) => value,
        Err(error) => {
            return RequirementAnalysisOutput {
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
            }
        }
    };

    match serde_json::from_value::<RawRequirementAnalysisJson>(value) {
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

pub fn assistant_text_from_pi_events(events: &[Value]) -> Option<String> {
    let text = events
        .iter()
        .filter_map(message_update_text_delta)
        .collect::<String>();
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_owned())
    }
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

fn message_update_text_delta(event: &Value) -> Option<&str> {
    let assistant_event = event.get("assistantMessageEvent")?;
    let delta_type = assistant_event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if delta_type == "thinking_delta" {
        return None;
    }
    if !delta_type.is_empty()
        && delta_type != "text_delta"
        && delta_type != "content_delta"
        && delta_type != "message_delta"
    {
        return None;
    }
    assistant_event
        .get("delta")
        .or_else(|| assistant_event.get("text"))
        .and_then(Value::as_str)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tolerates_duplicate_keys_in_clarification_options() {
        let text = r#"{"status":"needs_clarification","message":"请确认","clarifications":[{"id":"q1","question":"范围？","question_type":"single_choice","options":[{"value":"small","label":"小","label":"重复","description":"d"}]}],"draft":null}"#;
        let output = parse_requirement_analysis(text, None, None);
        assert_eq!(output.status, RequirementStatus::Clarifying);
        assert_eq!(output.clarifications.len(), 1);
        assert_eq!(output.clarifications[0].options.len(), 1);
        assert!(!output.clarifications[0].options[0].label.is_empty());
    }

    #[test]
    fn assistant_text_falls_back_to_text_delta_events() {
        let events = vec![
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "thinking_delta",
                    "delta": "思考"
                }
            }),
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "delta": "{\"status\":\"ready\","
                }
            }),
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "delta": "\"message\":\"ok\",\"clarifications\":[],\"draft\":null}"
                }
            }),
        ];

        assert_eq!(
            assistant_text_from_pi_events(&events).as_deref(),
            Some("{\"status\":\"ready\",\"message\":\"ok\",\"clarifications\":[],\"draft\":null}")
        );
    }
}
