# OpenCode Desktop

Native OpenCode desktop app, built with Tauri v2.

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop tauri dev
```

This starts the Vite dev server on http://localhost:1420 and opens the native window.

If you only want the web dev server (no native shell):

```bash
bun run --cwd packages/desktop dev
```

## Build

To create a production `dist/` and build the native app bundle:

```bash
bun run --cwd packages/desktop tauri build
```

## E2E Tests (WebDriver)

Tauri v2 e2e tests run through `tauri-driver`.

System dependencies:

- Linux: `cargo install tauri-driver --locked` and ensure `WebKitWebDriver` is in your `$PATH` (often `webkit2gtk-driver`)
- Windows: `cargo install tauri-driver --locked` and ensure `msedgedriver.exe` is in your `$PATH`

Run the suite:

```bash
bun run --cwd packages/desktop test:e2e
```

Note: WebDriver tests are not supported on macOS (no WKWebView driver).

## Prerequisites

Running the desktop app requires additional Tauri dependencies (Rust toolchain, platform-specific libraries). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for setup instructions.
