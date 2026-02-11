import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"

export function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export function dirSlug(directory) {
  return base64Url(directory)
}

export function sessionPath(directory, sessionID) {
  const slug = dirSlug(directory)
  return `/${slug}/session${sessionID ? `/${sessionID}` : ""}`
}

export async function createTestProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-desktop-e2e-project-"))

  await fs.writeFile(path.join(root, "README.md"), "# e2e\n")

  execSync("git init", { cwd: root, stdio: "ignore" })
  execSync("git add -A", { cwd: root, stdio: "ignore" })
  execSync('git -c user.name="e2e" -c user.email="e2e@example.com" commit -m "init" --allow-empty', {
    cwd: root,
    stdio: "ignore",
  })

  return root
}

export async function cleanupTestProject(directory) {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
}
