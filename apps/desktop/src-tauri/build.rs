fn main() {
    // generate_context! embeds the icons at compile time, but tauri-build
    // doesn't tell cargo to watch them - without this, `make icons` has no
    // effect until something else forces a rebuild.
    println!("cargo:rerun-if-changed=icons");
    // The cloud project (`src/cloud.rs`) is fixed at build time.
    println!("cargo:rerun-if-env-changed=PEWTERDESK_CLOUD_URL");
    println!("cargo:rerun-if-env-changed=PEWTERDESK_CLOUD_KEY");
    tauri_build::build()
}
