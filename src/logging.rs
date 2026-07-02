use std::{
    io::{self, Write},
    path::Path,
    sync::mpsc,
};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub type InitResult =
    Result<(WorkerGuard, Option<mpsc::Receiver<String>>), Box<dyn std::error::Error>>;

pub fn init(data_root: &Path, enable_tui_channel: bool) -> InitResult {
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
    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(io::stderr);

    if enable_tui_channel {
        // 使用无界 channel：TUI 每 100ms  drain 一次，面板最多保留 200 行，
        // 日志量正常时不会积压；有界 channel 可能在 TUI 卡住时丢失日志。
        let (log_tx, log_rx) = mpsc::channel();
        let channel_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(move || ChannelWriter::new(log_tx.clone()));
        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(stderr_layer)
            .with(channel_layer)
            .try_init()?;
        Ok((guard, Some(log_rx)))
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(stderr_layer)
            .try_init()?;
        Ok((guard, None))
    }
}

struct ChannelWriter {
    sender: mpsc::Sender<String>,
}

impl ChannelWriter {
    fn new(sender: mpsc::Sender<String>) -> Self {
        Self { sender }
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let text = String::from_utf8_lossy(buf)
            .trim_end_matches(['\n', '\r'])
            .to_owned();
        if !text.is_empty() {
            // TUI 可能已关闭或处于非 TUI 模式，丢弃发送失败是安全的。
            let _ = self.sender.send(text);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        // tracing-subscriber 不会调用 flush；每条日志在 write 时即发送。
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_writer_sends_line_on_write() {
        let (tx, rx) = mpsc::channel();
        let mut writer = ChannelWriter::new(tx);

        write!(writer, "hello log").unwrap();

        assert_eq!(rx.recv().unwrap(), "hello log");
    }

    #[test]
    fn channel_writer_strips_trailing_newline() {
        let (tx, rx) = mpsc::channel();
        let mut writer = ChannelWriter::new(tx);

        writeln!(writer, "hello log").unwrap();

        assert_eq!(rx.recv().unwrap(), "hello log");
    }

    #[test]
    fn channel_writer_sends_each_write_as_separate_line() {
        let (tx, rx) = mpsc::channel();
        let mut writer = ChannelWriter::new(tx);

        write!(writer, "part1 ").unwrap();
        write!(writer, "part2").unwrap();

        assert_eq!(rx.recv().unwrap(), "part1 ");
        assert_eq!(rx.recv().unwrap(), "part2");
    }

    #[test]
    fn channel_writer_does_not_send_empty_line() {
        let (tx, rx) = mpsc::channel();
        let mut writer = ChannelWriter::new(tx);

        writeln!(writer).unwrap();
        assert!(rx.try_recv().is_err());
    }
}
