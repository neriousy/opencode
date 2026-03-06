import { describe, expect, test } from "bun:test"
import { compact } from "../../../src/cli/cmd/tui/routes/session/compact"

function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("tui compact action", () => {
  test("waits for summarize before clearing the dialog", async () => {
    const job = deferred()
    const seen: string[] = []

    const run = () => job.promise
    const dialog = { clear: () => seen.push("clear") }
    const toast = {
      show: (input: { variant: string; message: string }) => seen.push(`${input.variant}:${input.message}`),
    }

    const task = compact({
      dialog,
      lock: new Set<string>(),
      model: { modelID: "model", providerID: "provider" },
      run,
      sessionID: "ses_123",
      toast,
    })

    expect(seen).toEqual([])

    job.resolve()
    await task

    expect(seen).toEqual(["success:Session compacted successfully", "clear"])
  })

  test("prevents duplicate in-flight compactions for the same session", async () => {
    const job = deferred()
    const lock = new Set<string>()
    const seen: string[] = []
    let calls = 0

    const run = () => {
      calls += 1
      return job.promise
    }
    const dialog = { clear: () => seen.push("clear") }
    const toast = {
      show: (input: { variant: string; message: string }) => seen.push(`${input.variant}:${input.message}`),
    }

    const first = compact({
      dialog,
      lock,
      model: { modelID: "model", providerID: "provider" },
      run,
      sessionID: "ses_123",
      toast,
    })

    await compact({
      dialog,
      lock,
      model: { modelID: "model", providerID: "provider" },
      run,
      sessionID: "ses_123",
      toast,
    })

    expect(calls).toBe(1)
    expect(seen).toEqual(["info:Session compaction already in progress", "clear"])

    job.resolve()
    await first

    expect(lock.size).toBe(0)
  })

  test("shows the summarize error and clears the dialog", async () => {
    const seen: string[] = []

    await compact({
      dialog: { clear: () => seen.push("clear") },
      lock: new Set<string>(),
      model: { modelID: "model", providerID: "provider" },
      run: () => Promise.reject(new Error("Compaction failed")),
      sessionID: "ses_123",
      toast: {
        show: (input: { variant: string; message: string }) => seen.push(`${input.variant}:${input.message}`),
      },
    })

    expect(seen).toEqual(["error:Compaction failed", "clear"])
  })

  test("warns when no model is selected", async () => {
    const seen: string[] = []

    await compact({
      dialog: { clear: () => seen.push("clear") },
      lock: new Set<string>(),
      run: async () => undefined,
      sessionID: "ses_123",
      toast: {
        show: (input: { variant: string; message: string }) => seen.push(`${input.variant}:${input.message}`),
      },
    })

    expect(seen).toEqual(["warning:Connect a provider to summarize this session"])
  })
})
