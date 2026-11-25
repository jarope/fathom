// Prevents an extra console window on Windows in release. Harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Run by ssh as its SSH_ASKPASS helper: pass the question to the app.
    if fathom_lib::askpass_client() {
        return;
    }
    fathom_lib::run()
}
