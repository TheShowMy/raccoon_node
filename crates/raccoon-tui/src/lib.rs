use std::{
    io::{self, stdout},
    sync::mpsc::Receiver,
    time::Duration,
};

use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
};

use raccoon_core::{
    config::AppConfig,
    models::{ModelSettings, ModelTierSetting, PiModel, ThinkingLevel},
};

pub mod settings;
pub use settings::{ConfigEditContext, ConfigEditOptions, edit_config};

pub enum DashboardAction {
    Quit,
    Restart,
    Settings,
    Open,
}

pub fn confirm(title: &str, message: &str) -> io::Result<bool> {
    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    loop {
        terminal.draw(|frame| {
            let area = centered(frame.area(), 72, 10);
            frame.render_widget(
                Paragraph::new(vec![
                    Line::raw(message.to_owned()),
                    Line::raw(""),
                    Line::styled("y 确认   n/Esc 取消", Style::default().fg(Color::Yellow)),
                ])
                .block(Block::default().title(title).borders(Borders::ALL))
                .wrap(Wrap { trim: true }),
                area,
            );
        })?;
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if !usable_key(key) {
            continue;
        }
        match key.code {
            KeyCode::Char(value) if char_matches(value, 'y') => return Ok(true),
            KeyCode::Char(value) if char_matches(value, 'n') => return Ok(false),
            KeyCode::Esc => return Ok(false),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Ok(false);
            }
            _ => {}
        }
    }
}

pub struct TuiSession {
    _guard: TerminalGuard,
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
}

impl TuiSession {
    pub fn enter() -> io::Result<Self> {
        Ok(Self {
            _guard: TerminalGuard::enter()?,
            terminal: Terminal::new(CrosstermBackend::new(stdout()))?,
        })
    }

    pub fn show_status(&mut self, title: &str, message: &str) -> io::Result<()> {
        self.terminal.draw(|frame| {
            let area = centered(frame.area(), 72, 7);
            frame.render_widget(
                Paragraph::new(vec![Line::raw(message.to_owned())])
                    .block(Block::default().title(title).borders(Borders::ALL))
                    .wrap(Wrap { trim: true }),
                area,
            );
        })?;
        Ok(())
    }

    pub fn run_dashboard(
        &mut self,
        url: &str,
        backend_logs: &Receiver<String>,
        vite_logs: Option<&Receiver<String>>,
    ) -> io::Result<DashboardAction> {
        run_dashboard_with_terminal(&mut self.terminal, url, backend_logs, vite_logs)
    }

    pub fn edit_config(
        &mut self,
        initial: AppConfig,
        title: &str,
        context: ConfigEditContext,
        options: impl Into<ConfigEditOptions>,
    ) -> io::Result<Option<AppConfig>> {
        settings::edit_config_with_terminal(&mut self.terminal, initial, title, context, options)
    }

    pub fn edit_models(
        &mut self,
        models: &[PiModel],
        initial: ModelSettings,
    ) -> io::Result<Option<ModelSettings>> {
        edit_models_with_terminal(&mut self.terminal, models, initial)
    }
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        execute!(stdout(), EnterAlternateScreen)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(stdout(), LeaveAlternateScreen);
    }
}

pub fn run_dashboard(
    url: &str,
    backend_logs: &Receiver<String>,
    vite_logs: Option<&Receiver<String>>,
) -> io::Result<DashboardAction> {
    let mut session = TuiSession::enter()?;
    session.run_dashboard(url, backend_logs, vite_logs)
}

fn run_dashboard_with_terminal(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    url: &str,
    backend_logs: &Receiver<String>,
    vite_logs: Option<&Receiver<String>>,
) -> io::Result<DashboardAction> {
    let mut backend_lines = Vec::new();
    let mut vite_lines = Vec::new();

    loop {
        drain_logs(backend_logs, &mut backend_lines);
        if let Some(vite_logs) = vite_logs {
            drain_logs(vite_logs, &mut vite_lines);
        }
        terminal.draw(|frame| {
            let areas = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(5), Constraint::Length(5)])
                .split(frame.area());
            if vite_logs.is_some() {
                let log_areas = if areas[0].width >= 100 {
                    Layout::default()
                        .direction(Direction::Horizontal)
                        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                        .split(areas[0])
                } else {
                    Layout::default()
                        .direction(Direction::Vertical)
                        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                        .split(areas[0])
                };
                render_log_panel(frame, log_areas[0], "后端日志", &backend_lines);
                render_log_panel(frame, log_areas[1], "Vite 日志", &vite_lines);
            } else {
                render_log_panel(frame, areas[0], "运行日志", &backend_lines);
            }
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(vec![Span::styled(
                        url,
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    )]),
                    Line::raw("o 打开浏览器   s 设置   r 重启   q 退出"),
                ])
                .block(Block::default().title("Raccoon").borders(Borders::ALL)),
                areas[1],
            );
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
        match key.code {
            KeyCode::Char(value) if char_matches(value, 'q') => return Ok(DashboardAction::Quit),
            KeyCode::Char(value) if char_matches(value, 'r') => {
                return Ok(DashboardAction::Restart);
            }
            KeyCode::Char(value) if char_matches(value, 's') => {
                return Ok(DashboardAction::Settings);
            }
            KeyCode::Char(value) if char_matches(value, 'o') => return Ok(DashboardAction::Open),
            KeyCode::Esc => return Ok(DashboardAction::Quit),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Ok(DashboardAction::Quit);
            }
            _ => {}
        }
    }
}

