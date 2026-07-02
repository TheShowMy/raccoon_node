use std::{io, sync::mpsc::Receiver, time::Duration};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};

use raccoon_core::{
    config::{AppConfig, CommitMode, Theme},
    models::PublicationReadiness,
};

#[derive(Debug, Clone, Copy, Default)]
pub struct ConfigEditContext {
    pub host_overridden: bool,
    pub port_overridden: bool,
    pub commit_mode_overridden: bool,
}

pub enum PublicationReadinessState {
    Loading,
    Ready(PublicationReadiness),
}

impl PublicationReadinessState {
    fn is_loading(&self) -> bool {
        matches!(self, Self::Loading)
    }

    fn readiness(&self) -> Option<&PublicationReadiness> {
        match self {
            Self::Loading => None,
            Self::Ready(readiness) => Some(readiness),
        }
    }
}

pub struct ConfigEditOptions {
    pub publication_readiness: PublicationReadinessState,
    pub publication_readiness_rx: Option<Receiver<PublicationReadiness>>,
}

impl ConfigEditOptions {
    pub fn ready(publication_readiness: PublicationReadiness) -> Self {
        Self {
            publication_readiness: PublicationReadinessState::Ready(publication_readiness),
            publication_readiness_rx: None,
        }
    }

    pub fn loading(publication_readiness_rx: Receiver<PublicationReadiness>) -> Self {
        Self {
            publication_readiness: PublicationReadinessState::Loading,
            publication_readiness_rx: Some(publication_readiness_rx),
        }
    }
}

impl From<&PublicationReadiness> for ConfigEditOptions {
    fn from(publication_readiness: &PublicationReadiness) -> Self {
        Self::ready(publication_readiness.clone())
    }
}

enum Overlay {
    None,
    ConfirmExternal,
    PrReadiness(Vec<String>),
}

pub fn edit_config(
    initial: AppConfig,
    title: &str,
    context: ConfigEditContext,
    publication_readiness: &PublicationReadiness,
) -> io::Result<Option<AppConfig>> {
    let mut session = crate::TuiSession::enter()?;
    session.edit_config(initial, title, context, publication_readiness)
}

