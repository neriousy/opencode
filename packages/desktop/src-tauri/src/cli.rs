use futures::{FutureExt, Stream, StreamExt, future};
use tauri::{AppHandle, Manager, path::BaseDirectory};
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent, TerminatedPayload},
};
use tauri_plugin_store::StoreExt;
use tauri_specta::Event;
use tokio::sync::oneshot;
use tracing::Instrument;

use crate::constants::{SETTINGS_STORE, WSL_ENABLED_KEY};

const CLI_INSTALL_DIR: &str = ".opencode/bin";
const CLI_BINARY_NAME: &str = "opencode";
#[cfg(target_os = "macos")]
const DESKTOP_BINARY_NAME: &str = "opencode-desktop";

#[derive(serde::Deserialize, Debug)]
pub struct ServerConfig {
    pub hostname: Option<String>,
    pub port: Option<u32>,
}

#[derive(serde::Deserialize, Debug)]
pub struct Config {
    pub server: Option<ServerConfig>,
}

pub async fn get_config(app: &AppHandle) -> Option<Config> {
    let (events, _) = spawn_command(app, "debug config", &[]).ok()?;

    events
        .fold(String::new(), async |mut config_str, event| {
            if let CommandEvent::Stdout(stdout) = event
                && let Ok(s) = str::from_utf8(&stdout)
            {
                config_str += s
            }

            config_str
        })
        .map(|v| serde_json::from_str::<Config>(&v))
        .await
        .ok()
}

fn get_cli_install_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME").ok().map(|home| {
        std::path::PathBuf::from(home)
            .join(CLI_INSTALL_DIR)
            .join(CLI_BINARY_NAME)
    })
}

pub fn get_sidecar_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    // Get binary with symlinks support
    tauri::process::current_binary(&app.env())
        .expect("Failed to get current binary")
        .parent()
        .expect("Failed to get parent dir")
        .join("opencode-cli")
}

fn is_cli_installed() -> bool {
    get_cli_install_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

const INSTALL_SCRIPT: &str = include_str!("../../../../install");

#[tauri::command]
#[specta::specta]
pub fn install_cli(app: tauri::AppHandle) -> Result<String, String> {
    if cfg!(not(unix)) {
        return Err("CLI installation is only supported on macOS & Linux".to_string());
    }

    let sidecar = get_sidecar_path(&app);
    if !sidecar.exists() {
        return Err("Sidecar binary not found".to_string());
    }

    let temp_script = std::env::temp_dir().join("opencode-install.sh");
    std::fs::write(&temp_script, INSTALL_SCRIPT)
        .map_err(|e| format!("Failed to write install script: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set script permissions: {}", e))?;
    }

    let output = std::process::Command::new(&temp_script)
        .arg("--binary")
        .arg(&sidecar)
        .output()
        .map_err(|e| format!("Failed to run install script: {}", e))?;

    let _ = std::fs::remove_file(&temp_script);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Install script failed: {}", stderr));
    }

    let install_path =
        get_cli_install_path().ok_or_else(|| "Could not determine install path".to_string())?;

    Ok(install_path.to_string_lossy().to_string())
}

pub fn sync_cli(app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        tracing::debug!("Skipping CLI sync for debug build");
        return Ok(());
    }

    if !is_cli_installed() {
        tracing::info!("No CLI installation found, skipping sync");
        return Ok(());
    }

    let cli_path =
        get_cli_install_path().ok_or_else(|| "Could not determine CLI install path".to_string())?;

    let output = std::process::Command::new(&cli_path)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to get CLI version: {}", e))?;

    if !output.status.success() {
        return Err("Failed to get CLI version".to_string());
    }

    let cli_version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let cli_version = semver::Version::parse(&cli_version_str)
        .map_err(|e| format!("Failed to parse CLI version '{}': {}", cli_version_str, e))?;

    let app_version = app.package_info().version.clone();

    if cli_version >= app_version {
        tracing::info!(
            %cli_version, %app_version,
            "CLI is up to date, skipping sync"
        );
        return Ok(());
    }

    tracing::info!(
        %cli_version, %app_version,
        "CLI is older than app version, syncing"
    );

    install_cli(app)?;

    tracing::info!("Synced installed CLI");

    Ok(())
}

#[cfg(target_os = "macos")]
fn desktop_script(app: &tauri::AppHandle) -> String {
    let id = app.config().identifier.clone();
    format!(
        "#!/usr/bin/env bash\nset -euo pipefail\nopen -b '{id}' --args \"$@\"\n"
    )
}

