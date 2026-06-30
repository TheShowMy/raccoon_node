use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Internal(String),
    #[error("{message}")]
    TaskExecution {
        message: String,
        pi_session_file: Option<String>,
    },
    #[error("I/O 错误")]
    Io(#[source] std::io::Error),
    #[error("JSON 错误")]
    Json(#[source] serde_json::Error),
    #[error("数据库错误")]
    Database(#[source] rusqlite::Error),
}

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
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
            Self::Conflict(message) => (StatusCode::CONFLICT, message),
            Self::Internal(message) => {
                tracing::error!(error = %message, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
            Self::TaskExecution { message, .. } => {
                tracing::error!(error = %message, "task execution error");
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
            Self::Io(error) => {
                tracing::error!(error = %error, "io error");
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
            Self::Json(error) => {
                tracing::error!(error = %error, "json error");
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
            Self::Database(error) => {
                tracing::error!(error = %error, "database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "内部错误".to_owned())
            }
        };

        (status, Json(ApiError { message })).into_response()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_uses_http_409_and_database_keeps_source() {
        assert_eq!(
            AppError::conflict("状态冲突").into_response().status(),
            StatusCode::CONFLICT
        );

        let error = AppError::from(rusqlite::Error::InvalidQuery);
        assert!(std::error::Error::source(&error).is_some());
    }
}
