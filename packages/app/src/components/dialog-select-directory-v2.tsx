import "@pierre/trees/web-components"
import { FileTree } from "@pierre/trees"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import {
  absoluteTreePath,
  activeTreeNavigation,
  advanceTreePreload,
  cleanPickerInput,
  countPickerIgnoredNodes,
  createPriorityTaskQueue,
  createDirectorySearch,
  currentPickerSuggestions,
  displayPickerPath,
  filterPickerNodes,
  nextSuggestionIndex,
  nextTreeScrollTop,
  pickerAbsoluteInput,
  pickerBreadcrumbs,
  pickerFileSearchQuery,
  pickerMode,
  pickerParent,
  pickerPathHasIgnoredPart,
  pickerRoot,
  preloadTreeDirectories,
} from "./directory-picker-domain"
import type { PickerNode } from "./directory-picker-domain"
import "./dialog-select-directory-v2.css"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"

interface DialogSelectDirectoryV2Props {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
  server: ServerConnection.Any
  mode?: "directory" | "file"
  start?: string
}

const TREE_PRELOAD_LIMIT = 24
const EXPANDED_CHILDREN_TO_REVEAL = 5

export function DialogSelectDirectoryV2(props: DialogSelectDirectoryV2Props) {
  const global = useGlobal()
  const { sync, sdk } = global.ensureServerCtx(props.server)
  const dialog = useDialog()
  const language = useLanguage()
  const policy = pickerMode(props.mode ?? "directory", props.start)
  const action = {
    file: language.t("dialog.directory.action.selectFile"),
    directory: language.t("dialog.directory.action.selectFolder"),
  }
  const [root, setRoot] = createSignal("")
  const [input, setInput] = createSignal("")
  const [selected, setSelected] = createSignal("")
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false)
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [rootValid, setRootValid] = createSignal(false)
  const [showIgnored, setShowIgnored] = createSignal(false)
  const [ignoredCount, setIgnoredCount] = createSignal(0)
  const listings = new Map<string, Promise<PickerNode[] | undefined>>()
  const loads = createPriorityTaskQueue<PickerNode[] | undefined>(3)
  const advanced = new Set<string>()
  const loaded = new Set<string>()
  const loadedChildCount = new Map<string, number>()
  const loadingPaths = new Set<string>()
  const erroredPaths = new Set<string>()
  const expandedPaths = new Set<string>()
  let tree: FileTree | undefined
  let container: HTMLDivElement | undefined
  let pathArea: HTMLDivElement | undefined
  let navigation = 0
  let loadingSyncFrame: number | undefined

  const treePathKey = (path: string) => path.replace(/\/+$/, "")
  const treeShadowRoot = () => tree?.getFileTreeContainer()?.shadowRoot
  const treeScroller = () => treeShadowRoot()?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")

  const syncLoadingPaths = () => {
    const rows = treeShadowRoot()?.querySelectorAll<HTMLElement>('button[data-type="item"]')
    if (!rows) return
    rows.forEach((row) => {
      const key = treePathKey(row.dataset.itemPath ?? "")
      if (loadingPaths.has(key)) row.dataset.directoryPickerLoading = "true"
      else delete row.dataset.directoryPickerLoading
      if (erroredPaths.has(key)) row.dataset.directoryPickerError = "true"
      else delete row.dataset.directoryPickerError
    })
  }

  const scheduleLoadingSync = () => {
    if (loadingSyncFrame !== undefined) return
    loadingSyncFrame = requestAnimationFrame(() => {
      loadingSyncFrame = undefined
      syncLoadingPaths()
      if (loadingPaths.size > 0) scheduleLoadingSync()
    })
  }

  const setPathLoading = (path: string, loading: boolean) => {
    const key = treePathKey(path)
    if (loading) {
      loadingPaths.add(key)
      erroredPaths.delete(key)
    }
    if (!loading) loadingPaths.delete(key)
    syncLoadingPaths()
    scheduleLoadingSync()
  }

  const revealExpandedPath = (path: string, childCount: number) => {
    if (childCount <= 0) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const shadow = treeShadowRoot()
        const scroller = treeScroller()
        if (!shadow || !scroller) return
        const key = treePathKey(path)
        const row = Array.from(
          shadow.querySelectorAll('button[data-type="item"]') as NodeListOf<HTMLElement>,
        ).find((candidate) => treePathKey(candidate.dataset.itemPath ?? "") === key)
        if (!row) return

        const scrollerRect = scroller.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        const itemHeight = row.offsetHeight || 24
        const padding = 8
        const desiredChildren = Math.min(childCount, EXPANDED_CHILDREN_TO_REVEAL)
        let delta = 0

        if (rowRect.top < scrollerRect.top + padding) {
          delta = rowRect.top - scrollerRect.top - padding
        } else {
          const desiredBottom = rowRect.bottom + itemHeight * desiredChildren
          const maxBottom = scrollerRect.bottom - padding
          if (desiredBottom > maxBottom) delta = desiredBottom - maxBottom
        }

        const next = nextTreeScrollTop(scroller.scrollTop, delta, scroller.scrollHeight, scroller.clientHeight)
        if (next === scroller.scrollTop) return
        scroller.scrollTop = next
        scroller.dispatchEvent(new Event("scroll"))
      })
    })
  }

  const missingBase = createMemo(() => !(sync.data.path.home || sync.data.path.directory))
  const [fallbackPath] = createResource(
    () => (missingBase() ? true : undefined),
    () => sdk.client.path.get().then((result) => result.data).catch(() => undefined),
    { initialValue: undefined },
  )
  const home = createMemo(() => sync.data.path.home || fallbackPath()?.home || "")
  const start = createMemo(
    () => props.start || sync.data.path.home || sync.data.path.directory || fallbackPath()?.home || fallbackPath()?.directory,
  )
  const selectionPath = createMemo(() => policy.result(root(), selected(), rootValid()) ?? "")
  const breadcrumbs = createMemo(() => pickerBreadcrumbs(root(), home()))
  const search = createDirectorySearch({ sdk, home, base: () => root() || start(), showIgnored })
  const [suggestions] = createResource(input, async (value) => {
    const typed = cleanPickerInput(value).replace(/\/+$/, "")
    const current = displayPickerPath(root(), value, home()).replace(/\/+$/, "")
    if (!typed || typed === current) return { query: value, items: [] }
    const directories = (await search(value)).map((absolute) => ({ absolute, type: "directory" as const }))
    if (!policy.includeFiles) return { query: value, items: directories.slice(0, 5) }
    const files = await sdk.client.find
      .files({ directory: root(), query: pickerFileSearchQuery(root(), value, home()), type: "file", limit: 20 })
      .then((result) => result.data ?? [])
      .catch(() => [])
    const visibleFiles = showIgnored() ? files : files.filter((path) => !pickerPathHasIgnoredPart(path))
    const results = [
      ...directories,
      ...visibleFiles.map((path) => ({ absolute: absoluteTreePath(root(), path), type: "file" as const })),
    ]
    return {
      query: value,
      items: Array.from(new Map(results.map((result) => [result.absolute, result])).values()).slice(0, 8),
    }
  })
  const currentSuggestions = createMemo(() => currentPickerSuggestions(suggestions(), input()))

  async function load(path: string, generation: number, preload = true, visible = false) {
    const key = treePathKey(path)
    const cachedChildCount = loadedChildCount.get(key) ?? 0
    if (loaded.has(key)) {
      if (visible) revealExpandedPath(path, cachedChildCount)
      return true
    }
    setError(false)
    if (visible) setPathLoading(path, true)
    const priority = preload || visible ? "user" : "background"
    const existing = listings.get(key)
    if (existing && priority === "user") loads.promote(`${generation}:${key}`)
    const visibleStartedAt = Date.now()
    const clearVisibleLoading = async () => {
      if (!visible) return
      const remaining = 220 - (Date.now() - visibleStartedAt)
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
      setPathLoading(key, false)
    }
    const request =
      existing ??
      loads.schedule(`${generation}:${key}`, priority, () => {
        if (!activeTreeNavigation(generation, navigation)) return Promise.resolve(undefined)
        return sdk.client.file
          .list({ directory: absoluteTreePath(root(), key), path: "" })
          .then((result) => (result.data ?? []) as PickerNode[])
          .catch(() => undefined)
      })
    listings.set(key, request)
    const nodes = await request
    if (!activeTreeNavigation(generation, navigation)) {
      setPathLoading(key, false)
      return false
    }
    if (!nodes) {
      listings.delete(key)
      loaded.delete(key)
      loadedChildCount.delete(key)
      await clearVisibleLoading()
      if (!key) {
        setIgnoredCount(0)
        setError(true)
      } else if (visible) {
        erroredPaths.add(key)
        syncLoadingPaths()
      }
      return false
    }

    if (!key) setIgnoredCount(countPickerIgnoredNodes(nodes, showIgnored()))
    const visibleNodes = filterPickerNodes(nodes, showIgnored())

    if (!visible && !preload) return true
    if (loaded.has(key)) {
      const childCount = loadedChildCount.get(key) ?? 0
      if (visible) revealExpandedPath(path, childCount)
      await clearVisibleLoading()
      return true
    }
    const entries = policy.entries(key, visibleNodes)
    loaded.add(key)
    erroredPaths.delete(key)
    loadedChildCount.set(key, entries.length)
    await clearVisibleLoading()
    tree?.batch(entries.map((item) => ({ type: "add", path: item })))
    if (visible) revealExpandedPath(path, entries.length)
    if (preload && advanceTreePreload(advanced, key)) {
      const preloadTargets = preloadTreeDirectories(key, visibleNodes).slice(0, TREE_PRELOAD_LIMIT)
      void Promise.all(preloadTargets.map((directory) => load(directory, generation, false)))
    }
    return true
  }

  async function navigate(path: string) {
    const value = policy.navigation(pickerAbsoluteInput(cleanPickerInput(path), home(), root() || start() || home()))
    if (!value) return
    const token = ++navigation
    setLoading(true)
    setRootValid(false)
    setSelected("")
    setIgnoredCount(0)
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
    setRoot(value)
    setInput(displayPickerPath(value, value, home()))
    listings.clear()
    advanced.clear()
    loaded.clear()
    loadedChildCount.clear()
    loadingPaths.clear()
    erroredPaths.clear()
    expandedPaths.clear()
    tree?.resetPaths([])
    const valid = await load("", token)
    if (!activeTreeNavigation(token, navigation)) return
    setRootValid(valid)
    setLoading(false)
  }

  async function refreshIgnoredVisibility(nextShowIgnored: boolean) {
    const token = ++navigation
    const scrollTop = treeScroller()?.scrollTop
    const loadedListings = await Promise.all(
      Array.from(loaded).map(async (path) => ({
        path,
        nodes: await listings.get(path),
      })),
    )
    if (!activeTreeNavigation(token, navigation)) return

    const entries = loadedListings.flatMap((listing) => {
      if (!listing.nodes) return []
      if (!nextShowIgnored && pickerPathHasIgnoredPart(listing.path)) return []
      return policy.entries(listing.path, filterPickerNodes(listing.nodes, nextShowIgnored))
    })

    loadedListings.forEach((listing) => {
      if (!listing.nodes) {
        loadedChildCount.delete(listing.path)
        return
      }
      loadedChildCount.set(
        listing.path,
        policy.entries(listing.path, filterPickerNodes(listing.nodes, nextShowIgnored)).length,
      )
    })

    setIgnoredCount(
      nextShowIgnored
        ? 0
        : countPickerIgnoredNodes(loadedListings.find((listing) => listing.path === "")?.nodes ?? [], nextShowIgnored),
    )
    if (!nextShowIgnored && selected() && pickerPathHasIgnoredPart(selected())) setSelected("")

    tree?.resetPaths(entries, {
      initialExpandedPaths: Array.from(expandedPaths).filter(
        (path) => nextShowIgnored || !pickerPathHasIgnoredPart(path),
      ),
    })
    requestAnimationFrame(() => {
      const scroller = treeScroller()
      if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop
      syncLoadingPaths()
    })
    void Promise.all(
      Array.from(expandedPaths)
        .filter((path) => nextShowIgnored || !pickerPathHasIgnoredPart(path))
        .filter((path) => !loaded.has(treePathKey(path)))
        .map((path) => load(path, token, true, true)),
    )
  }

  function toggleIgnored() {
    const nextShowIgnored = !showIgnored()
    setShowIgnored(nextShowIgnored)
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
    if (loading() || loaded.size === 0) return
    void refreshIgnoredVisibility(nextShowIgnored)
  }

  function complete() {
    const items = currentSuggestions()
    const match = items[activeSuggestion()] ?? items[0]
    if (!match) return
    const value = displayPickerPath(match.absolute, input(), home())
    setInput(match.type === "directory" && !value.endsWith("/") ? value + "/" : value)
    if (match.type === "file") {
      setSelected(
        policy.selection(root(), pickerFileSearchQuery(root(), match.absolute, home())) ?? "",
      )
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
  }

  function chooseSuggestion(suggestion: { absolute: string; type: "file" | "directory" }) {
    if (suggestion.type === "directory") {
      void navigate(suggestion.absolute)
      return
    }
    setInput(displayPickerPath(suggestion.absolute, input(), home()))
    setSelected(
      policy.selection(root(), pickerFileSearchQuery(root(), suggestion.absolute, home())) ?? "",
    )
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
  }

  function moveSuggestion(delta: -1 | 1) {
    setSuggestionsOpen(true)
    setActiveSuggestion((current) => nextSuggestionIndex(current, delta, currentSuggestions().length))
  }

  function activeSuggestionValue() {
    const items = currentSuggestions()
    return items[activeSuggestion()] ?? items[0]
  }

  const keyActions: Partial<Record<string, () => void>> = {
    ArrowDown: () => moveSuggestion(1),
    ArrowUp: () => moveSuggestion(-1),
    Enter: () => {
      const suggestion = activeSuggestionValue()
      if (suggestion) chooseSuggestion(suggestion)
      if (!suggestion) void navigate(input())
    },
    Tab: complete,
  }

  function handleInputKey(event: KeyboardEvent) {
    const action = keyActions[event.key]
    if (!action) return
    if (event.key === "Tab" && event.shiftKey) return
    event.preventDefault()
    action()
  }

  function resolve() {
    const path = selectionPath()
    if (!path) return
    props.onSelect(props.multiple ? [path] : path)
    dialog.close()
  }

  onMount(() => {
    const closeSuggestions = (event: PointerEvent) => {
      if (pathArea?.contains(event.target as Node)) return
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
    document.addEventListener("pointerdown", closeSuggestions)
    onCleanup(() => document.removeEventListener("pointerdown", closeSuggestions))
    tree = new FileTree({
      paths: [],
      flattenEmptyDirectories: false,
      initialExpansion: "closed",
      stickyFolders: false,
      unsafeCSS: `
        button[data-type="item"] {
          background: transparent !important;
          box-shadow: none !important;
        }
        button[data-type="item"]:hover {
          background: var(--v2-overlay-simple-overlay-hover) !important;
        }
        button[data-type="item"]:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
        @keyframes directory-picker-v2-spinner {
          to {
            transform: rotate(360deg);
          }
        }
        button[data-type="item"][data-directory-picker-loading="true"] > [data-item-section="icon"] {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        button[data-type="item"][data-directory-picker-loading="true"] > [data-item-section="icon"] > [data-icon-name="file-tree-icon-chevron"] {
          opacity: 0;
        }
        button[data-type="item"][data-directory-picker-loading="true"] > [data-item-section="icon"]::after {
          content: "";
          position: absolute;
          top: 50%;
          left: 50%;
          width: 10px;
          height: 10px;
          margin-top: -5px;
          margin-left: -5px;
          box-sizing: border-box;
          border: 1.5px solid currentColor;
          border-right-color: transparent;
          border-radius: 999px;
          animation: directory-picker-v2-spinner 650ms linear infinite;
          opacity: 0.78;
        }
        button[data-type="item"][data-directory-picker-error="true"] > [data-item-section="label"]::after {
          content: " · failed";
          color: var(--v2-text-text-muted);
        }
        [data-file-tree-virtualized-scroll] {
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
      `,
      onExpansionChange(change) {
        if (change.expanded) {
          expandedPaths.add(change.path)
          void load(change.path, navigation, true, true)
          return
        }
        expandedPaths.delete(change.path)
      },
      onSelectionChange(paths) {
        const path = paths.at(-1)
        setSelected(path ? policy.selection(root(), path) ?? "" : "")
      },
    })
    if (!container) return
    tree.render({ containerWrapper: container })
    tree.getFileTreeContainer()?.classList.add("directory-picker-v2-tree")
  })

  createEffect(() => {
    const path = start()
    if (!path || root()) return
    void navigate(path)
  })

  onCleanup(() => {
    if (loadingSyncFrame !== undefined) cancelAnimationFrame(loadingSyncFrame)
    tree?.cleanUp()
  })

  return (
    <Dialog size="large" class="directory-picker-v2">
      <DialogHeader>
        <DialogTitle>{props.title ?? language.t("command.project.open")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="directory-picker-v2-body pt-4!">
        <div class="directory-picker-v2-location">
          <div class="directory-picker-v2-breadcrumbs" aria-label="Current folder">
            <Show when={breadcrumbs().length > 0} fallback={<span class="directory-picker-v2-location-empty">—</span>}>
              <For each={breadcrumbs()}>
                {(crumb, index) => (
                  <>
                    <Show when={index() > 0}>
                      <span class="directory-picker-v2-crumb-separator">›</span>
                    </Show>
                    <button
                      type="button"
                      class="directory-picker-v2-crumb"
                      data-current={index() === breadcrumbs().length - 1 ? "" : undefined}
                      title={crumb.path}
                      onClick={() => {
                        if (index() !== breadcrumbs().length - 1) void navigate(crumb.path)
                      }}
                    >
                      {crumb.label}
                    </button>
                  </>
                )}
              </For>
            </Show>
          </div>
          <div class="directory-picker-v2-location-actions">
            <Show when={!showIgnored() && ignoredCount() > 0}>
              <span class="directory-picker-v2-ignored-note">{ignoredCount()} hidden</span>
            </Show>
            <button
              type="button"
              class="directory-picker-v2-ignored-toggle"
              aria-pressed={showIgnored()}
              onClick={toggleIgnored}
            >
              {showIgnored() ? "Hide ignored" : ignoredCount() > 0 ? `Show ${ignoredCount()} ignored` : "Show ignored"}
            </button>
          </div>
        </div>
        <div class="directory-picker-v2-path" ref={pathArea}>
          <TextInputV2
            value={input()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            placeholder="Type a path or search folders…"
            aria-label="Path or folder search"
            class="!w-full"
            onInput={(event) => {
              setInput(cleanPickerInput(event.currentTarget.value))
              setSelected("")
              setSuggestionsOpen(true)
              setActiveSuggestion(-1)
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen()}
            aria-controls="directory-picker-v2-suggestions"
            aria-activedescendant={activeSuggestion() >= 0 ? `directory-picker-v2-suggestion-${activeSuggestion()}` : undefined}
            onKeyDown={handleInputKey}
          />
          <div class="directory-picker-v2-actions">
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(home())}>~</ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(pickerRoot(root()) || root())}>
              {language.t("dialog.directory.root")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => void navigate(pickerParent(root()))}>
              {language.t("dialog.directory.parent")}
            </ButtonV2>
          </div>
          <Show when={suggestionsOpen() && (suggestions.loading || currentSuggestions().length > 0)}>
            <div
              id="directory-picker-v2-suggestions"
              role="listbox"
              class="directory-picker-v2-suggestions"
              aria-busy={suggestions.loading}
            >
              <Show when={suggestions.loading && currentSuggestions().length === 0}>
                <div role="status" class="directory-picker-v2-suggestions-state">
                  {language.t("common.loading")}
                </div>
              </Show>
              <For each={currentSuggestions()}>
                {(suggestion, index) => (
                  <button
                    id={`directory-picker-v2-suggestion-${index()}`}
                    role="option"
                    aria-selected={index() === activeSuggestion()}
                    data-active={index() === activeSuggestion() ? "" : undefined}
                    onPointerMove={() => setActiveSuggestion(index())}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    {displayPickerPath(suggestion.absolute, input(), home())}
                    {suggestion.type === "directory" ? "/" : ""}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <div
          class="directory-picker-v2-browser"
          ref={container}
          aria-busy={loading()}
          onWheel={(event) => {
            const scroller = treeScroller()
            if (!scroller) return
            const next = nextTreeScrollTop(scroller.scrollTop, event.deltaY, scroller.scrollHeight, scroller.clientHeight)
            if (next === scroller.scrollTop) return
            event.preventDefault()
            scroller.scrollTop = next
            scroller.dispatchEvent(new Event("scroll"))
          }}
        >
          <Show when={loading()}><div class="directory-picker-v2-state">{language.t("common.loading")}</div></Show>
          <Show when={!loading() && error()}>
            <div class="directory-picker-v2-state">{language.t("dialog.directory.readError")}</div>
          </Show>
        </div>
        <div class="directory-picker-v2-selection" title={selectionPath()}>
          <span class="directory-picker-v2-selection-label">Selected:</span>
          <span class="directory-picker-v2-selection-value">{selectionPath()}</span>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>{language.t("common.cancel")}</ButtonV2>
        <ButtonV2 variant="contrast" disabled={!selectionPath()} onClick={resolve}>
          {action[policy.action]}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
