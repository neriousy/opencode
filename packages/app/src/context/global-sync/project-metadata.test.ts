import { describe, expect, test } from "bun:test"
import { hasProjectMeta, projectMetadataPatch } from "./project-metadata"

const project = {
  id: "project-id",
  worktree: "/tmp/project",
  time: { created: 1, updated: 1 },
  sandboxes: [],
}

describe("project metadata migration", () => {
  test("builds a patch from client metadata for missing server fields", () => {
    expect(
      projectMetadataPatch(
        project,
        {
          name: "Client name",
          icon: { color: "mint", override: "data:image/png;base64,client" },
          commands: { start: "bun dev" },
        },
        undefined,
      ),
    ).toEqual({
      name: "Client name",
      icon: { color: "mint", override: "data:image/png;base64,client" },
      commands: { start: "bun dev" },
    })
  })

  test("does not overwrite server metadata", () => {
    expect(
      projectMetadataPatch(
        {
          ...project,
          name: "Server name",
          icon: { color: "pink", override: "data:image/png;base64,server" },
          commands: { start: "bun start" },
        },
        {
          name: "Client name",
          icon: { color: "mint", override: "data:image/png;base64,client" },
          commands: { start: "bun dev" },
        },
        undefined,
      ),
    ).toBeUndefined()
  })

  test("uses the legacy icon cache as a fallback override", () => {
    expect(projectMetadataPatch(project, undefined, "data:image/png;base64,cache")).toEqual({
      icon: { override: "data:image/png;base64,cache" },
    })
  })

  test("detects stored project metadata", () => {
    expect(hasProjectMeta(undefined)).toBe(false)
    expect(hasProjectMeta({})).toBe(false)
    expect(hasProjectMeta({ commands: { start: "bun dev" } })).toBe(true)
  })
})
