use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};

const APP_VERSION: &str = "1.0.0-rc3";
const FIRST_PORT: u16 = 4317;
const LAST_PORT: u16 = 4348;
const START_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_EARLY_START_FAILURES: usize = 3;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    id: String,
    name: String,
    installed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntime {
    status: String,
    version: String,
    port: Option<u16>,
    master_url: Option<String>,
    uptime_seconds: Option<u64>,
    started_by_app: bool,
    error: Option<String>,
    log_path: String,
    data_path: String,
    keep_master_on_close: bool,
    start_at_login: bool,
    tools: Vec<ToolStatus>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Preferences {
    keep_master_on_close: bool,
    start_at_login: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            keep_master_on_close: true,
            start_at_login: false,
        }
    }
}

struct Paths {
    app_root: PathBuf,
    node: PathBuf,
    data: PathBuf,
    log: PathBuf,
    config: PathBuf,
}

struct RuntimeState {
    child: Option<Child>,
    port: Option<u16>,
    status: String,
    started_by_app: bool,
    started_at: Option<Instant>,
    error: Option<String>,
    preferences: Preferences,
}

struct DesktopState {
    paths: Paths,
    runtime: Mutex<RuntimeState>,
}

impl DesktopState {
    fn new(paths: Paths) -> Self {
        let preferences = load_preferences(&paths.config);
        Self {
            paths,
            runtime: Mutex::new(RuntimeState {
                child: None,
                port: None,
                status: "Starting".to_owned(),
                started_by_app: false,
                started_at: None,
                error: None,
                preferences,
            }),
        }
    }
}

#[tauri::command]
fn desktop_runtime(state: State<'_, DesktopState>) -> DesktopRuntime {
    let mut runtime = state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    refresh_child_status(&mut runtime);
    runtime_view(&state.paths, &runtime)
}

#[tauri::command]
fn set_keep_master_on_close(keep: bool, state: State<'_, DesktopState>) -> Result<(), String> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "Desktop settings are unavailable.".to_owned())?;
    runtime.preferences.keep_master_on_close = keep;
    save_preferences(&state.paths.config, &runtime.preferences)
}

#[tauri::command]
fn set_start_at_login(
    enabled: bool,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| format!("Could not enable start at login: {error}"))?;
    } else {
        manager
            .disable()
            .map_err(|error| format!("Could not disable start at login: {error}"))?;
    }
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "Desktop settings are unavailable.".to_owned())?;
    runtime.preferences.start_at_login = enabled;
    save_preferences(&state.paths.config, &runtime.preferences)
}

#[tauri::command]
fn restart_master(state: State<'_, DesktopState>) -> Result<DesktopRuntime, String> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "Desktop Master state is unavailable.".to_owned())?;
    if runtime.status == "Running" && !runtime.started_by_app {
        return Err("The running Master belongs to another Turing Terminal process and cannot be restarted from this window.".to_owned());
    }
    stop_owned_child(&mut runtime);
    runtime.status = "Starting".to_owned();
    runtime.error = None;
    launch_or_connect(&state.paths, &mut runtime);
    if runtime.status == "Error" {
        return Err(runtime
            .error
            .clone()
            .unwrap_or_else(|| "Turing Terminal Master could not start.".to_owned()));
    }
    Ok(runtime_view(&state.paths, &runtime))
}

#[tauri::command]
fn open_log_folder(state: State<'_, DesktopState>) -> Result<(), String> {
    fs::create_dir_all(&state.paths.log)
        .map_err(|error| format!("Could not open the log folder: {error}"))?;
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer.exe");
        command.arg(&state.paths.log);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(&state.paths.log);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(&state.paths.log);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open {}: {error}", state.paths.log.display()))
}

