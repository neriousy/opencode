import * as Clipboard from "./clipboard"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type FocusableSelectionTarget = {
  hasSelection: () => boolean
  getClipboardText?: (text: string) => string
}

type Renderer = {
  getSelection: () => { getSelectedText: () => string; selectedRenderables: FocusableSelectionTarget[] } | null
  clearSelection: () => void
  currentFocusedRenderable?: FocusableSelectionTarget | null
}

type SelectionKeyEvent = {
  ctrl?: boolean
  name: string
  preventDefault: () => void
  stopPropagation: () => void
}

// Windows Terminal/ConPTY can choke on bursty OSC 52 writes from rapid select-copy gestures.
const selectionCopySettleMs = 100

let selectionCopyActive = false
let pendingSelectionCopy: { text: string; toast: Toast } | undefined

export function copy(renderer: Renderer, toast: Toast): boolean {
  const selection = renderer.getSelection()
  if (!selection) return false

  const text = selection.getSelectedText()
  if (!text) return false

  const focus = renderer.currentFocusedRenderable
  const clipboardText =
    focus?.getClipboardText && selection.selectedRenderables.includes(focus) ? focus.getClipboardText(text) : text

  enqueueSelectionCopy(clipboardText, toast)

  renderer.clearSelection()
  return true
}

function enqueueSelectionCopy(text: string, toast: Toast) {
  pendingSelectionCopy = { text, toast }
  if (selectionCopyActive) return

  selectionCopyActive = true
  void drainSelectionCopyQueue()
}

async function drainSelectionCopyQueue() {
  while (pendingSelectionCopy) {
    const next = pendingSelectionCopy
    pendingSelectionCopy = undefined

    await Clipboard.copy(next.text)
      .then(() => next.toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(next.toast.error)

    await new Promise((resolve) => setTimeout(resolve, selectionCopySettleMs))
  }

  selectionCopyActive = false
}

export function handleSelectionKey(renderer: Renderer, toast: Toast, event: SelectionKeyEvent) {
  const selection = renderer.getSelection()
  if (!selection) return

  if (event.ctrl && event.name === "c") {
    if (!copy(renderer, toast)) {
      renderer.clearSelection()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    return
  }

  if (event.name === "escape") {
    renderer.clearSelection()
    event.preventDefault()
    event.stopPropagation()
    return
  }

  const focus = renderer.currentFocusedRenderable
  if (focus?.hasSelection() && selection.selectedRenderables.includes(focus)) return

  renderer.clearSelection()
}

export * as Selection from "./selection"
