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

    /// Git 仓库根目录；必须直接指向仓库根。也可通过 RACCOON_PROJECT_ROOT 环境变量设置。
    #[arg(long, env = "RACCOON_PROJECT_ROOT")]
    pub project_root: Option<PathBuf>,

    /// 开发模式下前端 URL（例：http://localhost:5173），启用后服务端不再提供嵌入的前端资源，
    /// 而是将前端请求代理到此地址，获得 HMR 热更新体验。
    #[arg(long)]
    pub dev_frontend: Option<String>,

    /// 开发模式下由后端管理 Vite dev server。
    #[arg(long)]
    pub dev_managed_vite: bool,

    /// Vite 前端目录；仅与 --dev-managed-vite 一起使用。
    #[arg(long)]
    pub dev_frontend_dir: Option<PathBuf>,
}
