use std::{
    io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub const THEME_PACKS: &[&str] = &[
    "neutral",
    "stone",
    "matcha",
    "y2k",
    "chocolate",
    "gothic",
    "butter",
];

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    #[default]
    Dark,
}

impl ThemeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommitMode {
    Local,
    #[default]
    PullRequest,
}

impl CommitMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::PullRequest => "pull_request",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct AppConfig {
    pub theme_pack: String,
    pub theme_mode: ThemeMode,
    pub host: String,
    pub port: u16,
    pub commit_mode: CommitMode,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme_pack: "neutral".to_owned(),
            theme_mode: ThemeMode::Dark,
            host: "127.0.0.1".to_owned(),
            port: 3001,
            commit_mode: CommitMode::PullRequest,
        }
    }
}

impl AppConfig {
    pub fn load(path: &Path) -> io::Result<Option<Self>> {
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let config: Self = toml::from_str(&contents)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        config.validate()?;
        Ok(Some(config))
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        self.validate()?;
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "配置路径没有父目录"))?;
        std::fs::create_dir_all(parent)?;
        let temporary = temporary_path(path);
        let contents = toml::to_string_pretty(self).map_err(io::Error::other)?;
        std::fs::write(&temporary, contents)?;
        if let Err(error) = std::fs::rename(&temporary, path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(())
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.port == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "端口必须大于 0"));
        }
        if !matches!(self.host.as_str(), "127.0.0.1" | "0.0.0.0") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "host 仅支持 127.0.0.1 或 0.0.0.0",
            ));
        }
        if !THEME_PACKS.contains(&self.theme_pack.as_str()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "主题包不在支持列表内",
            ));
        }
        Ok(())
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        let expected = AppConfig::default();
        assert_eq!(expected.theme_pack, "neutral");
        assert_eq!(expected.theme_mode, ThemeMode::Dark);
        assert_eq!(expected.commit_mode, CommitMode::PullRequest);
        expected.save(&path).unwrap();
        assert_eq!(AppConfig::load(&path).unwrap(), Some(expected));
    }

    #[test]
    fn local_commit_mode_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        let expected = AppConfig {
            commit_mode: CommitMode::Local,
            ..AppConfig::default()
        };
        expected.save(&path).unwrap();
        assert_eq!(AppConfig::load(&path).unwrap(), Some(expected));
    }

    #[test]
    fn rejects_invalid_config() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        std::fs::write(&path, "host = \"example.com\"\nport = 0\n").unwrap();
        assert_eq!(
            AppConfig::load(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