pub(crate) fn edit_config_with_terminal(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    initial: AppConfig,
    title: &str,
    context: ConfigEditContext,
    options: impl Into<ConfigEditOptions>,
) -> io::Result<Option<AppConfig>> {
    let mut options = options.into();
    let mut config = initial;
    let mut list_state = ListState::default();
    list_state.select_first();
    let mut port = config.port.to_string();
    let mut overlay = Overlay::None;
    let mut error: Option<&'static str> = None;

    loop {
        update_publication_readiness(&mut options);
        terminal.draw(|frame| {
            let area = frame.area();
            let main_layout =
                Layout::vertical([Constraint::Min(10), Constraint::Length(3)]).split(area);

            let items = setting_items(
                &config,
                &port,
                list_state.selected().unwrap_or(0),
                &context,
                &options.publication_readiness,
            );
            let list = List::new(items)
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_type(ratatui::widgets::BorderType::Rounded)
                        .title(title),
                )
                .highlight_style(
                    Style::default()
                        .bg(Color::Cyan)
                        .fg(Color::Black)
                        .add_modifier(Modifier::BOLD),
                )
                .highlight_symbol("› ");
            frame.render_stateful_widget(list, main_layout[0], &mut list_state);

            let help = help_text(
                list_state.selected().unwrap_or(0),
                &overlay,
                &options.publication_readiness,
            );
            frame.render_widget(
                Paragraph::new(help).block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_type(ratatui::widgets::BorderType::Rounded)
                        .title("操作"),
                ),
                main_layout[1],
            );

            if let Some(message) = error {
                frame.render_widget(
                    Paragraph::new(Line::styled(message, Style::default().fg(Color::Red))).block(
                        Block::default()
                            .borders(Borders::ALL)
                            .border_type(ratatui::widgets::BorderType::Rounded)
                            .title("错误"),
                    ),
                    centered(area, 60, 3),
                );
            }

            match &overlay {
                Overlay::ConfirmExternal => {
                    render_overlay(
                        frame,
                        area,
                        "确认监听所有接口",
                        &[
                            "当前选择 0.0.0.0，会监听所有网络接口，且 API 暂无鉴权。",
                            "按 y 保存，按 n/Esc 返回设置。",
                        ],
                    );
                }
                Overlay::PrReadiness(issues) => {
                    let mut lines: Vec<Line> = issues
                        .iter()
                        .map(|issue| Line::raw(issue.as_str()))
                        .collect();
                    lines.push(Line::raw(""));
                    lines.push(Line::styled(
                        "按任意键返回并继续保持本地提交模式。",
                        Style::default().fg(Color::Yellow),
                    ));
                    render_overlay(
                        frame,
                        area,
                        "PR 合并条件不满足",
                        &lines
                            .iter()
                            .map(|line| line.to_string())
                            .collect::<Vec<_>>(),
                    );
                }
                Overlay::None => {}
            }
        })?;

        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if !usable_key(key) {
            continue;
        }

        match overlay {
            Overlay::ConfirmExternal => match key.code {
                KeyCode::Char(value) if char_matches(value, 'y') => return Ok(Some(config)),
                KeyCode::Char(value) if char_matches(value, 'n') => overlay = Overlay::None,
                KeyCode::Esc => overlay = Overlay::None,
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    return Ok(None);
                }
                _ => {}
            },
            Overlay::PrReadiness(_) => {
                overlay = Overlay::None;
                continue;
            }
            Overlay::None => {
                if error.is_some() && !matches!(key.code, KeyCode::Esc | KeyCode::Enter) {
                    error = None;
                }

                match key.code {
                    KeyCode::Esc => return Ok(None),
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        return Ok(None);
                    }
                    KeyCode::Up => {
                        list_state.select_previous();
                        error = None;
                    }
                    KeyCode::Down => {
                        list_state.select_next();
                        error = None;
                    }
                    KeyCode::Left | KeyCode::Right => {
                        let selected = list_state.selected().unwrap_or(0);
                        match selected {
                            0 => cycle_theme(&mut config),
                            1 => cycle_host(&mut config, context.host_overridden),
                            3 => {
                                if options.publication_readiness.is_loading() {
                                    error = Some("正在检查 PR/MR 条件，请稍候");
                                    continue;
                                }
                                let desired =
                                    cycle_commit_mode(&mut config, context.commit_mode_overridden);
                                if desired == CommitMode::PullRequest
                                    && let Some(readiness) =
                                        options.publication_readiness.readiness()
                                    && !readiness.ready
                                {
                                    config.commit_mode = CommitMode::Local;
                                    overlay = Overlay::PrReadiness(readiness.issues.clone());
                                }
                            }
                            _ => {}
                        }
                        error = None;
                    }
                    KeyCode::Backspace => {
                        if list_state.selected() == Some(2) {
                            port.pop();
                            error = None;
                        }
                    }
                    KeyCode::Delete => {
                        if list_state.selected() == Some(2) {
                            port.clear();
                            error = None;
                        }
                    }
                    KeyCode::Char('u')
                        if key.modifiers.contains(KeyModifiers::CONTROL)
                            && list_state.selected() == Some(2) =>
                    {
                        port.clear();
                        error = None;
                    }
                    KeyCode::Char(value)
                        if list_state.selected() == Some(2) && value.is_ascii_digit() =>
                    {
                        push_port_digit(&mut port, value);
                        error = None;
                    }
                    KeyCode::Enter => {
                        let parsed = match validate_port_input(&port) {
                            Ok(parsed) => parsed,
                            Err(message) => {
                                list_state.select(Some(2));
                                error = Some(message);
                                continue;
                            }
                        };
                        config.port = parsed;
                        error = None;
                        if config.host == "0.0.0.0" {
                            overlay = Overlay::ConfirmExternal;
                        } else {
                            return Ok(Some(config));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn update_publication_readiness(options: &mut ConfigEditOptions) {
    if let Some(receiver) = &options.publication_readiness_rx
        && let Ok(readiness) = receiver.try_recv()
    {
        options.publication_readiness = PublicationReadinessState::Ready(readiness);
        options.publication_readiness_rx = None;
    }
}

fn setting_items(
    config: &AppConfig,
    port: &str,
    selected: usize,
    context: &ConfigEditContext,
    publication_readiness: &PublicationReadinessState,
) -> Vec<ListItem<'static>> {
    let host_value = if context.host_overridden {
        format!("{}（本次被 --host 覆盖）", config.host)
    } else {
        config.host.clone()
    };
    let port_display = if selected == 2 {
        if port.is_empty() {
            "_".to_owned()
        } else {
            format!("{port}_")
        }
    } else {
        port.to_owned()
    };
    let port_value = if context.port_overridden {
        format!("{port_display}（本次被 --port 覆盖）")
    } else {
        port_display
    };

    let commit_mode_value = match publication_readiness {
        PublicationReadinessState::Loading => "正在检查 PR/MR 条件…".to_owned(),
        PublicationReadinessState::Ready(_) => match config.commit_mode {
            CommitMode::Local => "本地提交".to_owned(),
            CommitMode::PullRequest => "PR / MR 合并".to_owned(),
        },
    };

    vec![
        ListItem::new(Line::from(vec![
            Span::styled(format!("{:<12}", "主题"), Style::default().fg(Color::Gray)),
            Span::raw(match config.theme {
                Theme::Light => "亮色",
                Theme::Dark => "暗色",
            }),
        ])),
        ListItem::new(Line::from(vec![
            Span::styled(
                format!("{:<12}", "监听地址"),
                Style::default().fg(Color::Gray),
            ),
            Span::raw(host_value),
        ])),
        ListItem::new(Line::from(vec![
            Span::styled(format!("{:<12}", "端口"), Style::default().fg(Color::Gray)),
            Span::raw(port_value),
        ])),
        ListItem::new(Line::from(vec![
            Span::styled(
                format!("{:<12}", "提交模式"),
                Style::default().fg(Color::Gray),
            ),
            Span::raw(commit_mode_value),
        ])),
    ]
}

fn help_text(
    selected: usize,
    overlay: &Overlay,
    publication_readiness: &PublicationReadinessState,
) -> Line<'static> {
    if matches!(overlay, Overlay::ConfirmExternal) {
        return Line::raw("y 确认保存   n/Esc 返回");
    }
    if selected == 3 && publication_readiness.is_loading() {
        return Line::raw("正在检查 PR/MR 条件，完成后可切换提交模式   Enter 保存   Esc 取消");
    }
    match selected {
        0 => Line::raw("↑↓ 切换行   ←→ 切换主题   Enter 保存   Esc 取消"),
        1 => Line::raw("↑↓ 切换行   ←→ 切换监听地址   Enter 保存   Esc 取消"),
        2 => {
            Line::raw("数字输入端口   Backspace 删除   Ctrl+U/Delete 清空   Enter 保存   Esc 取消")
        }
        3 => Line::raw("↑↓ 切换行   ←→ 切换提交模式   Enter 保存   Esc 取消"),
        _ => Line::raw("↑↓ 切换行   Enter 保存   Esc 取消"),
    }
}

fn cycle_theme(config: &mut AppConfig) {
    config.theme = match config.theme {
        Theme::Light => Theme::Dark,
        Theme::Dark => Theme::Light,
    };
}

fn cycle_host(config: &mut AppConfig, overridden: bool) {
    if overridden {
        return;
    }
    config.host = if config.host == "127.0.0.1" {
        "0.0.0.0".to_owned()
    } else {
        "127.0.0.1".to_owned()
    };
}

fn cycle_commit_mode(config: &mut AppConfig, overridden: bool) -> CommitMode {
    if overridden {
        return config.commit_mode;
    }
    config.commit_mode = match config.commit_mode {
        CommitMode::Local => CommitMode::PullRequest,
        CommitMode::PullRequest => CommitMode::Local,
    };
    config.commit_mode
}

fn push_port_digit(port: &mut String, value: char) {
    if value.is_ascii_digit() && port.len() < 5 {
        port.push(value);
    }
}

fn validate_port_input(input: &str) -> Result<u16, &'static str> {
    if input.is_empty() {
        return Err("端口不能为空");
    }
    let parsed = input.parse::<u32>().map_err(|_| "端口必须是 1-65535")?;
    if parsed == 0 {
        Err("端口必须大于 0")
    } else if parsed <= u16::MAX as u32 {
        Ok(parsed as u16)
    } else {
        Err("端口必须是 1-65535")
    }
}

