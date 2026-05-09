import type { Project } from "@opencode-ai/sdk/v2/client"
import type { createChildStoreManager } from "./child-store"
import type { ProjectMeta } from "./types"
import { directoryKey } from "./utils"

export type ProjectMetadataPatch = Partial<Pick<Project, "name" | "icon" | "commands">>

export function projectMetadataPatch(
  project: Project,
  meta: ProjectMeta | undefined,
  iconOverride: string | undefined,
) {
  const override = meta?.icon?.override ?? iconOverride
  const icon = {
    ...project.icon,
    ...(!project.icon?.color && meta?.icon?.color ? { color: meta.icon.color } : {}),
    ...(!project.icon?.override && override ? { override } : {}),
  }
  const commands =
    !project.commands?.start && meta?.commands?.start ? { ...project.commands, start: meta.commands.start } : undefined
  const patch: ProjectMetadataPatch = {
    ...(!project.name && meta?.name ? { name: meta.name } : {}),
    ...(icon.override !== project.icon?.override || icon.color !== project.icon?.color ? { icon } : {}),
    ...(commands ? { commands } : {}),
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

export function hasProjectMeta(meta: ProjectMeta | undefined) {
  return !!meta?.name || !!meta?.icon?.color || !!meta?.icon?.override || !!meta?.commands?.start
}

type UpdateProject = (input: { projectID: string; directory: string } & ProjectMetadataPatch) => Promise<{
  data?: Project
}>

export function createProjectMetadataPromotion(input: {
  children: ReturnType<typeof createChildStoreManager>
  update: UpdateProject
  upsertProject: (project: Project) => void
}) {
  const inflight = new Set<string>()

  function clear(directory: string, meta: ProjectMeta | undefined) {
    if (hasProjectMeta(meta)) input.children.clearProjectMeta(directory)
  }

  function promote(directory: string, project: Project) {
    if (project.id === "global") return

    const key = directoryKey(directory)
    const child = input.children.children[key]
    if (!child) return

    const patch = projectMetadataPatch(project, child[0].projectMeta, child[0].icon)
    if (!patch) {
      clear(directory, child[0].projectMeta)
      return
    }

    const inflightKey = `${project.id}:${key}`
    if (inflight.has(inflightKey)) return
    inflight.add(inflightKey)

    void input
      .update({ projectID: project.id, directory, ...patch })
      .then((result) => {
        if (!result.data) return
        input.upsertProject(result.data)
        clear(directory, child[0].projectMeta)
      })
      .catch(() => {})
      .finally(() => inflight.delete(inflightKey))
  }

  return { promote }
}
