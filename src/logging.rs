use std::{io, path::Path, sync::mpsc};

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::LogWriter;

pub fn init(
    data_root: &Path,
    tui_logs: Option<mpsc::Sender<String>>,
) -> Result<tracing_appender::non_blocking::WorkerGuard, Box<dyn std::error::Error>> {
    let file = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("raccoon")
        .max_log_files(7)
        .build(data_root.join("logs"))?;
    let (file, guard) = tracing_appender::non_blocking(file);
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(file);

    if let Some(logs) = tui_logs {
        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(LogWriter(logs)),
            )
            .try_init()?;
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(io::stderr),
            )
            .try_init()?;
    }

    Ok(guard)
}
