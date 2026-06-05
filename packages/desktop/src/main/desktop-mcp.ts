import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { networkInterfaces } from "node:os"
import { runWslInDistro } from "./wsl"

type DesktopMcpTarget = { target: "local" } | { target: "wsl"; distro: string } | { target: "remote"; serverUrl: string }

export type DesktopMcpBridgeRequest = {
  id: string
  target: DesktopMcpTarget
  command: string
  args?: string[]
  environment?: Record<string, string>
}

type Bridge = {
  signature: string
  port: number
  apiKey: string
  child: ChildProcess
}

export type DesktopMcpBridge = {
  url: string
  headers: Record<string, string>
}

export function createDesktopMcpController(logger?: {
  log: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}) {
  const bridges = new Map<string, Bridge>()

  async function startBridge(request: DesktopMcpBridgeRequest): Promise<DesktopMcpBridge> {
    const signature = bridgeSignature(request)
    const existing = bridges.get(request.id)
    if (existing?.signature === signature) {
      return bridgeResponse(existing, request.target)
    }
    if (existing) stopBridge(existing)
    const bridge = await startProxy(request, signature, logger)
    bridges.set(request.id, bridge)
    bridge.child.once("exit", () => {
      if (bridges.get(request.id) === bridge) bridges.delete(request.id)
    })
    return bridgeResponse(bridge, request.target)
  }

  async function bridgeResponse(bridge: Bridge, target: DesktopMcpTarget) {
    return {
      url: `http://${await hostForTarget(target)}:${bridge.port}/mcp`,
      headers: { "X-API-Key": bridge.apiKey },
    }
  }

  function stopAll() {
    for (const bridge of bridges.values()) stopBridge(bridge)
    bridges.clear()
  }

  return { startBridge, stopAll }
}

async function startProxy(
  request: DesktopMcpBridgeRequest,
  signature: string,
  logger?: {
    log: (message: string, meta?: unknown) => void
    error: (message: string, meta?: unknown) => void
  },
) {
  const port = await freePort()
  const apiKey = randomBytes(24).toString("base64url")
  const child = spawn(npxCommand(), [
    "-y",
    "mcp-proxy@latest",
    "--host",
    "0.0.0.0",
    "--port",
    String(port),
    "--server",
    "stream",
    "--apiKey",
    apiKey,
    "--shell",
    "--",
    request.command,
    ...(request.args ?? []),
  ], {
    env: {
      ...process.env,
      ...request.environment,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  child.stdout.on("data", (chunk) => logger?.log("desktop mcp stdout", { text: chunk.toString() }))
  child.stderr.on("data", (chunk) => logger?.log("desktop mcp stderr", { text: chunk.toString() }))
  child.once("exit", (code, signal) => logger?.error("desktop mcp exited", { id: request.id, code, signal }))

  await waitForProxy(port, child)
  logger?.log("desktop mcp bridge ready", { id: request.id, port })
  return { signature, port, apiKey, child }
}

function stopBridge(bridge: Bridge) {
  try {
    bridge.child.kill()
  } catch {
    /* ignore */
  }
}

function bridgeSignature(request: DesktopMcpBridgeRequest) {
  return JSON.stringify({
    command: request.command,
    args: request.args ?? [],
    environment: request.environment ?? {},
  })
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx"
}

async function hostForTarget(target: DesktopMcpTarget) {
  if (target.target === "local") return "127.0.0.1"
  if (target.target === "remote") return hostForRemoteServer(target.serverUrl)
  const result = await runWslInDistro(
    ["sh", "-lc", "awk '/^nameserver / { print $2; exit }' /etc/resolv.conf"],
    target.distro,
  ).catch(() => undefined)
  return firstLine(result?.stdout ?? "") ?? "127.0.0.1"
}

function hostForRemoteServer(serverUrl: string) {
  const serverAddress = ipv4FromUrl(serverUrl)
  const addresses = Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address)
    .filter((address) => !address.startsWith("169.254."))

  if (serverAddress) {
    const sameSubnet = addresses.find((address) => sameIpv4Subnet24(address, serverAddress))
    if (sameSubnet) return sameSubnet
    if (isTailscaleAddress(serverAddress)) {
      const tailscale = addresses.find(isTailscaleAddress)
      if (tailscale) return tailscale
    }
  }

  return addresses[0] ?? "127.0.0.1"
}

function ipv4FromUrl(value: string) {
  try {
    const hostname = new URL(value).hostname
    return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ? hostname : undefined
  } catch {
    return undefined
  }
}

function sameIpv4Subnet24(left: string, right: string) {
  const a = left.split(".")
  const b = right.split(".")
  return a.length === 4 && b.length === 4 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function isTailscaleAddress(address: string) {
  const [first, second] = address.split(".").map((part) => Number(part))
  return first === 100 && second >= 64 && second <= 127
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "0.0.0.0", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port)
          return
        }
        reject(new Error("Failed to allocate desktop MCP port"))
      })
    })
  })
}

function waitForProxy(port: number, child: ChildProcess) {
  const started = Date.now()
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (child.exitCode !== null) {
        reject(new Error(`Desktop MCP proxy exited with code ${child.exitCode}`))
        return
      }
      fetch(`http://127.0.0.1:${port}/ping`)
        .then((response) => {
          if (response.ok) {
            resolve()
            return
          }
          retry(check, started, reject)
        })
        .catch(() => retry(check, started, reject))
    }
    check()
  })
}

function retry(check: () => void, started: number, reject: (error: Error) => void) {
  if (Date.now() - started > 60_000) {
    reject(new Error("Desktop MCP proxy did not become ready"))
    return
  }
  setTimeout(check, 500)
}

function firstLine(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean)
}
