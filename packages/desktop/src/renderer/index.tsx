// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
  usePlatform,
  useServer,
  useServerSDK,
  useServerSync,
  useWslServers,
} from "@opencode-ai/app"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createMemo, createResource, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { initializationData, initializationReady } from "./initialization"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import "./styles.css"
import { useTheme } from "@opencode-ai/ui/theme/context"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            import.meta.env.OPENCODE_CHANNEL === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

void initI18n()

const deepLinkEvent = "opencode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

const createPlatform = (): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const activeWslDistro = () => {
    const key = window.__OPENCODE__?.activeServer
    if (!key?.startsWith("wsl:")) return undefined
    return key.slice("wsl:".length)
  }

  const wslHome = async () => {
    const distro = activeWslDistro()
    if (!distro) return undefined
    return window.api.wslPath("~", "windows", distro).catch(() => undefined)
  }

  async function handleWslPicker(result: string | null): Promise<string | null>
  async function handleWslPicker(result: string[]): Promise<string[]>
  async function handleWslPicker(result: string | string[] | null): Promise<string | string[] | null>
  async function handleWslPicker(result: string | string[] | null) {
    const distro = activeWslDistro()
    if (!result || !distro) return result
    const convert = (path: string) => window.api.wslPath(path, "linux", distro).catch(() => path)
    if (Array.isArray(result)) {
      return Promise.all(result.map(convert))
    }
    return convert(result)
  }

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        accept: opts?.accept ?? ACCEPTED_FILE_TYPES,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      return handleWslPicker(result)
    },

    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        const resolvedPath = await (async () => {
          const distro = activeWslDistro()
          if (distro) {
            const converted = await window.api.wslPath(path, "windows", distro).catch(() => null)
            if (converted) return converted
          }
          return path
        })()
        return window.api.openPath(resolvedPath, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    checkUpdate: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return { updateAvailable: false }
      return window.api.checkUpdate()
    },

    updateAndRestart: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return
      await window.api.installUpdate()
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: os === "windows" ? window.api.wslServers : undefined,
    desktopMcp: os === "windows" ? window.api.desktopMcp : undefined,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

render(() => {
  const platform = createPlatform()
  const [windowConfig] = createResource(() => window.api.getWindowConfig().catch(() => ({ updaterEnabled: false })))
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => window.api.getWindowCount())

  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    const wslServers = useWslServers()
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: "Local Server",
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      for (const item of wslServers.data?.servers ?? []) {
        const runtime = item.runtime
        if (runtime.kind !== "ready") continue
        list.push({
          displayName: item.config.distro,
          type: "sidecar",
          variant: "wsl",
          distro: item.config.distro,
          http: {
            url: runtime.url,
            username: runtime.username ?? undefined,
            password: runtime.password ?? undefined,
          },
        })
      }
      return list
    })
    const effectiveDefaultServer = createMemo(() => {
      const key = defaultServer.latest ?? ServerConnection.Key.make("sidecar")
      if (!key.startsWith("wsl:")) return key
      const item = wslServers.data?.servers.find((item) => item.config.id === key)
      if (item?.runtime.kind === "ready") return key
      return ServerConnection.Key.make("sidecar")
    })

    return (
      <Show
        when={
          !defaultServer.loading &&
          initializationReady(sidecar) &&
          !windowConfig.loading &&
          !windowCount.loading &&
          !locale.loading
        }
      >
        {(_) => {
          return (
            <AppInterface defaultServer={effectiveDefaultServer()} servers={servers()} router={MemoryRouter}>
              <DesktopMcpBridge />
              <Inner />
            </AppInterface>
          )
        }}
      </Show>
    )
  }

  function DesktopMcpBridge() {
    const platform = usePlatform()
    const server = useServer()
    const sdk = useServerSDK()
    const serverSync = useServerSync()
    let lastRegistered = ""

    createEffect(() => {
      const desktopMcp = platform.desktopMcp
      const conn = server.current
      if (!desktopMcp || !conn) return
      const target = desktopMcpTarget(conn)
      if (!target) return

      void (async () => {
        try {
          const config = await sdk.client.config.get().then((result) => result.data)
          const bridges = clientMcpConfigs(config)
          if (bridges.length === 0) return
          const key = `${ServerConnection.key(conn)}:${sdk.url}:${clientMcpSignature(bridges)}`
          if (key === lastRegistered) return
          lastRegistered = key
          await Promise.all(
            bridges.map(async (item) => {
              const [command, ...args] = item.command
              const bridge = await desktopMcp.startBridge({
                id: item.name,
                target,
                command,
                args,
                environment: item.environment,
              })
              await sdk.client.mcp.add({
                name: item.name,
                config: {
                  type: "remote",
                  url: bridge.url,
                  headers: bridge.headers,
                  oauth: false,
                  enabled: true,
                  timeout: item.timeout ?? 30_000,
                },
              })
            }),
          )
          await serverSync.refreshMcp()
        } catch (error) {
          console.warn("[desktop-mcp] failed to register desktop MCP bridge", error)
          lastRegistered = ""
        }
      })()
    })

    return null
  }

  function desktopMcpTarget(conn: ServerConnection.Any) {
    if (conn.type === "sidecar") {
      if (conn.variant === "wsl") return { target: "wsl" as const, distro: conn.distro }
      if (conn.variant === "base") return { target: "local" as const }
      return undefined
    }
    const host = new URL(conn.http.url).hostname
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return { target: "local" as const }
    return { target: "remote" as const, serverUrl: conn.http.url }
  }

  type ClientPlacedMcp = {
    name: string
    command: string[]
    environment?: Record<string, string>
    timeout?: number
  }

  function clientMcpConfigs(config: unknown): ClientPlacedMcp[] {
    if (!config || typeof config !== "object" || !("mcp" in config)) return []
    const mcp = config.mcp
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return []
    return Object.entries(mcp).flatMap(([name, item]) => {
      if (!isClientPlacedMcp(item)) return []
      return [{ name, command: item.command, environment: item.environment, timeout: item.timeout }]
    })
  }

  function isClientPlacedMcp(value: unknown): value is Omit<ClientPlacedMcp, "name"> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    if (!("type" in value) || value.type !== "local") return false
    if (!("placement" in value) || value.placement !== "client") return false
    if ("enabled" in value && value.enabled === false) return false
    if (!("command" in value) || !Array.isArray(value.command) || !value.command.every((item) => typeof item === "string")) {
      return false
    }
    if (value.command.length === 0) return false
    if ("environment" in value && !isStringRecord(value.environment)) return false
    if ("timeout" in value && typeof value.timeout !== "number") return false
    return true
  }

  function isStringRecord(value: unknown): value is Record<string, string> {
    return (
      value !== undefined &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => typeof item === "string")
    )
  }

  function clientMcpSignature(items: ClientPlacedMcp[]) {
    return JSON.stringify(items)
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <App />
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
