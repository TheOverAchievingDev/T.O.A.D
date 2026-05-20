// TOAD desktop entry. Hides the console on Windows release builds; spawns
// the Node-based orchestrator API as a child process when the app starts;
// kills it cleanly on app close. The UI itself is the existing Vite-built
// React app — Tauri loads `../dist/index.html` (or the dev server URL when
// running `tauri dev`).
//
// Project switching: the active project path is persisted to
// `<appConfigDir>/active-project.txt` and passed to the Node child via
// the TOAD_PROJECT_CWD env var on spawn. The `switch_project` Tauri
// command lets the UI request a swap — we kill the current child, write
// the new path, and spawn a fresh child.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Holds the spawned orchestrator child + the resolved script + project
/// dir so we can respawn after a `switch_project` call. The script path
/// is stable for the app's lifetime; the project path changes at runtime.
struct ApiServer {
    child: Mutex<Option<Child>>,
    script: Mutex<Option<PathBuf>>,
}

impl ApiServer {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            script: Mutex::new(None),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ApiServer::new())
        .invoke_handler(tauri::generate_handler![switch_project, get_active_project])
        .setup(|app| {
            let (project_dir, script) = match find_orchestrator_script(app.handle()) {
                Some(pair) => pair,
                None => {
                    eprintln!(
                        "[symphony-desktop] orchestrator script (scripts/dev-api-server.mjs) \
                         not found in any ancestor of the current directory — start \
                         the API manually with `npm run api:dev` from toad-local/."
                    );
                    return Ok(());
                }
            };

            // Stash the resolved script path on app state so `switch_project`
            // can respawn without re-walking the filesystem.
            if let Some(state) = app.try_state::<ApiServer>() {
                if let Ok(mut slot) = state.script.lock() {
                    *slot = Some(script.clone());
                }
            }

            // Initial project = last user selection, if any.
            let initial_project = read_saved_project(app.handle()).unwrap_or_default();

            spawn_api(app.handle(), &project_dir, &script, &initial_project);

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

/// Walk up from the current directory looking for a sibling that contains
/// `scripts/dev-api-server.mjs`. In packaged builds, prefer the bundled
/// resource copy at `$RESOURCE/engine/scripts/dev-api-server.mjs`.
/// Returns the directory holding `scripts/` (i.e. the engine root) and the
/// resolved script path.
fn find_orchestrator_script(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    #[cfg(not(debug_assertions))]
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let engine_dir = resource_dir.join("engine");
            let resource_script = engine_dir.join("scripts").join("dev-api-server.mjs");
            if resource_script.exists() {
                return Some((engine_dir, resource_script));
            }
        }
    }

    let start = std::env::current_dir().ok()?;
    let mut current: Option<&Path> = Some(start.as_path());
    for _ in 0..6 {
        let dir = current?;
        let candidate = dir.join("scripts").join("dev-api-server.mjs");
        if candidate.exists() {
            return Some((dir.to_path_buf(), candidate));
        }
        current = dir.parent();
    }
    None
}

/// Path to the file storing the user's active project. Lives under the
/// per-user Tauri config directory so it survives app restarts.
fn active_project_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| {
        let _ = std::fs::create_dir_all(&dir);
        dir.join("active-project.txt")
    })
}

fn read_saved_project(app: &AppHandle) -> Option<String> {
    let path = active_project_file(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn write_saved_project(app: &AppHandle, project_path: &str) -> Result<(), String> {
    let path = active_project_file(app).ok_or("could not resolve app config dir")?;
    std::fs::write(&path, project_path).map_err(|e| format!("write failed: {}", e))
}

fn spawn_api(app: &AppHandle, project_dir: &Path, script: &Path, project_cwd: &str) {
    let mut cmd = Command::new("node");
    cmd.arg(script).current_dir(project_dir);
    // TOAD_PROJECT_CWD: empty string is meaningful — sidecar interprets
    // it as "no project loaded" and starts in degraded mode. The UI
    // shows the picker until the user opens a folder.
    cmd.env("TOAD_PROJECT_CWD", project_cwd);
    // In dev, Vite reads VITE_TOAD_API_TOKEN while the Node sidecar reads
    // TOAD_API_TOKEN. Bridge the value so `npm run tauri:dev` can be launched
    // from one shell without ending up with a UI token the sidecar rejects.
    if std::env::var_os("TOAD_API_TOKEN").is_none() {
        if let Some(token) = std::env::var_os("VITE_TOAD_API_TOKEN") {
            cmd.env("TOAD_API_TOKEN", token);
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.spawn() {
        Ok(child) => {
            if let Some(state) = app.try_state::<ApiServer>() {
                if let Ok(mut slot) = state.child.lock() {
                    *slot = Some(child);
                }
            }
            if project_cwd.is_empty() {
                println!("[symphony-desktop] orchestrator API spawned (no project loaded)");
            } else {
                println!(
                    "[symphony-desktop] orchestrator API spawned for {}",
                    project_cwd
                );
            }
        }
        Err(err) => {
            eprintln!(
                "[symphony-desktop] failed to spawn orchestrator: {} — start it \
                 manually with `npm run api:dev`.",
                err
            );
        }
    }
}

fn kill_api(state: &State<ApiServer>) {
    if let Ok(mut slot) = state.child.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// UI → Rust: the user picked a folder; restart the Node child with the
/// new project path baked into TOAD_PROJECT_CWD. Persists the choice so
/// the next launch starts in the same project.
#[tauri::command]
fn switch_project(app: AppHandle, project_path: String) -> Result<String, String> {
    let trimmed = project_path.trim().to_string();
    write_saved_project(&app, &trimmed)?;

    // Snapshot the script path before killing the child (avoids holding the
    // ApiServer mutex across the spawn).
    let script = {
        let state = app.try_state::<ApiServer>().ok_or("no app state")?;
        let guard = state.script.lock().map_err(|_| "script lock poisoned")?;
        guard.clone()
    };
    let script = script.ok_or("orchestrator script not resolved at startup")?;

    if let Some(state) = app.try_state::<ApiServer>() {
        kill_api(&state);
    }

    let project_dir = script
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    spawn_api(&app, &project_dir, &script, &trimmed);

    Ok(trimmed)
}

/// UI → Rust: read the persisted active-project path so the UI can sync
/// its registry on startup.
#[tauri::command]
fn get_active_project(app: AppHandle) -> Option<String> {
    read_saved_project(&app)
}