#[cfg(target_os = "macos")]
fn write_launcher(path: &std::path::Path, content: &str, overwrite: bool) -> Result<(), String> {
    if path.exists() {
        let same = std::fs::read_to_string(path)
            .map(|existing| existing == content)
            .unwrap_or(false);

        if same {
            return Ok(());
        }

        if !overwrite {
            return Err("Launcher already exists".to_string());
        }
    }

    std::fs::write(path, content).map_err(|e| format!("Failed to write launcher: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set launcher permissions: {e}"))?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_path(dir: &std::path::Path) -> Result<(), String> {
    let Some(dir) = dir.to_str() else {
        return Ok(());
    };

    let Ok(path) = std::env::var("PATH") else {
        return Ok(());
    };

    if path.split(':').any(|p| p == dir) {
        return Ok(());
    }

    let Ok(home) = std::env::var("HOME") else {
        return Ok(());
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "".to_string());
    let shell = std::path::Path::new(&shell)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("sh");

    let file = match shell {
        "fish" => std::path::PathBuf::from(home).join(".config/fish/config.fish"),
        "zsh" => std::path::PathBuf::from(home).join(".zshrc"),
        "bash" => std::path::PathBuf::from(home).join(".bashrc"),
        _ => std::path::PathBuf::from(home).join(".profile"),
    };

    let line = match shell {
        "fish" => "fish_add_path $HOME/.opencode/bin\n".to_string(),
        _ => "export PATH=\"$HOME/.opencode/bin:$PATH\"\n".to_string(),
    };

    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    if existing.contains(".opencode/bin") {
        return Ok(());
    }

    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut out = existing;
    if !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    out.push_str("# opencode-desktop\n");
    out.push_str(&line);

    std::fs::write(&file, out).map_err(|e| format!("Failed to update shell config: {e}"))?;

    Ok(())
}

#[cfg(target_os = "macos")]
pub fn sync_desktop_command(app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        tracing::debug!("Skipping desktop command sync for debug build");
        return Ok(());
    }

    let script = desktop_script(&app);

    for dir in ["/usr/local/bin", "/opt/homebrew/bin"] {
        let path = std::path::PathBuf::from(dir).join(DESKTOP_BINARY_NAME);
        if write_launcher(&path, &script, false).is_ok() {
            return Ok(());
        }
    }

    let Ok(home) = std::env::var("HOME") else {
        return Err("Could not determine home directory".to_string());
    };

    let path = std::path::PathBuf::from(home)
        .join(CLI_INSTALL_DIR)
        .join(DESKTOP_BINARY_NAME);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create launcher dir: {e}"))?;
        ensure_path(parent)?;
    }

    write_launcher(&path, &script, true)?;

    Ok(())
}

fn get_user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

fn is_wsl_enabled(app: &tauri::AppHandle) -> bool {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return false;
    };

    store
        .get(WSL_ENABLED_KEY)
        .as_ref()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn shell_escape(input: &str) -> String {
    if input.is_empty() {
        return "''".to_string();
    }

    let mut escaped = String::from("'");
    escaped.push_str(&input.replace("'", "'\"'\"'"));
    escaped.push('\'');
    escaped
}

