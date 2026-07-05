use std::path::{Path, PathBuf};

use pi_rpc_rs::session::{PiSessionConfig, PiVersionCheck, SessionPersistence};

#[derive(Debug, Clone)]
pub(crate) struct PiRpcTransportConfig {
    pub(crate) program: String,
    pub(crate) working_dir: PathBuf,
    pub(crate) session_dir: Option<PathBuf>,
    pub(crate) extension_path: Option<PathBuf>,
}

impl PiRpcTransportConfig {
    pub(crate) fn session(
        program: &str,
        session_dir: &Path,
        working_dir: &Path,
        extension_path: Option<&Path>,
    ) -> Self {
        Self {
            program: program.to_owned(),
            working_dir: working_dir.to_path_buf(),
            session_dir: Some(session_dir.to_path_buf()),
            extension_path: extension_path.map(Path::to_path_buf),
        }
    }

    pub(crate) fn no_session(program: &str, working_dir: &Path) -> Self {
        Self {
            program: program.to_owned(),
            working_dir: working_dir.to_path_buf(),
            session_dir: None,
            extension_path: None,
        }
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
        let mut args = vec!["--no-extensions".to_owned()];
        if let Some(extension_path) = &self.extension_path {
            args.push("--extension".to_owned());
            args.push(extension_path.to_string_lossy().into_owned());
        }
        args.push("--no-context-files".to_owned());
        args
    }
}