fn render_overlay(frame: &mut ratatui::Frame, area: Rect, title: &str, lines: &[impl AsRef<str>]) {
    let overlay_area = centered(area, 76, (lines.len() as u16 + 4).min(area.height));
    frame.render_widget(Clear, overlay_area);
    let text: Vec<Line> = lines
        .iter()
        .map(|line| Line::raw(line.as_ref().to_owned()))
        .collect();
    frame.render_widget(
        Paragraph::new(text)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_type(ratatui::widgets::BorderType::Rounded)
                    .title(title)
                    .style(Style::default().fg(Color::Yellow)),
            )
            .wrap(Wrap { trim: true }),
        overlay_area,
    );
}

fn usable_key(key: KeyEvent) -> bool {
    !matches!(key.kind, KeyEventKind::Release)
}

fn char_matches(value: char, expected: char) -> bool {
    value.eq_ignore_ascii_case(&expected)
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let vertical = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(height.min(area.height)),
        Constraint::Fill(1),
    ])
    .split(area);
    Layout::horizontal([
        Constraint::Fill(1),
        Constraint::Length(width.min(area.width)),
        Constraint::Fill(1),
    ])
    .split(vertical[1])[1]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_port_input_boundaries() {
        assert_eq!(validate_port_input(""), Err("端口不能为空"));
        assert_eq!(validate_port_input("0"), Err("端口必须大于 0"));
        assert_eq!(validate_port_input("3001"), Ok(3001));
        assert_eq!(validate_port_input("65535"), Ok(65535));
        assert_eq!(validate_port_input("65536"), Err("端口必须是 1-65535"));
        assert_eq!(validate_port_input("abc"), Err("端口必须是 1-65535"));
    }

    #[test]
    fn push_port_digit_keeps_five_digit_limit() {
        let mut port = "6553".to_owned();
        push_port_digit(&mut port, '5');
        push_port_digit(&mut port, '6');
        push_port_digit(&mut port, 'x');
        assert_eq!(port, "65535");
    }

    #[test]
    fn cycle_commit_mode_toggles() {
        let mut config = AppConfig::default();
        assert_eq!(cycle_commit_mode(&mut config, false), CommitMode::Local);
        assert_eq!(
            cycle_commit_mode(&mut config, false),
            CommitMode::PullRequest
        );
        assert_eq!(
            cycle_commit_mode(&mut config, true),
            CommitMode::PullRequest
        );
    }
}