pub fn spawn_command(
    app: &tauri::AppHandle,
    args: &str,
    extra_env: &[(&str, String)],
) -> Result<(impl Stream<Item = CommandEvent> + 'static, CommandChild), tauri_plugin_shell::Error> {
    let state_dir = app
        .path()
        .resolve("", BaseDirectory::AppLocalData)
        .expect("Failed to resolve app local data dir");

    let mut envs = vec![
        (
            "OPENCODE_EXPERIMENTAL_ICON_DISCOVERY".to_string(),
            "true".to_string(),
        ),
        (
            "OPENCODE_EXPERIMENTAL_FILEWATCHER".to_string(),
            "true".to_string(),
        ),
        ("OPENCODE_CLIENT".to_string(), "desktop".to_string()),
        (
            "XDG_STATE_HOME".to_string(),
            state_dir.to_string_lossy().to_string(),
        ),
    ];
    envs.extend(
        extra_env
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone())),
    );

    let cmd = if cfg!(windows) {
        if is_wsl_enabled(app) {
            tracing::info!("WSL is enabled, spawning CLI server in WSL");
            let version = app.package_info().version.to_string();
            let mut script = vec![
                "set -e".to_string(),
                "BIN=\"$HOME/.opencode/bin/opencode\"".to_string(),
                "if [ ! -x \"$BIN\" ]; then".to_string(),
                format!(
                    "  curl -fsSL https://opencode.ai/install | bash -s -- --version {} --no-modify-path",
                    shell_escape(&version)
                ),
                "fi".to_string(),
            ];

            let mut env_prefix = vec![
                "OPENCODE_EXPERIMENTAL_ICON_DISCOVERY=true".to_string(),
                "OPENCODE_EXPERIMENTAL_FILEWATCHER=true".to_string(),
                "OPENCODE_CLIENT=desktop".to_string(),
                "XDG_STATE_HOME=\"$HOME/.local/state\"".to_string(),
            ];
            env_prefix.extend(
                envs.iter()
                    .filter(|(key, _)| key != "OPENCODE_EXPERIMENTAL_ICON_DISCOVERY")
                    .filter(|(key, _)| key != "OPENCODE_EXPERIMENTAL_FILEWATCHER")
                    .filter(|(key, _)| key != "OPENCODE_CLIENT")
                    .filter(|(key, _)| key != "XDG_STATE_HOME")
                    .map(|(key, value)| format!("{}={}", key, shell_escape(value))),
            );

            script.push(format!("{} exec \"$BIN\" {}", env_prefix.join(" "), args));

            app.shell()
                .command("wsl")
                .args(["-e", "bash", "-lc", &script.join("\n")])
        } else {
            let mut cmd = app
                .shell()
                .sidecar("opencode-cli")
                .unwrap()
                .args(args.split_whitespace());

            for (key, value) in envs {
                cmd = cmd.env(key, value);
            }

            cmd
        }
    } else {
        let sidecar = get_sidecar_path(app);
        let shell = get_user_shell();

        let cmd = if shell.ends_with("/nu") {
            format!("^\"{}\" {}", sidecar.display(), args)
        } else {
            format!("\"{}\" {}", sidecar.display(), args)
        };

        let mut cmd = app.shell().command(&shell).args(["-il", "-c", &cmd]);

        for (key, value) in envs {
            cmd = cmd.env(key, value);
        }

        cmd
    };

    let (rx, child) = cmd.spawn()?;
    let event_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let event_stream = sqlite_migration::logs_middleware(app.clone(), event_stream);

    Ok((event_stream, child))
}

pub fn serve(
    app: &AppHandle,
    hostname: &str,
    port: u32,
    password: &str,
) -> (CommandChild, oneshot::Receiver<TerminatedPayload>) {
    let (exit_tx, exit_rx) = oneshot::channel::<TerminatedPayload>();

    tracing::info!(port, "Spawning sidecar");

    let envs = [
        ("OPENCODE_SERVER_USERNAME", "opencode".to_string()),
        ("OPENCODE_SERVER_PASSWORD", password.to_string()),
    ];

    let (events, child) = spawn_command(
        app,
        format!("--print-logs --log-level WARN serve --hostname {hostname} --port {port}").as_str(),
        &envs,
    )
    .expect("Failed to spawn opencode");

    let mut exit_tx = Some(exit_tx);
    tokio::spawn(
        events
            .for_each(move |event| {
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes);
                        tracing::info!("{line}");
                    }
                    CommandEvent::Stderr(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes);
                        tracing::info!("{line}");
                    }
                    CommandEvent::Error(err) => {
                        tracing::error!("{err}");
                    }
                    CommandEvent::Terminated(payload) => {
                        tracing::info!(
                            code = ?payload.code,
                            signal = ?payload.signal,
                            "Sidecar terminated"
                        );

                        if let Some(tx) = exit_tx.take() {
                            let _ = tx.send(payload);
                        }
                    }
                    _ => {}
                }

                future::ready(())
            })
            .instrument(tracing::info_span!("sidecar")),
    );

    (child, exit_rx)
}

pub mod sqlite_migration {
    use super::*;

    #[derive(
        tauri_specta::Event, serde::Serialize, serde::Deserialize, Clone, Copy, Debug, specta::Type,
    )]
    #[serde(tag = "type", content = "value")]
    pub enum SqliteMigrationProgress {
        InProgress(u8),
        Done,
    }

    pub(super) fn logs_middleware(
        app: AppHandle,
        stream: impl Stream<Item = CommandEvent>,
    ) -> impl Stream<Item = CommandEvent> {
        let app = app.clone();
        let mut done = false;

        stream.filter_map(move |event| {
            if done {
                return future::ready(Some(event));
            }

            future::ready(match &event {
                CommandEvent::Stdout(stdout) => {
                    let Ok(s) = str::from_utf8(stdout) else {
                        return future::ready(None);
                    };

                    if let Some(s) = s.strip_prefix("sqlite-migration:").map(|s| s.trim()) {
                        if let Ok(progress) = s.parse::<u8>() {
                            let _ = SqliteMigrationProgress::InProgress(progress).emit(&app);
                        } else if s == "done" {
                            done = true;
                            let _ = SqliteMigrationProgress::Done.emit(&app);
                        }

                        None
                    } else {
                        Some(event)
                    }
                }
                _ => Some(event),
            })
        })
    }
}
