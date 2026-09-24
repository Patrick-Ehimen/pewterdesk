// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The bin target is named "PewterDesk" (see Cargo.toml), which trips the
// crate-name lint.
#![allow(non_snake_case)]

fn main() {
    pewterdesk_lib::run()
}
