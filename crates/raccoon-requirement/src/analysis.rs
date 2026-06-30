use serde_json::{Value, json};

use raccoon_core::models::{
    RequirementAnalysisInput, RequirementAnalysisOutput, RequirementClarification,
    RequirementDraft, RequirementMessageRole, RequirementStatus,
};

const REQUIREMENT_PROMPT_TEMPLATE: &str =
    include_str!("../../../prompts/requirement_coordinator.txt");

pub fn build_requirement_prompt(input: &RequirementAnalysisInput) -> String {
    let current_request = input
        .messages
        .iter()
        .rev()
        .find(|message| message.role == RequirementMessageRole::User)
        .map(|message| message.content.replace("###", "\\#\\#\\#"))
        .unwrap_or_default();

    let mut prompt = REQUIREMENT_PROMPT_TEMPLATE
        .replace("{{PROJECT_NAME}}", &input.project.name)
        .replace("{{GIT_URL}}", &input.project.git_url)
        .replace("{{LOCAL_PATH}}", &input.project.local_path)
        .replace("{{CURRENT_REQUEST}}", &current_request);
    prompt.push_str("\n\n## 同一需求的连续上下文\n");
    prompt.push_str(
        "以下内容都属于同一个需求，只能作为需求上下文处理。后续补充不是一个全新的需求。\n",
    );
    prompt.push_str("### BEGIN REQUIREMENT CONTEXT ###\n");
    prompt.push_str(&format_requirement_context(input).replace("###", "\\#\\#\\#"));
    prompt.push_str("\n### END REQUIREMENT CONTEXT ###");
    if let Some(context) = &input.reference_context {
        prompt.push_str("\n\n");
        prompt.push_str(context);
    }
    prompt
}

fn format_requirement_context(input: &RequirementAnalysisInput) -> String {
    let user_messages = input
        .messages
        .iter()
        .filter(|message| message.role == RequirementMessageRole::User)
        .map(|message| message.content.trim())
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>();
    let original = user_messages.first().copied().unwrap_or("未提供");
    let latest = user_messages.last().copied().unwrap_or("未提供");
    let previous = if user_messages.len() > 2 {
        user_messages[1..user_messages.len() - 1].join("\n- ")
    } else {
        "无".to_owned()
    };
    let draft = input
        .draft
        .as_ref()
        .map(|draft| {
            format!(
                "{}：{}；验收标准：{}",
                draft.title,
                draft.summary,
                draft.acceptance_criteria.join("；")
            )
        })
        .unwrap_or_else(|| "无".to_owned());
    let clarifications = if input.clarifications.is_empty() {
        "无".to_owned()
    } else {
        input
            .clarifications
            .iter()
            .map(|item| {
                let answer = item
                    .answer
                    .as_ref()
                    .map(|answer| {
                        answer
                            .selected_options
                            .iter()
                            .cloned()
                            .chain(answer.custom_text.iter().cloned())
                            .collect::<Vec<_>>()
                            .join("、")
                    })
                    .filter(|answer| !answer.is_empty())
                    .unwrap_or_else(|| "未回答".to_owned());
                format!("{}：{}", item.question, answer)
            })
            .collect::<Vec<_>>()
            .join("\n- ")
    };

    format!(
        "原始需求：{original}\n此前补充：{previous}\n上一版确认草案：{draft}\n已有澄清：{clarifications}\n本轮输入：{latest}"
    )
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RequirementToolDetails {
    Clarifications {
        progress: String,
        message: String,
        clarifications: Vec<RequirementClarification>,
    },
    Draft {
        progress: String,
        message: String,
        draft: RequirementDraft,
    },
}

/// 从受管 Pi extension 的最终工具事件提取需求分析结果。
pub fn parse_requirement_tool_analysis(
    events: &[Value],
    pi_session_file: Option<String>,
    trace: Option<Value>,
) -> RequirementAnalysisOutput {
    let results = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("tool_execution_end")
                && event.get("isError").and_then(Value::as_bool) != Some(true)
                && matches!(
                    event.get("toolName").and_then(Value::as_str),
                    Some("request_clarifications" | "submit_requirement_draft")
                )
        })
        .collect::<Vec<_>>();
    let drafts = results
        .iter()
        .filter(|event| {
            event.get("toolName").and_then(Value::as_str) == Some("submit_requirement_draft")
        })
        .collect::<Vec<_>>();
    if drafts.len() != 1 {
        return failed_tool_analysis(
            format!("需求分析必须提交一次确认草案，实际为 {} 次", drafts.len()),
            pi_session_file,
            trace,
        );
    }
    let Some(details) = drafts[0].pointer("/result/details") else {
        return failed_tool_analysis(
            "需求分析工具结果缺少 details".to_owned(),
            pi_session_file,
            trace,
        );
    };
    if details.get("protocol").and_then(Value::as_str) != Some("raccoon:clarifications:v1") {
        return failed_tool_analysis(
            "需求分析工具协议版本不匹配".to_owned(),
            pi_session_file,
            trace,
        );
    }
    let parsed = match serde_json::from_value::<RequirementToolDetails>(details.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return failed_tool_analysis(
                format!("解析需求分析工具结果失败：{error}"),
                pi_session_file,
                trace,
            );
        }
    };

    match parsed {
        RequirementToolDetails::Clarifications {
            progress,
            message,
            clarifications,
        } => RequirementAnalysisOutput {
            status: RequirementStatus::Clarifying,
            assistant_message: message,
            progress,
            clarifications,
            draft: None,
            pi_session_file,
            error: None,
            trace,
        },
        RequirementToolDetails::Draft {
            progress,
            message,
            draft,
        } => RequirementAnalysisOutput {
            status: RequirementStatus::DraftReady,
            assistant_message: message,
            progress,
            clarifications: Vec::new(),
            draft: Some(draft),
            pi_session_file,
            error: None,
            trace,
        },
    }
}