#[tauri::command]
fn quit_desktop(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background".into()]),
        ))
        .invoke_handler(tauri::generate_handler![
            desktop_runtime,
            set_keep_master_on_close,
            set_start_at_login,
            restart_master,
            open_log_folder,
            quit_desktop
        ])
        .setup(|app| {
            configure_path();
            let app_data = platform_data_dir();
            let app_config = platform_config_dir();
            let app_log = platform_log_dir();
            fs::create_dir_all(&app_data)?;
            fs::create_dir_all(&app_config)?;
            fs::create_dir_all(&app_log)?;
            set_private_dir(&app_data);
            set_private_dir(&app_config);
            set_private_dir(&app_log);
            let resource_root = app.path().resource_dir()?;
            let app_root = resource_root.join("resources").join("app");
            let node = resource_root.join("resources").join("runtime").join(
                if cfg!(target_os = "windows") {
                    "node.exe"
                } else {
                    "node"
                },
            );
            let paths = Paths {
                app_root,
                node,
                data: app_data,
                log: app_log,
                config: app_config.join("desktop-preferences.json"),
            };
            let state = DesktopState::new(paths);
            if let Ok(mut runtime) = state.runtime.lock() {
                launch_or_connect(&state.paths, &mut runtime);
            }
            app.manage(state);

            let window = app
                .get_webview_window("main")
                .expect("main desktop window is configured");
            if std::env::args().any(|argument| argument == "--background") {
                let _ = window.hide();
            } else {
                let _ = window.show();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<DesktopState>();
                if let Ok(mut runtime) = state.runtime.lock() {
                    if runtime.preferences.keep_master_on_close {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        stop_owned_child(&mut runtime);
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Turing Terminal desktop shell");
}

fn launch_or_connect(paths: &Paths, runtime: &mut RuntimeState) {
    runtime.status = "Starting".to_owned();
    runtime.error = None;
    runtime.port = None;
    runtime.started_by_app = false;
    runtime.started_at = None;
    if !paths.node.is_file() || !paths.app_root.join("dist-server/server/index.js").is_file() {
        runtime.status = "Error".to_owned();
        runtime.error = Some(format!(
            "The bundled Desktop Master is incomplete. Reinstall Turing Terminal. Expected runtime at {}.",
            paths.node.display()
        ));
        return;
    }

    let mut early_failures = 0;
    for port in FIRST_PORT..=LAST_PORT {
        match health_check(port) {
            Some(true) if manifest_check(port) => {
                runtime.port = Some(port);
                runtime.status = "Running".to_owned();
                runtime.started_by_app = false;
                runtime.started_at = Some(Instant::now());
                return;
            }
            Some(false) => continue,
            Some(true) => continue,
            None => {}
        }
        match spawn_master(paths, port) {
            Ok(mut child) => {
                let deadline = Instant::now() + START_TIMEOUT;
                let mut exited_early = false;
                while Instant::now() < deadline {
                    if health_check(port) == Some(true) && manifest_check(port) {
                        runtime.child = Some(child);
                        runtime.port = Some(port);
                        runtime.status = "Running".to_owned();
                        runtime.started_by_app = true;
                        runtime.started_at = Some(Instant::now());
                        return;
                    }
                    if let Ok(Some(status)) = child.try_wait() {
                        runtime.error = Some(format!(
                            "The bundled Desktop Master exited during startup ({status}). See {}.",
                            paths.log.display()
                        ));
                        exited_early = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                let _ = child.kill();
                let _ = child.wait();
                if !exited_early {
                    runtime.status = "Error".to_owned();
                    runtime.error = Some(format!("The bundled Desktop Master did not become ready within {} seconds. See {}.", START_TIMEOUT.as_secs(), paths.log.display()));
                    return;
                }
                early_failures += 1;
                if early_failures >= MAX_EARLY_START_FAILURES {
                    runtime.status = "Error".to_owned();
                    return;
                }
            }
            Err(error) => {
                runtime.error = Some(format!(
                    "Could not start the bundled Desktop Master: {error}. See {}.",
                    paths.log.display()
                ));
                runtime.status = "Error".to_owned();
                return;
            }
        }
    }
    runtime.status = "Error".to_owned();
    if runtime.error.is_none() {
        runtime.error = Some(format!("Ports {FIRST_PORT}–{LAST_PORT} are occupied by other services. Close the conflicting program and restart Turing Terminal."));
    }
}

fn spawn_master(paths: &Paths, port: u16) -> Result<Child, String> {
    fs::create_dir_all(&paths.data).map_err(|error| error.to_string())?;
    set_private_dir(&paths.data);
    fs::create_dir_all(&paths.log).map_err(|error| error.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.log.join("desktop-master.log"))
        .map_err(|error| error.to_string())?;
    let stderr = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(&paths.node);
    command
        .arg("dist-server/server/index.js")
        .current_dir(&paths.app_root)
        .env("TT_HOST", "127.0.0.1")
        .env("TT_PORT", port.to_string())
        .env("TT_DATA_DIR", &paths.data)
        .env("TT_APP_VERSION", APP_VERSION)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    command.spawn().map_err(|error| error.to_string())
}

fn health_check(port: u16) -> Option<bool> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(150)) {
        Ok(stream) => stream,
        Err(_) => return None,
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .ok()?;
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let response = String::from_utf8_lossy(&response);
    let (headers, body) = response.split_once("\r\n\r\n")?;
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return Some(false);
    }
    Some(is_current_turing_health(body))
}

fn is_current_turing_health(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    json.get("ok") == Some(&Value::Bool(true))
        && json.get("service").and_then(Value::as_str) == Some("turing-terminal")
        && json.get("localOnly") == Some(&Value::Bool(true))
        && json.get("version").and_then(Value::as_str) == Some(APP_VERSION)
}

fn manifest_check(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
        return false;
    };
    if stream.set_read_timeout(Some(Duration::from_millis(500))).is_err()
        || stream.set_write_timeout(Some(Duration::from_millis(500))).is_err()
        || stream.write_all(b"GET /manifest.webmanifest HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut response = Vec::new();
    if stream.read_to_end(&mut response).is_err() {
        return false;
    }
    let response = String::from_utf8_lossy(&response);
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    headers.starts_with("HTTP/1.1 200") && body.contains("Turing Terminal")
}

fn refresh_child_status(runtime: &mut RuntimeState) {
    if let Some(child) = runtime.child.as_mut() {
        if let Ok(Some(status)) = child.try_wait() {
            runtime.status = "Error".to_owned();
            runtime.error = Some(format!("Turing Terminal Master stopped unexpectedly ({status}). Restart it or open the logs."));
            runtime.child = None;
        }
    }
    if let Some(port) = runtime.port {
        if health_check(port) != Some(true) && runtime.status == "Running" {
            runtime.status = "Error".to_owned();
            runtime.error = Some(
                "Turing Terminal Master stopped responding. Restart it or open the logs."
                    .to_owned(),
            );
        }
    }
}

fn stop_owned_child(runtime: &mut RuntimeState) {
    if let Some(mut child) = runtime.child.take() {
        let _ = child.kill();
        let _ = child.wait();
        runtime.status = "Offline".to_owned();
        runtime.port = None;
        runtime.started_by_app = false;
        runtime.started_at = None;
    }
}

fn runtime_view(paths: &Paths, runtime: &RuntimeState) -> DesktopRuntime {
    let port = runtime.port;
    DesktopRuntime {
        status: runtime.status.clone(),
        version: APP_VERSION.to_owned(),
        port,
        master_url: port.map(|port| format!("http://127.0.0.1:{port}")),
        uptime_seconds: runtime.started_at.map(|start| start.elapsed().as_secs()),
        started_by_app: runtime.started_by_app,
        error: runtime.error.clone(),
        log_path: paths.log.to_string_lossy().into_owned(),
        data_path: paths.data.to_string_lossy().into_owned(),
        keep_master_on_close: runtime.preferences.keep_master_on_close,
        start_at_login: runtime.preferences.start_at_login,
        tools: detect_tools(),
    }
}

fn detect_tools() -> Vec<ToolStatus> {
    let tools: [(&str, &str, &[&str]); 6] = [
        ("git", "Git", &["git", "git.exe"]),
        ("tailscale", "Tailscale", &["tailscale", "tailscale.exe"]),
        ("opencode", "OpenCode", &["opencode", "opencode.exe"]),
        ("codex", "Codex", &["codex", "codex.exe"]),
        ("claude", "Claude Code", &["claude", "claude.exe"]),
        ("cline", "Cline", &["cline", "cline.exe"]),
    ];
    let path = env::var_os("PATH").unwrap_or_default();
    let mut directories: Vec<PathBuf> = env::split_paths(&path).collect();
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        directories.extend([
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join(".nvm/current/bin"),
        ]);
    }
    if cfg!(target_os = "windows") {
        if let Some(appdata) = env::var_os("APPDATA") {
            directories.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            directories.push(PathBuf::from(local).join("Programs"));
        }
    }
    tools
        .into_iter()
        .map(|(id, name, candidates)| ToolStatus {
            id: id.to_owned(),
            name: name.to_owned(),
            installed: candidates.iter().any(|candidate| {
                directories
                    .iter()
                    .any(|directory| directory.join(candidate).is_file())
            }),
        })
        .collect()
}

fn load_preferences(path: &Path) -> Preferences {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
        .unwrap_or_default()
}

fn save_preferences(path: &Path, preferences: &Preferences) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Application settings folder is unavailable.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(preferences).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn configure_path() {
    let mut directories: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        directories.extend([
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join(".nvm/current/bin"),
        ]);
    }
    if cfg!(target_os = "windows") {
        if let Some(appdata) = env::var_os("APPDATA") {
            directories.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            directories.push(PathBuf::from(local).join("Programs"));
        }
    }
    if let Ok(path) = env::join_paths(directories) {
        env::set_var("PATH", path);
    }
}

#[cfg(target_os = "windows")]
fn platform_data_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("AppData/Local")
        })
        .join("TuringTerminal")
        .join("data")
}

