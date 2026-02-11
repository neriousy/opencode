import { promptSelector } from "./selectors.js"
import { sessionPath } from "./utils.js"

export async function waitForTauri() {
  await browser.waitUntil(
    async () => {
      return await browser.execute(() => Boolean(window.__TAURI__?.store?.load))
    },
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: "Timed out waiting for Tauri APIs to be available",
    },
  )
}

export async function seedStorage(directory) {
  await waitForTauri()

  const result = await browser.executeAsync(async (dir, done) => {
    try {
      const store = await window.__TAURI__.store.load("opencode.global.dat", { autoSave: false })

      const server = {
        list: [],
        projects: {
          local: [{ worktree: dir, expanded: true }],
        },
        lastProject: { local: dir },
      }

      const model = {
        recent: [{ providerID: "opencode", modelID: "big-pickle" }],
        user: [],
        variant: {},
      }

      await store.set("server", JSON.stringify(server))
      await store.set("model", JSON.stringify(model))
      await store.save()

      done({ ok: true })
    } catch (error) {
      done({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }, directory)

  if (!result?.ok) {
    throw new Error(`Failed to seed storage: ${result?.error ?? "unknown error"}`)
  }
}

export async function gotoSession(directory, sessionID) {
  const next = sessionPath(directory, sessionID)

  await browser.execute((path) => {
    window.history.pushState(null, "", path)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }, next)

  await $(promptSelector).waitForDisplayed({ timeout: 120_000 })
}
