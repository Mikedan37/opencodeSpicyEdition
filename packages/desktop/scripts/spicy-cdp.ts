// spicy: a minimal Chrome DevTools Protocol client for driving the desktop renderer from scripts/spicy-smoke.ts.
// Elements are found by selectors (data attributes, roles, element types); visible text only where an element has
// nothing else to go by (menu items, plain buttons).

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

// Input.dispatchKeyEvent modifier bits.
export const ALT = 1
export const CTRL = 2
export const META = 4
export const SHIFT = 8

// A page expression for the element a selector names. " >>> " steps into the shadow root of the element before it
// (pierre renders file lines in one), and the first visible match wins, so hidden tabs that stay mounted are skipped.
export function query(selector: string, text?: string) {
  return `((selector, text) => {
    const found = selector.split(" >>> ").reduce(
      (scopes, part) => scopes.flatMap((scope) => [...(scope.shadowRoot ?? scope).querySelectorAll(part)]),
      [document],
    ).filter((el) => text === undefined || el.textContent.includes(text))
    return found.find((el) => el.getClientRects().length > 0) ?? found[0] ?? null
  })(${JSON.stringify(selector)}, ${JSON.stringify(text)})`
}

export async function connectRenderer(port: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((res) => res.json() as Promise<{ type: string; url: string; webSocketDebuggerUrl?: string }[]>)
      .catch(() => [])
    // The app window: oc://renderer when built or packaged, the Vite dev server in dev mode.
    const page = targets.find(
      (target) => target.type === "page" && target.webSocketDebuggerUrl && !target.url.startsWith("devtools://"),
    )
    if (page?.webSocketDebuggerUrl) return connect(page.webSocketDebuggerUrl)
    if (Date.now() > deadline) throw new Error(`no renderer page on DevTools port ${port}`)
    await Bun.sleep(250)
  }
}

async function connect(url: string) {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`cannot open ${url}`))
  })
  let next = 0
  const pending = new Map<number, Pending>()
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }
  ws.onclose = () => pending.forEach((waiter) => waiter.reject(new Error("DevTools connection closed")))

  const send = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const result = await send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    )
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? `evaluate failed: ${expression}`)
    return result.result.value as T
  }

  const waitFor = async <T = unknown>(expression: string, label: string, timeoutMs = 30_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const value = await evaluate<T>(expression).catch(() => undefined)
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await Bun.sleep(100)
    }
  }

  // A real mouse click at the centre of the element `target` evaluates to (pointer events included), after scrolling it
  // into view. Waits until the element exists, is enabled and has a size.
  const clickOn = async (target: string, label: string) => {
    const box = await waitFor<{ x: number; y: number }>(
      `(() => {
        const el = ${target}
        if (!el || el.disabled) return null
        el.scrollIntoView({ block: "center", inline: "center" })
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })()`,
      label,
    )
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 })
  }

  // `text` narrows the selector to elements whose text contains it.
  const click = (selector: string, text?: string) =>
    clickOn(query(selector, text), `clickable ${selector}${text === undefined ? "" : ` with "${text}"`}`)

  // Focus a field and insert text as the keyboard would (input events fire).
  const type = async (selector: string, text: string) => {
    await waitFor(
      `(() => { const el = ${query(selector)}; el?.focus(); return !!el && document.activeElement === el })()`,
      `focus ${selector}`,
    )
    await send("Input.insertText", { text })
  }

  // A keyboard shortcut, e.g. press("`", { code: "Backquote", keyCode: 192, modifiers: CTRL }).
  const press = async (key: string, options: { code: string; keyCode: number; modifiers?: number }) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code: options.code,
        windowsVirtualKeyCode: options.keyCode,
        nativeVirtualKeyCode: options.keyCode,
        modifiers: options.modifiers ?? 0,
      })
  }

  const screenshot = async (file: string) => {
    const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write(file, Buffer.from(shot.data, "base64"))
    return file
  }

  await send("Page.enable")
  await send("Runtime.enable")
  return { send, evaluate, waitFor, click, clickOn, type, press, screenshot, close: () => ws.close() }
}

export type Renderer = Awaited<ReturnType<typeof connect>>
