use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionKind {
    Managed,
    User,
}

impl SectionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::User => "user",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "managed" => Some(Self::Managed),
            "user" => Some(Self::User),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptSection {
    pub kind: SectionKind,
    pub name: String,
    pub content: String,
    start_range: (usize, usize),
    end_range: (usize, usize),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SectionError {
    #[error("section name 非法：{0}")]
    InvalidName(String),
    #[error("section marker 非法：{0}")]
    InvalidMarker(String),
    #[error("section 缺少结束 marker：{0}")]
    MissingEnd(String),
    #[error("section start/end 不匹配：start={start} end={end}")]
    MismatchedMarker { start: String, end: String },
    #[error("未找到 section：{0}")]
    NotFound(String),
}

pub fn format_section(
    kind: SectionKind,
    name: &str,
    content: &str,
) -> Result<String, SectionError> {
    validate_name(name)?;
    Ok(format!(
        "<!-- raccoon:{}:start {} -->\n{}\n<!-- raccoon:{}:end {} -->",
        kind.as_str(),
        name,
        content,
        kind.as_str(),
        name
    ))
}

pub fn parse_sections(markdown: &str) -> Result<Vec<PromptSection>, SectionError> {
    let mut sections = Vec::new();
    let mut cursor = 0;
    while let Some(start_offset) = markdown[cursor..].find("<!-- raccoon:") {
        let start_index = cursor + start_offset;
        let Some(start_marker_end_offset) = markdown[start_index..].find("-->") else {
            return Err(SectionError::InvalidMarker(
                markdown[start_index..].to_owned(),
            ));
        };
        let start_marker_end = start_index + start_marker_end_offset + "-->".len();
        let start_marker = &markdown[start_index..start_marker_end];
        let start = parse_marker(start_marker)?;
        if start.position != MarkerPosition::Start {
            cursor = start_marker_end;
            continue;
        }
        let end_search_start = start_marker_end;
        let expected_end = format!(
            "<!-- raccoon:{}:end {} -->",
            start.kind.as_str(),
            start.name
        );
        let Some(end_offset) = markdown[end_search_start..].find(&expected_end) else {
            return Err(mismatched_or_missing_end(
                &markdown[end_search_start..],
                start.kind,
                &start.name,
            ));
        };
        let end_index = end_search_start + end_offset;
        let end_marker_end = end_index + expected_end.len();
        sections.push(PromptSection {
            kind: start.kind,
            name: start.name,
            content: markdown[end_search_start..end_index]
                .trim_matches('\n')
                .to_owned(),
            start_range: (start_index, start_marker_end),
            end_range: (end_index, end_marker_end),
        });
        cursor = end_marker_end;
    }
    Ok(sections)
}

pub fn replace_section(
    markdown: &str,
    kind: SectionKind,
    name: &str,
    content: &str,
) -> Result<String, SectionError> {
    validate_name(name)?;
    let sections = parse_sections(markdown)?;
    let section = sections
        .iter()
        .find(|section| section.kind == kind && section.name == name)
        .ok_or_else(|| SectionError::NotFound(name.to_owned()))?;
    let mut updated = String::new();
    updated.push_str(&markdown[..section.start_range.1]);
    updated.push('\n');
    updated.push_str(content);
    updated.push('\n');
    updated.push_str(&markdown[section.end_range.0..]);
    Ok(updated)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerPosition {
    Start,
    End,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Marker {
    kind: SectionKind,
    position: MarkerPosition,
    name: String,
}

fn parse_marker(marker: &str) -> Result<Marker, SectionError> {
    let inner = marker
        .strip_prefix("<!--")
        .and_then(|value| value.strip_suffix("-->"))
        .map(str::trim)
        .ok_or_else(|| SectionError::InvalidMarker(marker.to_owned()))?;
    let Some(rest) = inner.strip_prefix("raccoon:") else {
        return Err(SectionError::InvalidMarker(marker.to_owned()));
    };
    let mut parts = rest.split_whitespace();
    let header = parts
        .next()
        .ok_or_else(|| SectionError::InvalidMarker(marker.to_owned()))?;
    let name = parts
        .next()
        .ok_or_else(|| SectionError::InvalidMarker(marker.to_owned()))?;
    if parts.next().is_some() {
        return Err(SectionError::InvalidMarker(marker.to_owned()));
    }
    validate_name(name)?;
    let mut header_parts = header.split(':');
    let kind = header_parts
        .next()
        .and_then(SectionKind::parse)
        .ok_or_else(|| SectionError::InvalidMarker(marker.to_owned()))?;
    let position = match header_parts.next() {
        Some("start") => MarkerPosition::Start,
        Some("end") => MarkerPosition::End,
        _ => return Err(SectionError::InvalidMarker(marker.to_owned())),
    };
    if header_parts.next().is_some() {
        return Err(SectionError::InvalidMarker(marker.to_owned()));
    }
    Ok(Marker {
        kind,
        position,
        name: name.to_owned(),
    })
}

fn mismatched_or_missing_end(
    markdown: &str,
    start_kind: SectionKind,
    start_name: &str,
) -> SectionError {
    let Some(next_offset) = markdown.find("<!-- raccoon:") else {
        return SectionError::MissingEnd(start_name.to_owned());
    };
    let next = &markdown[next_offset..];
    let Some(marker_end_offset) = next.find("-->") else {
        return SectionError::InvalidMarker(next.to_owned());
    };
    let marker = &next[..marker_end_offset + "-->".len()];
    match parse_marker(marker) {
        Ok(end) => SectionError::MismatchedMarker {
            start: marker_label(start_kind, start_name),
            end: marker_label(end.kind, &end.name),
        },
        Err(error) => error,
    }
}

fn validate_name(name: &str) -> Result<(), SectionError> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(SectionError::InvalidName(name.to_owned()));
    }
    Ok(())
}

fn marker_label(kind: SectionKind, name: &str) -> String {
    format!("{}:{name}", kind.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_managed_section() {
        let markdown = format_section(SectionKind::Managed, "requirement-context", "body").unwrap();
        let sections = parse_sections(&markdown).unwrap();

        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].kind, SectionKind::Managed);
        assert_eq!(sections[0].name, "requirement-context");
        assert_eq!(sections[0].content, "body");
    }

    #[test]
    fn replaces_section_content() {
        let markdown = format!(
            "prefix\n{}\nsuffix",
            format_section(SectionKind::User, "notes", "old").unwrap()
        );
        let updated = replace_section(&markdown, SectionKind::User, "notes", "new").unwrap();

        assert!(updated.contains("prefix"));
        assert!(updated.contains("new"));
        assert!(!updated.contains("old"));
    }

    #[test]
    fn rejects_invalid_name() {
        assert!(matches!(
            format_section(SectionKind::Managed, "Bad_Name", "body"),
            Err(SectionError::InvalidName(_))
        ));
    }

    #[test]
    fn rejects_missing_end() {
        let error =
            parse_sections("<!-- raccoon:managed:start requirement-context -->\nbody").unwrap_err();

        assert!(matches!(error, SectionError::MissingEnd(_)));
    }

    #[test]
    fn rejects_mismatched_marker() {
        let markdown = "<!-- raccoon:managed:start requirement-context -->\nbody\n<!-- raccoon:user:end notes -->";
        let error = parse_sections(markdown).unwrap_err();

        assert!(matches!(error, SectionError::MismatchedMarker { .. }));
    }

    #[test]
    fn nested_marker_is_plain_section_content() {
        let markdown = "<!-- raccoon:managed:start outer -->\n<!-- raccoon:user:start inner -->\nbody\n<!-- raccoon:managed:end outer -->";
        let sections = parse_sections(markdown).unwrap();

        assert_eq!(sections.len(), 1);
        assert!(sections[0].content.contains("raccoon:user:start inner"));
    }
}
