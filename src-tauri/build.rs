fn main() {
    // Windows executable resources must be regenerated after changing the icon.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
