use std::{
    collections::VecDeque,
    io::{self, stdout},
    sync::mpsc,
    time::Duration,
};

use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers, MouseButton, MouseEventKind,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

const MAX_LOG_LINES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardAction {
    Quit,
    Restart,
    Open,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct LauncherButtons {
    open: Rect,
    copy_key: Option<Rect>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LauncherEvent {
    Action(DashboardAction),
    CopyTerminalAccessKey,
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
        match event::read()? {
            Event::Key(key) if usable_key(key) => match key.code {
                KeyCode::Char(value) if char_matches(value, 'y') => return Ok(true),
                KeyCode::Char(value) if char_matches(value, 'n') => return Ok(false),
                KeyCode::Esc => return Ok(false),
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    return Ok(false);
                }
                _ => {}
            },
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

    pub fn run_launcher(
        &mut self,
        url: &str,
        terminal_access_key: Option<&str>,
        backend_logs: &mpsc::Receiver<String>,
        vite_logs: Option<&mpsc::Receiver<String>>,
        mut restart_requested: impl FnMut() -> bool,
    ) -> io::Result<DashboardAction> {
        let mut backend_panel = LogPanel::new();
        let mut vite_panel = vite_logs.map(|_| LogPanel::new());
        let mut copy_feedback: Option<String> = None;

        loop {
            if restart_requested() {
                return Ok(DashboardAction::Restart);
            }

            let mut buttons = LauncherButtons::default();
            self.terminal.draw(|frame| {
                backend_panel.drain(backend_logs);
                if let (Some(panel), Some(rx)) = (vite_panel.as_mut(), vite_logs) {
                    panel.drain(rx);
                }

                let main = frame.area();
                let card_area =
                    top_centered_card(main, 52, if terminal_access_key.is_some() { 9 } else { 7 });
                buttons = button_rects(card_area, terminal_access_key.is_some());
                let mut lines = vec![
                    Line::styled(
                        "Raccoon Node 正在运行",
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Line::raw(url),
                ];
                if let Some(key) = terminal_access_key {
                    lines.push(Line::styled(
                        format!("Web 终端密钥：{key}"),
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ));
                    lines.push(Line::styled(
                        "输入后 12 小时内可启用终端",
                        Style::default().fg(Color::Gray),
                    ));
                }
                lines.push(Line::raw(""));
                lines.push(Line::styled(
                    "Enter/o 打开网页    q/Ctrl+C 退出",
                    Style::default().fg(Color::Gray),
                ));

                frame.render_widget(
                    Paragraph::new(lines)
                        .alignment(Alignment::Center)
                        .block(Block::default().borders(Borders::ALL)),
                    card_area,
                );
                if let Some(feedback) = copy_feedback.as_deref() {
                    let feedback_area = Rect::new(
                        card_area.x.saturating_add(2),
                        card_area.y.saturating_add(4),
                        card_area.width.saturating_sub(4).max(1),
                        1,
                    );
                    frame.render_widget(
                        Paragraph::new(feedback)
                            .alignment(Alignment::Center)
                            .style(Style::default().fg(Color::Gray)),
                        feedback_area,
                    );
                }
                frame.render_widget(
                    Paragraph::new(Line::from(vec![Span::styled(
                        "[ 打开网页 ]",
                        Style::default()
                            .fg(Color::Black)
                            .bg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    )]))
                    .alignment(Alignment::Center)
                    .style(Style::default().bg(Color::Yellow)),
                    buttons.open,
                );
                if let Some(copy_key_button) = buttons.copy_key {
                    frame.render_widget(
                        Paragraph::new(Line::from(vec![Span::styled(
                            "[ 复制密钥 ]",
                            Style::default()
                                .fg(Color::Black)
                                .bg(Color::Yellow)
                                .add_modifier(Modifier::BOLD),
                        )]))
                        .alignment(Alignment::Center)
                        .style(Style::default().bg(Color::Yellow)),
                        copy_key_button,
                    );
                }

                let log_area = remaining_log_area(main, card_area);
                if log_area.height > 0 {
                    let panels = split_log_area(log_area, vite_panel.is_some());
                    if let Some(panel) = vite_panel.as_ref() {
                        frame.render_widget(backend_panel.render(panels[0], "后端日志"), panels[0]);
                        frame.render_widget(panel.render(panels[1], "Vite 日志"), panels[1]);
                    } else {
                        frame.render_widget(backend_panel.render(panels[0], "日志"), panels[0]);
                    }
                }
            })?;

            if !event::poll(Duration::from_millis(100))? {
                continue;
            }
            match action_for_event(&event::read()?, buttons) {
                Some(LauncherEvent::Action(action)) => return Ok(action),
                Some(LauncherEvent::CopyTerminalAccessKey) => {
                    if let Some(key) = terminal_access_key {
                        copy_feedback = Some(match copy_to_clipboard(key) {
                            Ok(()) => "密钥已复制到剪贴板".to_owned(),
                            Err(error) => format!("密钥复制失败：{error}"),
                        });
                    }
                }
                None => {}
            }
        }
    }
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        execute!(stdout(), EnterAlternateScreen, EnableMouseCapture)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(stdout(), DisableMouseCapture, LeaveAlternateScreen);
    }
}

struct LogPanel {
    lines: VecDeque<String>,
}

impl LogPanel {
    fn new() -> Self {
        Self {
            lines: VecDeque::new(),
        }
    }

    fn drain(&mut self, receiver: &mpsc::Receiver<String>) {
        while let Ok(line) = receiver.try_recv() {
            if self.lines.len() >= MAX_LOG_LINES {
                self.lines.pop_front();
            }
            self.lines.push_back(line);
        }
    }

    fn render<'a>(&'a self, area: Rect, title: &'a str) -> Paragraph<'a> {
        let inner_height = area.height.saturating_sub(2).max(1) as usize;
        let start = self.lines.len().saturating_sub(inner_height);
        let visible: Vec<Line> = self
            .lines
            .range(start..)
            .map(|line| Line::raw(line.as_str()))
            .collect();
        Paragraph::new(visible)
            .block(Block::default().title(title).borders(Borders::ALL))
            .wrap(Wrap { trim: true })
    }
}

fn top_centered_card(area: Rect, max_width: u16, height: u16) -> Rect {
    let width = area.width.min(max_width);
    let height = area.height.min(height);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y,
        width,
        height,
    )
}

fn button_rects(card: Rect, has_terminal_access_key: bool) -> LauncherButtons {
    let full = Rect::new(
        card.x.saturating_add(2),
        card.y.saturating_add(card.height.saturating_sub(2)),
        card.width.saturating_sub(4).max(1),
        1,
    );
    if !has_terminal_access_key || full.width < 4 {
        return LauncherButtons {
            open: full,
            copy_key: None,
        };
    }
    let gap = 1;
    let open_width = full.width.saturating_sub(gap) / 2;
    let copy_width = full.width.saturating_sub(open_width).saturating_sub(gap);
    LauncherButtons {
        open: Rect::new(full.x, full.y, open_width.max(1), full.height),
        copy_key: Some(Rect::new(
            full.x.saturating_add(open_width).saturating_add(gap),
            full.y,
            copy_width.max(1),
            full.height,
        )),
    }
}

fn remaining_log_area(main: Rect, card: Rect) -> Rect {
    let y = card.bottom();
    let height = main.height.saturating_sub(y);
    Rect::new(
        main.x.saturating_add(1),
        y,
        main.width.saturating_sub(2),
        height,
    )
}

fn split_log_area(area: Rect, split: bool) -> Vec<Rect> {
    if !split || area.width < 4 {
        return vec![area];
    }
    let half = area.width / 2;
    vec![
        Rect::new(area.x, area.y, half.max(1), area.height),
        Rect::new(
            area.x + half,
            area.y,
            area.width.saturating_sub(half),
            area.height,
        ),
    ]
}

fn action_for_event(event: &Event, buttons: LauncherButtons) -> Option<LauncherEvent> {
    match event {
        Event::Mouse(mouse)
            if mouse.kind == MouseEventKind::Up(MouseButton::Left)
                && point_in_rect(mouse.column, mouse.row, buttons.open) =>
        {
            Some(LauncherEvent::Action(DashboardAction::Open))
        }
        Event::Mouse(mouse)
            if mouse.kind == MouseEventKind::Up(MouseButton::Left)
                && buttons
                    .copy_key
                    .is_some_and(|button| point_in_rect(mouse.column, mouse.row, button)) =>
        {
            Some(LauncherEvent::CopyTerminalAccessKey)
        }
        Event::Key(key) if usable_key(*key) => match key.code {
            KeyCode::Enter => Some(LauncherEvent::Action(DashboardAction::Open)),
            KeyCode::Char(value) if char_matches(value, 'o') => {
                Some(LauncherEvent::Action(DashboardAction::Open))
            }
            KeyCode::Char(value) if char_matches(value, 'q') => {
                Some(LauncherEvent::Action(DashboardAction::Quit))
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                Some(LauncherEvent::Action(DashboardAction::Quit))
            }
            _ => None,
        },
        _ => None,
    }
}

fn copy_to_clipboard(value: &str) -> io::Result<()> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| io::Error::other(error.to_string()))?;
    clipboard
        .set_text(value.to_owned())
        .map_err(|error| io::Error::other(error.to_string()))
}

