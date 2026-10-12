// spicy: GET/PUT /workbench/file, the IDE editor's reads and saves, against the real server routes.
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")

function client(directory: string) {
  const app = Server.Default().app
  const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
  return {
    read: (file: string) => app.request(`/workbench/file?path=${encodeURIComponent(file)}`, { headers }),
    write: (body: { path: string; content: string; baseHash: string | null }) =>
      app.request("/workbench/file", { method: "PUT", headers, body: JSON.stringify(body) }),
  }
}

describe("workbench file HttpApi", () => {
  test("reads the exact text, saves over the bytes it read, refuses a stale base with 409", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const file = path.join(tmp.path, "app.py")
    // Leading blank line, CRLF, a BOM and a trailing newline all survive the round trip.
    const original = "﻿\r\nprint('hi')\r\n"
    await Bun.write(file, original)
    await fs.chmod(file, 0o755)
    const api = client(tmp.path)

    const read = await api.read("app.py")
    expect(read.status).toBe(200)
    const text = (await read.json()) as { content: string; hash: string }
    expect(text.content).toBe(original)
    expect(text.hash).toBe(sha(await fs.readFile(file)))

    const events: GlobalEvent[] = []
    const listen = (event: GlobalEvent) => events.push(event)
    GlobalBus.on("event", listen)
    // A reader that opened the file before the save keeps the old bytes: the save replaces the file, never rewrites it.
    const held = await fs.open(file)
    try {
      const next = "﻿\r\nprint('bye')\r\n"
      const saved = await api.write({ path: "app.py", content: next, baseHash: text.hash })
      expect(saved.status).toBe(200)
      const written = (await saved.json()) as { hash: string }
      expect(await fs.readFile(file, "utf8")).toBe(next)
      expect(written.hash).toBe(sha(await fs.readFile(file)))
      expect((await held.readFile("utf8")).toString()).toBe(original)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o755)
      expect((await fs.readdir(tmp.path)).filter((name) => name.endsWith(".tmp"))).toEqual([])
      expect(
        events.some(
          (event) => event.payload.type === "file.watcher.updated" && event.payload.properties?.file === file,
        ),
      ).toBe(true)

      // The base the editor holds is now stale: refused, nothing written.
      const stale = await api.write({ path: "app.py", content: "lost\n", baseHash: text.hash })
      expect(stale.status).toBe(409)
      expect(JSON.stringify(await stale.json())).toContain("changed on disk")
      expect(await fs.readFile(file, "utf8")).toBe(next)

      // null base: create only when absent.
      expect((await api.write({ path: "app.py", content: "x\n", baseHash: null })).status).toBe(409)
      const created = await api.write({ path: "new.txt", content: "fresh\n", baseHash: null })
      expect(created.status).toBe(200)
      expect(await fs.readFile(path.join(tmp.path, "new.txt"), "utf8")).toBe("fresh\n")
    } finally {
      await held.close()
      GlobalBus.off("event", listen)
    }
  })

  test("refuses paths outside the project, symlinks resolved, and files it cannot edit", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using outside = await tmpdir()
    const secret = path.join(outside.path, "secret.txt")
    await Bun.write(secret, "secret\n")
    await fs.symlink(secret, path.join(tmp.path, "link.txt"))
    await fs.symlink(outside.path, path.join(tmp.path, "out"))
    await Bun.write(path.join(tmp.path, "real.txt"), "real\n")
    await fs.symlink(path.join(tmp.path, "real.txt"), path.join(tmp.path, "alias.txt"))
    await Bun.write(path.join(tmp.path, "image.bin"), new Uint8Array([0x89, 0x50, 0x00, 0x01]))
    const api = client(tmp.path)
    const base = sha("secret\n")

    for (const file of ["../" + path.basename(outside.path) + "/secret.txt", secret, "link.txt", "out/secret.txt"]) {
      expect((await api.read(file)).status).toBe(403)
      expect((await api.write({ path: file, content: "pwned\n", baseHash: base })).status).toBe(403)
      expect((await api.write({ path: file, content: "pwned\n", baseHash: null })).status).toBe(403)
    }
    expect((await api.write({ path: "out/new.txt", content: "pwned\n", baseHash: null })).status).toBe(403)
    expect(await fs.readFile(secret, "utf8")).toBe("secret\n")
    expect(await fs.readdir(outside.path)).toEqual(["secret.txt"])

    // A symlink inside the project is written through; the link stays a link.
    const alias = (await (await api.read("alias.txt")).json()) as { hash: string }
    expect((await api.write({ path: "alias.txt", content: "edited\n", baseHash: alias.hash })).status).toBe(200)
    expect(await fs.readFile(path.join(tmp.path, "real.txt"), "utf8")).toBe("edited\n")
    expect((await fs.lstat(path.join(tmp.path, "alias.txt"))).isSymbolicLink()).toBe(true)

    expect((await api.read("image.bin")).status).toBe(400)
    expect((await api.read("missing.txt")).status).toBe(404)
    expect((await api.read(".")).status).toBe(400)
    expect((await api.write({ path: "nowhere/new.txt", content: "x\n", baseHash: null })).status).toBe(404)
  })
})