fn drain_logs(receiver: &Receiver<String>, lines: &mut Vec<String>) {
    while let Ok(line) = receiver.try_recv() {
        lines.push(line);
        if lines.len() > 500 {
            lines.drain(..100);
        }
    }
}

fn render_log_panel(
    frame: &mut ratatui::Frame<'_>,
    area: ratatui::layout::Rect,
    title: &str,
    lines: &[String],
) {
    let height = area.height.saturating_sub(2) as usize;
    let visible = log_items(lines, height);
    frame.render_widget(
        List::new(visible).block(Block::default().title(title).borders(Borders::ALL)),
        area,
    );
}

fn log_items(lines: &[String], height: usize) -> Vec<ListItem<'_>> {
    lines
        .iter()
        .rev()
        .take(height)
        .rev()
        .map(|line| ListItem::new(line.as_str()))
        .collect()
}

pub fn edit_models(
    models: &[PiModel],
    initial: ModelSettings,
) -> io::Result<Option<ModelSettings>> {
    let mut session = TuiSession::enter()?;
    session.edit_models(models, initial)
}

fn edit_models_with_terminal(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    models: &[PiModel],
    initial: ModelSettings,
) -> io::Result<Option<ModelSettings>> {
    if models.is_empty() {
        return Ok(None);
    }
    let mut settings = initial;
    let mut row = 0_usize;

    loop {
        terminal.draw(|frame| {
            let area = centered(frame.area(), 76, 16);
            let tiers = [
                ("低", &settings.low),
                ("中", &settings.medium),
                ("高", &settings.high),
            ];
            let mut lines = tiers
                .iter()
                .enumerate()
                .map(|(index, (label, tier))| {
                    setting_line(
                        row == index,
                        label,
                        &format!(
                            "{} / {}",
                            model_name(models, tier),
                            tier.thinking_level.as_str()
                        ),
                    )
                })
                .collect::<Vec<_>>();
            lines.extend([
                Line::raw(""),
                Line::raw("↑↓ 选择档位  ←→ 模型  t 思考等级  Enter 保存  Esc 取消"),
            ]);
            frame.render_widget(
                Paragraph::new(lines)
                    .block(Block::default().title("模型设置").borders(Borders::ALL)),
                area,
            );
        })?;
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if !usable_key(key) {
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(None),
            KeyCode::Enter => return Ok(Some(settings)),
            KeyCode::Up => row = row.saturating_sub(1),
            KeyCode::Down => row = (row + 1).min(2),
            KeyCode::Left => cycle_model(tier_mut(&mut settings, row), models, -1),
            KeyCode::Right => cycle_model(tier_mut(&mut settings, row), models, 1),
            KeyCode::Char(value) if char_matches(value, 't') => {
                let tier = tier_mut(&mut settings, row);
                tier.thinking_level = next_thinking(tier.thinking_level);
            }
            _ => {}
        }
    }
}

fn setting_line(selected: bool, label: &str, value: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            if selected { "› " } else { "  " },
            Style::default().fg(Color::Cyan),
        ),
        Span::styled(format!("{label:<10}"), Style::default().fg(Color::Gray)),
        Span::raw(value.to_owned()),
    ])
}

fn usable_key(key: KeyEvent) -> bool {
    !matches!(key.kind, KeyEventKind::Release)
}

fn char_matches(value: char, expected: char) -> bool {
    value.eq_ignore_ascii_case(&expected)
}

fn tier_mut(settings: &mut ModelSettings, row: usize) -> &mut ModelTierSetting {
    match row {
        0 => &mut settings.low,
        1 => &mut settings.medium,
        _ => &mut settings.high,
    }
}

fn model_name(models: &[PiModel], tier: &ModelTierSetting) -> String {
    tier.model_id
        .as_deref()
        .and_then(|id| models.iter().find(|model| model.id == id))
        .map(|model| model.name.clone())
        .unwrap_or_else(|| "未选择".to_owned())
}

fn cycle_model(tier: &mut ModelTierSetting, models: &[PiModel], delta: isize) {
    let current = tier
        .model_id
        .as_deref()
        .and_then(|id| models.iter().position(|model| model.id == id))
        .map(|index| index as isize)
        .unwrap_or(if delta > 0 { -1 } else { 0 });
    let index = (current + delta).rem_euclid(models.len() as isize) as usize;
    tier.model_id = Some(models[index].id.clone());
}

fn next_thinking(level: ThinkingLevel) -> ThinkingLevel {
    match level {
        ThinkingLevel::Off => ThinkingLevel::Minimal,
        ThinkingLevel::Minimal => ThinkingLevel::Low,
        ThinkingLevel::Low => ThinkingLevel::Medium,
        ThinkingLevel::Medium => ThinkingLevel::High,
        ThinkingLevel::High => ThinkingLevel::Xhigh,
        ThinkingLevel::Xhigh => ThinkingLevel::Off,
    }
}

fn centered(area: ratatui::layout::Rect, width: u16, height: u16) -> ratatui::layout::Rect {
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
    fn shortcut_matching_is_case_insensitive() {
        assert!(char_matches('q', 'q'));
        assert!(char_matches('Q', 'q'));
        assert!(char_matches('T', 't'));
        assert!(!char_matches('x', 'q'));
    }

    #[test]
    fn usable_key_accepts_press_and_repeat_only() {
        let press = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
        let repeat = KeyEvent {
            kind: KeyEventKind::Repeat,
            ..press
        };
        let release = KeyEvent {
            kind: KeyEventKind::Release,
            ..press
        };

        assert!(usable_key(press));
        assert!(usable_key(repeat));
        assert!(!usable_key(release));
    }
}