#[cfg(target_os = "windows")]
fn platform_config_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("AppData/Local")
        })
        .join("TuringTerminal")
        .join("config")
}

#[cfg(target_os = "windows")]
fn platform_log_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("AppData/Local")
        })
        .join("TuringTerminal")
        .join("logs")
}

#[cfg(not(target_os = "windows"))]
fn platform_data_dir() -> PathBuf {
    xdg_dir("XDG_DATA_HOME", ".local/share")
        .join("turing-terminal")
        .join("data")
}

#[cfg(not(target_os = "windows"))]
fn platform_config_dir() -> PathBuf {
    xdg_dir("XDG_CONFIG_HOME", ".config").join("turing-terminal")
}

#[cfg(not(target_os = "windows"))]
fn platform_log_dir() -> PathBuf {
    xdg_dir("XDG_STATE_HOME", ".local/state")
        .join("turing-terminal")
        .join("logs")
}

#[cfg(not(target_os = "windows"))]
fn xdg_dir(variable: &str, fallback: &str) -> PathBuf {
    env::var_os(variable).map(PathBuf::from).unwrap_or_else(|| {
        env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(fallback)
    })
}

#[cfg(unix)]
fn set_private_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn set_private_dir(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::{is_current_turing_health, Preferences, APP_VERSION, FIRST_PORT, LAST_PORT};

    #[test]
    fn only_reuses_the_current_loopback_master_identity() {
        let health = format!(
            r#"{{"ok":true,"service":"turing-terminal","version":"{APP_VERSION}","localOnly":true}}"#
        );
        assert!(is_current_turing_health(&health));
        assert!(!is_current_turing_health(
            r#"{"ok":true,"service":"other","version":"0.9.0","localOnly":true}"#
        ));
        assert!(!is_current_turing_health(
            r#"{"ok":true,"service":"turing-terminal","version":"1.0.0","localOnly":true}"#
        ));
    }

    #[test]
    fn defaults_to_keep_master_and_bounded_loopback_port_range() {
        let preferences = Preferences::default();
        assert!(preferences.keep_master_on_close);
        assert!(!preferences.start_at_login);
        assert_eq!(FIRST_PORT, 4317);
        assert!(LAST_PORT > FIRST_PORT);
    }
}
