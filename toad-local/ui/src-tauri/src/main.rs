// TOAD desktop entry. Hides the console on Windows release builds; spawns
// the Node-based orchestrator API as a child process when the app starts;
// kills it cleanly on app close. The UI itself is the existing Vite-built
// React app — Tauri loads `../dist/index.html` (or the dev server URL when
// running `tauri dev`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WindowEvent};

/// Holds the spawned orchestrator child so we can kill it on window close.
/// `Mutex<Option<Child>>` rather than `Mutex<Child>` so we can `take()` it
/// when shutting down without leaving a borrowed reference behind.
struct ApiServer(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ApiServer(Mutex::new(None)))
        .setup(|app| {
            // Resolve the project root relative to where the bundled app
            // lives. In dev (`tauri dev`) the cwd is `toad-local/ui/`, so
            // the script lives at `../scripts/dev-api-server.mjs`. In
            // production we expect the user to launch from the project
            // they're working on — the orchestrator picks the DB up from
            // <projectCwd>/.toad/toad.db automatically, so cwd matters.
            let project_dir = std::env::current_dir()
                .ok()
                .and_then(|p| p.parent().map(|q| q.to_path_buf()))
                .unwrap_or_else(|| std::path::PathBuf::from("."));

            let script = project_dir.join("scripts").join("dev-api-server.mjs");
            if !script.exists() {
                eprintln!(
                    "[toad-desktop] orchestrator script not found at {} — start the API \
                     manually with `npm run api:dev` from toad-local/.",
                    script.display()
                );
                return Ok(());
            }

            // `node` must be on the user's PATH. We could ship Node as a
            // sidecar binary later (see Tauri's externalBin), but the
            // toad-local stack already requires Node 20+ for development —
            // assuming it during desktop runtime is consistent.
            let mut cmd = Command::new("node");
            cmd.arg(&script).current_dir(&project_dir);

            // Don't set TOAD_API_PORT here — let the orchestrator default
            // to 3001. The UI's VITE_TOAD_API_BASE_URL points there too.

            match cmd.spawn() {
                Ok(child) => {
                    if let Some(state) = app.try_state::<ApiServer>() {
                        if let Ok(mut slot) = state.0.lock() {
                            *slot = Some(child);
                        }
                    }
                    println!("[toad-desktop] orchestrator API spawned");
                }
                Err(err) => {
                    eprintln!(
                        "[toad-desktop] failed to spawn orchestrator: {} — start it \
                         manually with `npm run api:dev`.",
                        err
                    );
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<ApiServer>() {
                    kill_api(&state);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<ApiServer>() {
                    kill_api(&state);
                }
            }
        });
}

fn kill_api(state: &tauri::State<ApiServer>) {
    if let Ok(mut slot) = state.0.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