fn point_in_rect(x: u16, y: u16, area: Rect) -> bool {
    x >= area.x
        && x < area.x.saturating_add(area.width)
        && y >= area.y
        && y < area.y.saturating_add(area.height)
}

fn usable_key(key: KeyEvent) -> bool {
    matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat)
}

fn char_matches(value: char, expected: char) -> bool {
    value.eq_ignore_ascii_case(&expected)
}

fn centered(area: Rect, max_width: u16, height: u16) -> Rect {
    let width = area.width.min(max_width);
    let height = area.height.min(height);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEventState, MouseEvent};
    use ratatui::{buffer::Buffer, widgets::Widget};

    fn mouse(column: u16, row: u16) -> Event {
        Event::Mouse(MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        })
    }

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })
    }

    #[test]
    fn button_click_opens_browser() {
        let buttons = LauncherButtons {
            open: Rect::new(10, 5, 20, 3),
            copy_key: None,
        };
        assert_eq!(
            action_for_event(&mouse(10, 5), buttons),
            Some(LauncherEvent::Action(DashboardAction::Open))
        );
        assert_eq!(
            action_for_event(&mouse(29, 7), buttons),
            Some(LauncherEvent::Action(DashboardAction::Open))
        );
    }

    #[test]
    fn clicks_outside_button_are_ignored() {
        let buttons = LauncherButtons {
            open: Rect::new(10, 5, 20, 3),
            copy_key: None,
        };
        assert_eq!(action_for_event(&mouse(9, 5), buttons), None);
        assert_eq!(action_for_event(&mouse(30, 7), buttons), None);
    }

    #[test]
    fn keyboard_fallbacks_are_hidden_but_available() {
        let buttons = LauncherButtons::default();
        assert_eq!(
            action_for_event(&key(KeyCode::Enter), buttons),
            Some(LauncherEvent::Action(DashboardAction::Open))
        );
        assert_eq!(
            action_for_event(&key(KeyCode::Char('o')), buttons),
            Some(LauncherEvent::Action(DashboardAction::Open))
        );
        assert_eq!(
            action_for_event(&key(KeyCode::Char('q')), buttons),
            Some(LauncherEvent::Action(DashboardAction::Quit))
        );
        assert_eq!(action_for_event(&key(KeyCode::Char('s')), buttons), None);
        assert_eq!(action_for_event(&key(KeyCode::Char('r')), buttons), None);
    }

    #[test]
    fn copy_key_button_click_copies_terminal_key() {
        let buttons = LauncherButtons {
            open: Rect::new(10, 5, 10, 1),
            copy_key: Some(Rect::new(21, 5, 10, 1)),
        };

        assert_eq!(
            action_for_event(&mouse(25, 5), buttons),
            Some(LauncherEvent::CopyTerminalAccessKey)
        );
    }

    #[test]
    fn open_button_does_not_cover_terminal_access_key_line() {
        let card = top_centered_card(Rect::new(0, 0, 80, 24), 52, 9);
        let buttons = button_rects(card, true);
        let terminal_access_key_line_y = card.y + 3;
        let shortcut_hint_line_y = card.y + 6;

        assert_ne!(buttons.open.y, terminal_access_key_line_y);
        assert_ne!(buttons.open.y, shortcut_hint_line_y);
        assert_ne!(
            buttons.copy_key.expect("copy key button").y,
            terminal_access_key_line_y
        );
        assert_ne!(
            buttons.copy_key.expect("copy key button").y,
            shortcut_hint_line_y
        );
    }

    #[test]
    fn open_button_does_not_cover_shortcut_hint_without_terminal_key() {
        let card = top_centered_card(Rect::new(0, 0, 80, 24), 52, 7);
        let buttons = button_rects(card, false);
        let shortcut_hint_line_y = card.y + 4;

        assert_ne!(buttons.open.y, shortcut_hint_line_y);
        assert!(buttons.copy_key.is_none());
    }

    #[test]
    fn log_panel_drain_pulls_messages() {
        let (tx, rx) = mpsc::channel();
        let mut panel = LogPanel::new();

        tx.send("line 1".to_owned()).unwrap();
        tx.send("line 2".to_owned()).unwrap();
        panel.drain(&rx);

        assert_eq!(panel.lines.len(), 2);
        assert_eq!(panel.lines[0], "line 1");
        assert_eq!(panel.lines[1], "line 2");
    }

    #[test]
    fn log_panel_drops_oldest_when_over_capacity() {
        let (tx, rx) = mpsc::channel();
        let mut panel = LogPanel::new();

        for index in 0..MAX_LOG_LINES + 5 {
            tx.send(format!("line {index}")).unwrap();
        }
        panel.drain(&rx);

        assert_eq!(panel.lines.len(), MAX_LOG_LINES);
        assert_eq!(panel.lines[0], "line 5");
        assert_eq!(
            panel.lines[MAX_LOG_LINES - 1],
            format!("line {}", MAX_LOG_LINES + 4)
        );
    }

    #[test]
    fn log_panel_render_shows_latest_lines() {
        let (tx, rx) = mpsc::channel();
        let mut panel = LogPanel::new();
        for index in 0..10 {
            tx.send(format!("line {index}")).unwrap();
        }
        panel.drain(&rx);

        let area = Rect::new(0, 0, 20, 5);
        let paragraph = panel.render(area, "日志");
        let mut buffer = Buffer::empty(area);
        paragraph.render(area, &mut buffer);
        let content = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(content.contains("line 9"));
    }

    #[test]
    fn remaining_log_area_respects_compact_layout() {
        let main = Rect::new(0, 0, 80, 24);
        let card = top_centered_card(main, 44, 6);
        let log_area = remaining_log_area(main, card);

        assert_eq!(log_area.x, 1);
        assert_eq!(log_area.y, card.bottom());
        assert_eq!(log_area.width, 78);
        assert_eq!(log_area.height, main.height - card.bottom());
    }

    #[test]
    fn split_log_area_divides_horizontally_when_requested() {
        let area = Rect::new(0, 0, 80, 10);
        let panels = split_log_area(area, true);

        assert_eq!(panels.len(), 2);
        assert_eq!(panels[0], Rect::new(0, 0, 40, 10));
        assert_eq!(panels[1], Rect::new(40, 0, 40, 10));
    }

    #[test]
    fn split_log_area_keeps_single_panel_when_not_requested() {
        let area = Rect::new(0, 0, 80, 10);
        let panels = split_log_area(area, false);

        assert_eq!(panels.len(), 1);
        assert_eq!(panels[0], area);
    }

    #[test]
    fn split_log_area_falls_back_to_single_panel_on_narrow_terminals() {
        let area = Rect::new(0, 0, 3, 10);
        let panels = split_log_area(area, true);

        assert_eq!(panels.len(), 1);
        assert_eq!(panels[0], area);
    }
}
