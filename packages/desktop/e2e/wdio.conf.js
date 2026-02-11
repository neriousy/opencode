import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let tauriDriver
let exit = false
let sandbox

function closeTauriDriver() {
  exit = true
  tauriDriver?.kill()
}

function ensureSandbox() {
  if (sandbox) return sandbox

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-desktop-e2e-"))
  const keep = process.env.OPENCODE_E2E_KEEP_SANDBOX === "1"

  const env = {
    OPENCODE_DISABLE_SHARE: process.env.OPENCODE_DISABLE_SHARE ?? "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: process.env.OPENCODE_DISABLE_LSP_DOWNLOAD ?? "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS ?? "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "true",
    XDG_DATA_HOME: path.join(root, "share"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
  }

  Object.assign(process.env, env)

  sandbox = { root, keep }
  if (keep) console.log(`desktop e2e sandbox: ${root}`)
  return sandbox
}

async function cleanupSandbox() {
  const current = sandbox
  if (!current) return
  if (current.keep) return
  await fsp.rm(current.root, { recursive: true, force: true }).catch(() => undefined)
}

const shutdown = (code, reason) => {
  try {
    closeTauriDriver()
  } finally {
    void cleanupSandbox().finally(() => {
      console.error(`desktop e2e shutdown: ${reason}`)
      process.exit(code)
    })
  }
}

process.once("SIGINT", () => shutdown(130, "SIGINT"))
process.once("SIGTERM", () => shutdown(143, "SIGTERM"))
process.once("SIGHUP", () => shutdown(129, "SIGHUP"))

export const config = {
  host: "127.0.0.1",
  port: 4444,
  specs: ["./e2e/specs/**/*.spec.js"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: path.resolve(
          __dirname,
          "..",
          "src-tauri",
          "target",
          "debug",
          process.platform === "win32" ? "opencode-desktop.exe" : "opencode-desktop",
        ),
      },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  onPrepare: () => {
    ensureSandbox()

    const result = spawnSync("bun", ["run", "tauri", "build", "--", "--debug", "--no-bundle"], {
      cwd: path.resolve(__dirname, ".."),
      stdio: "inherit",
      shell: true,
      env: process.env,
    })

    if (result.status !== 0) {
      throw new Error(`tauri build failed (exit=${result.status ?? "unknown"})`)
    }
  },
  beforeSession: () => {
    ensureSandbox()

    tauriDriver = spawn(path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver"), [], {
      stdio: [null, process.stdout, process.stderr],
      env: process.env,
    })

    tauriDriver.on("error", (error) => {
      console.error("tauri-driver error:", error)
      process.exit(1)
    })

    tauriDriver.on("exit", (code) => {
      if (!exit) {
        console.error("tauri-driver exited with code:", code)
        process.exit(1)
      }
    })
  },
  afterSession: () => {
    closeTauriDriver()
  },
  onComplete: async () => {
    await cleanupSandbox()
  },
}