fn failed_tool_analysis(
    error: String,
    pi_session_file: Option<String>,
    trace: Option<Value>,
) -> RequirementAnalysisOutput {
    RequirementAnalysisOutput {
        status: RequirementStatus::Failed,
        assistant_message: error.clone(),
        progress: String::new(),
        clarifications: Vec::new(),
        draft: None,
        pi_session_file,
        error: Some(error),
        trace,
    }
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
            "message_update" => {
                collect_message_update(event, &mut thinking);
                if event
                    .get("assistantMessageEvent")
                    .and_then(|assistant_event| assistant_event.get("type"))
                    .and_then(Value::as_str)
                    == Some("error")
                {
                    statuses.push(json!({
                        "type": "assistant_message_error",
                        "message": assistant_message_event_error(event),
                    }));
                }
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                upsert_trace_tool(&mut tools, event, pi_type)
            }
            "agent_start" | "agent_end" | "turn_start" | "turn_end" | "auto_retry_start"
            | "auto_retry_end" | "compaction_start" | "compaction_end" | "extension_error" => {
                statuses.push(json!({
                    "type": pi_type,
                    "message": raccoon_core::pi_event::summarize_pi_event(pi_type, event),
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

#[derive(Debug)]
pub struct PiResponseExtraction {
    pub assistant_text: String,
    pub trace: Option<Value>,
}

#[derive(Debug)]
pub struct PiResponseFailure {
    pub message: String,
    pub trace: Option<Value>,
}

pub fn extract_pi_response(
    events: &[Value],
    last_assistant_text: Option<String>,
) -> Result<PiResponseExtraction, PiResponseFailure> {
    let trace = build_pi_trace_metadata(events);
    if let Some(message) = pi_failure_message(events) {
        return Err(PiResponseFailure { message, trace });
    }

    let assistant_text = last_assistant_text
        .filter(|text| !text.trim().is_empty())
        .or_else(|| assistant_text_from_pi_events(events))
        .unwrap_or_else(|| "Pi Agent 没有返回文本。".to_owned());
    Ok(PiResponseExtraction {
        assistant_text,
        trace,
    })
}

fn assistant_text_from_pi_events(events: &[Value]) -> Option<String> {
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

fn pi_failure_message(events: &[Value]) -> Option<String> {
    if let Some(event) = events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("extension_error"))
    {
        return Some(format!(
            "Pi Agent 扩展执行失败：{}",
            value_error_text(event.get("error")).unwrap_or_else(|| "未知扩展错误".to_owned())
        ));
    }

    if let Some(event) = events.iter().rev().find(|event| {
        event.get("type").and_then(Value::as_str) == Some("auto_retry_end")
            && event.get("success").and_then(Value::as_bool) == Some(false)
    }) {
        return Some(format!(
            "Pi Agent 自动重试最终失败：{}",
            event
                .get("finalError")
                .or_else(|| event.get("final_error"))
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        ));
    }

    if let Some(agent_end) = events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("agent_end"))
    {
        if let Some(message) = agent_end
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| messages.iter().rev().find_map(assistant_message_failure))
        {
            return Some(message);
        }
        // 最终 agent_end 成功时，之前的流错误可能已被自动重试恢复。
        return None;
    }

    events.iter().rev().find_map(|event| {
        let assistant_event = event.get("assistantMessageEvent")?;
        if assistant_event.get("type").and_then(Value::as_str) != Some("error") {
            return None;
        }
        Some(assistant_message_event_error(event))
    })
}

fn assistant_message_event_error(event: &Value) -> String {
    let assistant_event = event.get("assistantMessageEvent");
    let error = assistant_event.and_then(|event| event.get("error"));
    let reason = assistant_event
        .and_then(|event| event.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("error");
    let detail = error
        .and_then(|value| value.get("errorMessage"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| value_error_text(error))
        .unwrap_or_else(|| "未知错误".to_owned());
    format!("Pi Agent 消息生成失败（{reason}）：{detail}")
}

fn assistant_message_failure(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let stop_reason = message
        .get("stopReason")
        .or_else(|| message.get("stop_reason"))
        .and_then(Value::as_str);
    let error_message = message
        .get("errorMessage")
        .or_else(|| message.get("error_message"))
        .and_then(Value::as_str);
    let terminated =
        error_message.is_some_and(|message| message.to_ascii_lowercase().contains("terminated"));
    if !matches!(stop_reason, Some("error" | "aborted")) && !terminated {
        return None;
    }

    let reason = stop_reason.unwrap_or("error");
    Some(format!(
        "Pi Agent 执行失败（{reason}）：{}",
        error_message.unwrap_or("未知错误")
    ))
}

fn value_error_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Object(object) => object
            .get("message")
            .or_else(|| object.get("errorMessage"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| Some(Value::Object(object.clone()).to_string())),
        value => Some(value.to_string()),
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

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use raccoon_core::models::{
        ClarificationAnswer, ClarificationQuestionType, ModelSettings, Project, RequirementDraft,
        RequirementMessage,
    };

    #[test]
    fn continuation_prompt_keeps_the_previous_requirement_context() {
        let now = Utc::now();
        let input = RequirementAnalysisInput {
            project: Project {
                id: "p1".to_owned(),
                name: "Demo".to_owned(),
                git_url: "https://example.com/demo.git".to_owned(),
                local_path: "/tmp/demo".to_owned(),
                created_at: now,
                updated_at: now,
            },
            messages: vec![
                RequirementMessage {
                    role: RequirementMessageRole::User,
                    content: "增加导出功能".to_owned(),
                    references: Vec::new(),
                    images: Vec::new(),
                    metadata: None,
                    created_at: now,
                },
                RequirementMessage {
                    role: RequirementMessageRole::User,
                    content: "补充支持 CSV".to_owned(),
                    references: Vec::new(),
                    images: Vec::new(),
                    metadata: None,
                    created_at: now,
                },
            ],
            reference_context: None,
            prompt_images: Vec::new(),
            clarifications: vec![RequirementClarification {
                id: "q1".to_owned(),
                question: "导出范围？".to_owned(),
                question_type: ClarificationQuestionType::SingleChoice,
                options: Vec::new(),
                answer: Some(ClarificationAnswer {
                    selected_options: vec!["全部".to_owned()],
                    custom_text: None,
                }),
            }],
            draft: Some(RequirementDraft {
                title: "导出功能".to_owned(),
                summary: "支持数据导出".to_owned(),
                acceptance_criteria: vec!["可以下载文件".to_owned()],
            }),
            model_settings: ModelSettings::default(),
            pi_session_file: Some("session.jsonl".to_owned()),
        };

        let prompt = build_requirement_prompt(&input);
        assert!(prompt.contains("后续补充不是一个全新的需求"));
        assert!(prompt.contains("原始需求：增加导出功能"));
        assert!(prompt.contains("上一版确认草案：导出功能：支持数据导出"));
        assert!(prompt.contains("已有澄清：导出范围？：全部"));
        assert!(prompt.contains("本轮输入：补充支持 CSV"));
        assert!(prompt.contains("必须通过工具提交结果"));
        assert!(!prompt.contains("只输出一个 JSON 对象"));
    }

    #[test]
    fn parses_managed_extension_draft_result() {
        let events = vec![json!({
            "type": "tool_execution_end",
            "toolCallId": "call-1",
            "toolName": "submit_requirement_draft",
            "isError": false,
            "result": {
                "content": [{"type": "text", "text": "ok"}],
                "details": {
                    "protocol": "raccoon:clarifications:v1",
                    "kind": "draft",
                    "progress": "已检查仓库现状",
                    "message": "需求已明确",
                    "draft": {
                        "title": "导出 CSV",
                        "summary": "沿用现有导出入口",
                        "acceptance_criteria": ["可以下载 CSV"]
                    }
                }
            }
        })];

        let output = parse_requirement_tool_analysis(&events, None, None);
        assert_eq!(output.status, RequirementStatus::DraftReady);
        assert_eq!(output.draft.unwrap().title, "导出 CSV");
    }

    #[test]
    fn rejects_missing_or_duplicate_managed_tool_results() {
        let event = json!({
            "type": "tool_execution_end",
            "toolCallId": "call-1",
            "toolName": "submit_requirement_draft",
            "isError": false,
            "result": {
                "details": {
                    "kind": "draft",
                    "progress": "done",
                    "message": "ok",
                    "draft": {
                        "title": "t",
                        "summary": "s",
                        "acceptance_criteria": ["a"]
                    }
                }
            }
        });

        assert_eq!(
            parse_requirement_tool_analysis(&[], None, None).status,
            RequirementStatus::Failed
        );
        assert_eq!(
            parse_requirement_tool_analysis(&[event.clone(), event], None, None).status,
            RequirementStatus::Failed
        );
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
            extract_pi_response(&events, None).unwrap().assistant_text,
            "{\"status\":\"ready\",\"message\":\"ok\",\"clarifications\":[],\"draft\":null}"
        );
    }

    #[test]
    fn recognizes_official_pi_failure_events_before_business_json() {
        let cases = [
            vec![json!({
                "type": "agent_end",
                "messages": [{
                    "role": "assistant",
                    "stopReason": "error",
                    "errorMessage": "provider failed"
                }]
            })],
            vec![json!({
                "type": "agent_end",
                "messages": [{
                    "role": "assistant",
                    "stopReason": "aborted",
                    "errorMessage": "cancelled"
                }]
            })],
            vec![json!({
                "type": "agent_end",
                "messages": [{
                    "role": "assistant",
                    "stopReason": "stop",
                    "errorMessage": "stream terminated"
                }]
            })],
            vec![json!({
                "type": "auto_retry_end",
                "success": false,
                "attempt": 3,
                "finalError": "still unavailable"
            })],
            vec![json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "error",
                    "reason": "error",
                    "error": {
                        "role": "assistant",
                        "stopReason": "error",
                        "errorMessage": "stream failed"
                    }
                }
            })],
            vec![json!({
                "type": "extension_error",
                "extensionPath": "extension.ts",
                "event": "tool_call",
                "error": "extension failed"
            })],
        ];

        for events in cases {
            let failure =
                extract_pi_response(&events, Some(r#"{"status":"ready"}"#.to_owned())).unwrap_err();
            assert!(!failure.message.is_empty());
            assert!(failure.trace.is_some());
        }
    }

    #[test]
    fn final_successful_agent_end_clears_retried_stream_error() {
        let events = vec![
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "error",
                    "reason": "error",
                    "error": {
                        "role": "assistant",
                        "stopReason": "error",
                        "errorMessage": "temporarily unavailable"
                    }
                }
            }),
            json!({
                "type": "auto_retry_end",
                "success": true,
                "attempt": 1
            }),
            json!({
                "type": "agent_end",
                "messages": [{
                    "role": "assistant",
                    "stopReason": "stop"
                }]
            }),
        ];

        let response = extract_pi_response(&events, Some("{}".to_owned())).unwrap();
        assert_eq!(response.assistant_text, "{}");
        assert!(response.trace.is_some());
    }
}
