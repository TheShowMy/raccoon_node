/// Generate TypeScript types from Rust models using ts-rs.
/// Run with: `RACCOON_GEN_TS=1 cargo build`
fn main() {
    // Only generate when explicitly requested.
    if std::env::var("RACCOON_GEN_TS").is_err() {
        return;
    }

    let out_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"),
    )
    .join("frontend")
    .join("src")
    .join("types");

    std::fs::create_dir_all(&out_dir).expect("failed to create frontend/src/types");

    // ts-rs generates types for types annotated with #[derive(TS)].
    // The actual generation happens in a binary or test configured in Cargo.toml.
    // For now we just create the directory; annotate models with #[derive(TS)]
    // and then run `RACCOON_GEN_TS=1 cargo test --test gen_types` to emit.
    println!("cargo:rerun-if-env-changed=RACCOON_GEN_TS");
    println!("cargo:rerun-if-changed=src/models.rs");
}
