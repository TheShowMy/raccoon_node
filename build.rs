fn main() {
    println!("cargo:rerun-if-env-changed=RACCOON_GEN_TS");
    println!("cargo:rerun-if-env-changed=RACCOON_SKIP_FRONTEND_BUILD");
    println!("cargo:rerun-if-changed=frontend/index.html");
    println!("cargo:rerun-if-changed=frontend/package.json");
    println!("cargo:rerun-if-changed=frontend/package-lock.json");
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/vite.config.ts");

    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"),
    );
    let frontend = root.join("frontend");

    if std::env::var_os("RACCOON_GEN_TS").is_some() {
        std::fs::create_dir_all(frontend.join("src/types"))
            .expect("failed to create frontend/src/types");
        println!("cargo:rerun-if-changed=src/models/mod.rs");
    }

    // Published crates carry prebuilt frontend/dist and do not include frontend sources.
    if std::env::var_os("RACCOON_SKIP_FRONTEND_BUILD").is_none()
        && frontend.join("package.json").is_file()
    {
        let status = if let (Some(node), Some(npm_cli)) = (
            std::env::var_os("npm_node_execpath"),
            std::env::var_os("npm_execpath"),
        ) {
            std::process::Command::new(node)
                .arg(npm_cli)
                .args(["run", "build"])
                .current_dir(&frontend)
                .status()
        } else if cfg!(windows) {
            std::process::Command::new("cmd")
                .args(["/C", "npm", "run", "build"])
                .current_dir(&frontend)
                .status()
        } else {
            std::process::Command::new("npm")
                .args(["run", "build"])
                .current_dir(&frontend)
                .status()
        }
        .expect("failed to start frontend build; install Node.js 22+ and npm");

        assert!(status.success(), "frontend build failed");
    }

    assert!(
        frontend.join("dist/index.html").is_file(),
        "frontend/dist is missing; run `npm --prefix frontend run build`"
    );
}
