fn main() {
    // generate_context! embeds the icons at compile time, but tauri-build
    // doesn't tell cargo to watch them — without this, `make icons` has no
    // effect until something else forces a rebuild.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
