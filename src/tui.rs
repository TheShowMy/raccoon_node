use std::{
    io::{self, stdout},
    sync::mpsc::Receiver,
    time::Duration,
};

use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
    Terminal,
};

use crate::{
    config::{AppConfig, Theme},
    models::{ModelSettings, ModelTierSetting, PiModel, ThinkingLevel},
};

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
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => return Ok(true),
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => return Ok(false),
            _ => {}
        }
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

pub fn edit_config(initial: AppConfig, title: &str) -> io::Result<Option<AppConfig>> {
    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut config = initial;
    let mut row = 0_u8;
    let mut port = config.port.to_string();
    let mut confirm_external = false;

    loop {
        terminal.draw(|frame| {
            let area = centered(frame.area(), 64, 16);
            let rows = vec![
                setting_line(
                    row == 0,
                    "主题",
                    match config.theme {
                        Theme::Light => "亮色",
                        Theme::Dark => "暗色",
                    },
                ),
                setting_line(row == 1, "监听地址", &config.host),
                setting_line(row == 2, "端口", &port),
                Line::raw(""),
                Line::styled(
                    if confirm_external {
                        "外网模式无鉴权，任何可访问该端口的人都能调用 Agent API。按 y 确认。"
                    } else {
                        "↑↓ 选择  ←→ 修改  Enter 保存  Esc 取消"
                    },
                    Style::default().fg(if confirm_external {
                        Color::Yellow
                    } else {
                        Color::Gray
                    }),
                ),
            ];
            frame.render_widget(
                Paragraph::new(rows)
                    .block(Block::default().title(title).borders(Borders::ALL))
                    .wrap(Wrap { trim: true }),
                area,
            );
        })?;

        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        if confirm_external {
            match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => return Ok(Some(config)),
                KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => confirm_external = false,
                _ => {}
            }
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Up => row = row.saturating_sub(1),
            KeyCode::Down => row = (row + 1).min(2),
            KeyCode::Left | KeyCode::Right if row == 0 => {
                config.theme = match config.theme {
                    Theme::Light => Theme::Dark,
                    Theme::Dark => Theme::Light,
                };
            }
            KeyCode::Left | KeyCode::Right if row == 1 => {
                config.host = if config.host == "127.0.0.1" {
                    "0.0.0.0".to_owned()
                } else {
                    "127.0.0.1".to_owned()
                };
            }
            KeyCode::Backspace if row == 2 => {
                port.pop();
            }
            KeyCode::Char(value) if row == 2 && value.is_ascii_digit() && port.len() < 5 => {
                port.push(value);
            }
            KeyCode::Enter => {
                let Ok(parsed) = port.parse::<u16>() else {
                    continue;
                };
                if parsed == 0 {
                    continue;
                }
                config.port = parsed;
                if config.host == "0.0.0.0" {
                    confirm_external = true;
                } else {
                    return Ok(Some(config));
                }
            }
            _ => {}
        }
    }
}

pub fn run_dashboard(url: &str, logs: &Receiver<String>) -> io::Result<DashboardAction> {
    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
    let mut lines = Vec::new();

    loop {
        while let Ok(line) = logs.try_recv() {
            lines.push(line);
            if lines.len() > 500 {
                lines.drain(..100);
            }
        }
        terminal.draw(|frame| {
            let areas = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(5), Constraint::Length(5)])
                .split(frame.area());
            let height = areas[0].height.saturating_sub(2) as usize;
            let visible = lines
                .iter()
                .rev()
                .take(height)
                .rev()
                .map(|line| ListItem::new(line.as_str()))
                .collect::<Vec<_>>();
            frame.render_widget(
                List::new(visible).block(Block::default().title("运行日志").borders(Borders::ALL)),
                areas[0],
            );
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
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Char('q') => return Ok(DashboardAction::Quit),
            KeyCode::Char('r') => return Ok(DashboardAction::Restart),
            KeyCode::Char('s') => return Ok(DashboardAction::Settings),
            KeyCode::Char('o') => return Ok(DashboardAction::Open),
            _ => {}
        }
    }
}

pub fn edit_models(
    models: &[PiModel],
    initial: ModelSettings,
) -> io::Result<Option<ModelSettings>> {
    if models.is_empty() {
        return Ok(None);
    }
    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
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
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Enter => return Ok(Some(settings)),
            KeyCode::Up => row = row.saturating_sub(1),
            KeyCode::Down => row = (row + 1).min(2),
            KeyCode::Left => cycle_model(tier_mut(&mut settings, row), models, -1),
            KeyCode::Right => cycle_model(tier_mut(&mut settings, row), models, 1),
            KeyCode::Char('t') => {
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
