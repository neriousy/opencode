import type { DialogContext } from "@tui/ui/dialog"
import type { ToastOptions } from "../../ui/toast"

type Model = {
  modelID: string
  providerID: string
}

type Input = {
  dialog: Pick<DialogContext, "clear">
  lock: Set<string>
  model?: Model
  run: (input: { sessionID: string; modelID: string; providerID: string }) => Promise<unknown>
  sessionID: string
  toast: {
    show: (input: ToastOptions) => void
  }
}

export async function compact(input: Input) {
  if (!input.model) {
    input.toast.show({
      variant: "warning",
      message: "Connect a provider to summarize this session",
      duration: 3000,
    })
    return
  }

  if (input.lock.has(input.sessionID)) {
    input.toast.show({
      variant: "info",
      message: "Session compaction already in progress",
      duration: 3000,
    })
    input.dialog.clear()
    return
  }

  input.lock.add(input.sessionID)

  await input
    .run({
      sessionID: input.sessionID,
      modelID: input.model.modelID,
      providerID: input.model.providerID,
    })
    .catch((err) => {
      input.toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to compact session",
        duration: 3000,
      })
    })
    .finally(() => {
      input.lock.delete(input.sessionID)
      input.dialog.clear()
    })
}
