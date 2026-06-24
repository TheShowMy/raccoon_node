use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    NotFound(String),
    Internal(String),
    TaskExecution {
        message: String,
        pi_session_file: Option<String>,
    },
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn task_execution(message: impl Into<String>, pi_session_file: Option<String>) -> Self {
        Self::TaskExecution {
            message: message.into(),
            pi_session_file,
        }
    }

    pub fn pi_session_file(&self) -> Option<&str> {
        match self {
            Self::TaskExecution {
                pi_session_file: Some(path),
                ..
            } => Some(path),
            _ => None,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::Internal(message) => {
                tracing::error!("internal error: {}", message);
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
            Self::TaskExecution { message, .. } => {
                tracing::error!("task execution error: {}", message);
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
            Self::Io(error) => {
                tracing::error!("io error: {}", error);
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
            Self::Json(error) => {
                tracing::error!("json error: {}", error);
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
        };

        (status, Json(ApiError { message })).into_response()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message)
            | Self::NotFound(message)
            | Self::Internal(message)
            | Self::TaskExecution { message, .. } => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub message: String,
}
