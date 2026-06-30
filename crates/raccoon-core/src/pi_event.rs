use serde_json::Value;

pub fn summarize_pi_event(pi_type: &str, payload: &Value) -> String {
    match pi_type {
        "agent_start" => "Pi Agent 开始处理。".to_owned(),
        "agent_end" => payload
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| messages.iter().rev().find_map(assistant_message_failure))
            .unwrap_or_else(|| "Pi Agent 处理完成。".to_owned()),
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
        "auto_retry_start" => format!(
            "Pi Agent 将自动重试：{}",
            payload
                .get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        ),
        "auto_retry_end" if payload.get("success").and_then(Value::as_bool) == Some(false) => {
            format!(
                "Pi Agent 自动重试最终失败：{}",
                payload
                    .get("finalError")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            )
        }
        "auto_retry_end" => "Pi Agent 自动重试成功。".to_owned(),
        "extension_error" => format!(
            "Pi Agent 扩展执行失败：{}",
            value_error_text(payload.get("error")).unwrap_or_else(|| "未知错误".to_owned())
        ),
        _ => format!("Pi Agent 事件：{pi_type}"),
    }
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
