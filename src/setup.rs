use std::{
    fs, io,
    path::Path,
    process::{Command, Stdio},
};

const PI_PACKAGE: &str = "@earendil-works/pi-coding-agent";

pub fn pi_available() -> bool {
    pi_programs()
        .iter()
        .any(|program| command_status(program, &["--version"]))
}

pub fn install_pi() -> io::Result<()> {
    let args = ["install", "-g", "--ignore-scripts", PI_PACKAGE];
    let success = if cfg!(windows) {
        Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "npm"])
            .args(args)
            .stdin(Stdio::null())
            .status()?
            .success()
    } else {
        Command::new("npm")
            .args(args)
            .stdin(Stdio::null())
            .status()?
            .success()
    };
    if !success {
        return Err(io::Error::other("npm 安装 Pi Agent 失败"));
    }
    if !pi_available() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Pi 已安装，但当前终端的 PATH 尚未刷新",
        ));
    }
    Ok(())
}

pub fn ensure_data_layout(data_root: &Path) -> io::Result<()> {
    fs::create_dir_all(data_root)?;
    for directory in ["sessions", "worktrees", "attachments"] {
        let directory = data_root.join(directory);
        crate::utils::ensure_child_path(data_root, &directory)
            .map_err(|error| io::Error::other(error.to_string()))?;
        fs::create_dir_all(directory)?;
    }
    Ok(())
}

pub fn ensure_gitignore(project_root: &Path) -> io::Result<()> {
    let path = project_root.join(".gitignore");
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            ".gitignore 不能是符号链接",
        ));
    }
    let mut contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    if contents
        .lines()
        .any(|line| line.trim() == ".raccoon-node/" || line.trim() == "/.raccoon-node/")
    {
        return Ok(());
    }
    let newline = if contents.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    if !contents.is_empty() && !contents.ends_with('\n') && !contents.ends_with('\r') {
        contents.push_str(newline);
    }
    contents.push_str(".raccoon-node/");
    contents.push_str(newline);
    fs::write(path, contents)
}

fn command_status(program: &str, args: &[&str]) -> bool {
    if cfg!(windows) && program.ends_with(".cmd") {
        return Command::new("cmd.exe")
            .args(["/D", "/S", "/C", program])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
    }
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn pi_programs() -> &'static [&'static str] {
    if cfg!(windows) {
        &["pi.cmd", "pi.exe", "pi"]
    } else {
        &["pi"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_append_is_idempotent_and_keeps_crlf() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(".gitignore"), "target/\r\n").unwrap();
        ensure_gitignore(temp.path()).unwrap();
        ensure_gitignore(temp.path()).unwrap();
        assert_eq!(
            fs::read_to_string(temp.path().join(".gitignore")).unwrap(),
            "target/\r\n.raccoon-node/\r\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_gitignore_and_data_directories() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("ignore"),
            project.path().join(".gitignore"),
        )
        .unwrap();
        assert!(ensure_gitignore(project.path()).is_err());

        let data_root = project.path().join(".raccoon-node");
        fs::create_dir(&data_root).unwrap();
        std::os::unix::fs::symlink(outside.path(), data_root.join("sessions")).unwrap();
        assert!(ensure_data_layout(&data_root).is_err());
    }
}
