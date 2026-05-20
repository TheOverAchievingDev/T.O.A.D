// Tauri's build script. Regenerates Rust constants from tauri.conf.json and
// links the platform-specific resources Cargo needs at build time.
fn main() {
    tauri_build::build()
}
