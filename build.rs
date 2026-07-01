fn main() {
    println!("cargo:rerun-if-env-changed=RACCOON_GEN_TS");

    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"),
    );
    let frontend = root.join("frontend");

    if std::env::var_os("RACCOON_GEN_TS").is_some() {
        std::fs::create_dir_all(frontend.join("src/types"))
            .expect("failed to create frontend/src/types");
        println!("cargo:rerun-if-changed=src/models.rs");
    }
}
