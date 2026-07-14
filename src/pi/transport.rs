use std::path::{Path, PathBuf};

use pi_rpc_rs::session::{PiSessionConfig, PiVersionCheck, SessionPersistence};

#[derive(Debug, Clone)]
pub(crate) struct PiRpcTransportConfig {
    pub(crate) program: String,
    pub(crate) working_dir: PathBuf,
    pub(crate) session_dir: Option<PathBuf>,
    pub(crate) extension_paths: Vec<PathBuf>,
    pub(crate) tool_names: Option<String>,
}

impl PiRpcTransportConfig {
    pub(crate) fn session(
        program: &str,
        session_dir: &Path,
        working_dir: &Path,
        extension_paths: &[PathBuf],
    ) -> Self {
        Self {
            program: program.to_owned(),
            working_dir: working_dir.to_path_buf(),
            session_dir: Some(session_dir.to_path_buf()),
            extension_paths: extension_paths.to_vec(),
            tool_names: None,
        }
    }

    pub(crate) fn session_with_tools(
        program: &str,
        session_dir: &Path,
        working_dir: &Path,
        extension_paths: &[PathBuf],
        tool_names: &str,
    ) -> Self {
        let mut config = Self::session(program, session_dir, working_dir, extension_paths);
        config.tool_names = Some(tool_names.to_owned());
        config
    }

    pub(crate) fn no_session(program: &str, working_dir: &Path) -> Self {
        Self {
            program: program.to_owned(),
            working_dir: working_dir.to_path_buf(),
            session_dir: None,
            extension_paths: Vec::new(),
            tool_names: None,
        }
    }

    pub(crate) fn no_session_with_tools(
        program: &str,
        working_dir: &Path,
        extension_paths: &[PathBuf],
        tool_names: &str,
    ) -> Self {
        let mut config = Self::no_session(program, working_dir);
        config.extension_paths = extension_paths.to_vec();
        config.tool_names = Some(tool_names.to_owned());
        config
    }

    pub(crate) fn to_pi_session_config(&self) -> PiSessionConfig {
        PiSessionConfig {
            pi_binary: self.program.clone(),
            session_persistence: if self.session_dir.is_some() {
                SessionPersistence::Enabled
            } else {
                SessionPersistence::Disabled
            },
            session_dir: self.session_dir.clone(),
            working_dir: Some(self.working_dir.clone()),
            extra_args: self.extra_args(),
            version_check: PiVersionCheck::Warn,
            ..PiSessionConfig::default()
        }
    }

    pub(crate) fn extra_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if self.session_dir.is_none() {
            args.push("--no-session".to_owned());
        }
        args.push("--no-extensions".to_owned());
        for extension_path in &self.extension_paths {
            args.push("--extension".to_owned());
            args.push(extension_path.to_string_lossy().into_owned());
        }
        args.push("--no-context-files".to_owned());
        if let Some(tool_names) = &self.tool_names {
            args.push("--no-skills".to_owned());
            args.push("--no-prompt-templates".to_owned());
            args.push("--no-themes".to_owned());
            args.push("--tools".to_owned());
            args.push(tool_names.clone());
        }
        args
    }
}
