use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "raccoon", version, about = "Git 仓库的本地 Agent 节点画布")]
pub struct Cli {
    /// 本次运行监听的端口
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    pub port: Option<u16>,

    /// 本次运行监听地址，仅支持 127.0.0.1 或 0.0.0.0
    #[arg(long, value_parser = ["127.0.0.1", "0.0.0.0"])]
    pub host: Option<String>,

    /// 启动后不自动打开浏览器
    #[arg(long)]
    pub no_open: bool,

    /// 禁用终端界面，使用纯文本日志
    #[arg(long)]
    pub no_tui: bool,

    /// Git 仓库根目录；必须直接指向仓库根
    #[arg(long)]
    pub project_root: Option<PathBuf>,
}
