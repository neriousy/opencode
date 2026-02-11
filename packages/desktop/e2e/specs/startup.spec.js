import assert from "node:assert/strict"

import { seedStorage, gotoSession } from "../actions.js"
import { cleanupTestProject, createTestProject, dirSlug } from "../utils.js"

describe("desktop", () => {
  it("starts and opens a session", async function () {
    this.timeout(180_000)

    const directory = await createTestProject()

    try {
      await seedStorage(directory)
      await browser.refresh()
      await gotoSession(directory)

      const pathname = await browser.execute(() => window.location.pathname)
      assert.equal(typeof pathname, "string")
      assert.match(pathname, new RegExp(`^/${dirSlug(directory)}/session(?:/|$)`))
    } finally {
      await cleanupTestProject(directory)
    }
  })
})
