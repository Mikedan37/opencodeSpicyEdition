// Fake language server for the IDE editor's code intelligence. It knows the root's *.nav files (open documents as the
// client last sent them, full sync) and answers about the identifier at a position: hover names it, its definition is
// the `def <name>` line in any file (else its first occurrence in the document), references are every whole-word
// occurrence. Completion offers every word of the root's files plus a `helper(${1:arg})` snippet; rename replaces every
// whole-word occurrence (renaming `outsider` would also edit a file outside the project); formatting trims trailing
// spaces. `printf` is defined outside the project; nothing is known about `nothing`. FAKE_LSP_LOG names a file
// (relative to its cwd, the root) that records every method it receives.
const { appendFileSync, readdirSync, readFileSync } = require("fs")
const path = require("path")
const { fileURLToPath, pathToFileURL } = require("url")
let buffer = Buffer.alloc(0)
let root
const open = new Map()

function send(message) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...message })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`)
}

function documents() {
  const all = new Map(
    readdirSync(root)
      .filter((name) => name.endsWith(".nav"))
      .map((name) => [pathToFileURL(path.join(root, name)).href, readFileSync(path.join(root, name), "utf8")]),
  )
  for (const [uri, text] of open) all.set(uri, text)
  return all
}

function wordAt(text, position) {
  const line = text.split("\n")[position.line] ?? ""
  for (const match of line.matchAll(/[A-Za-z_]\w*/g))
    if (match.index <= position.character && position.character <= match.index + match[0].length)
      return {
        word: match[0],
        range: {
          start: { line: position.line, character: match.index },
          end: { line: position.line, character: match.index + match[0].length },
        },
      }
}

function occurrences(all, word, pattern = `\\b${word}\\b`) {
  return [...all].flatMap(([uri, text]) =>
    text.split("\n").flatMap((line, number) =>
      [...line.matchAll(new RegExp(pattern, "g"))].map((match) => {
        const character = match.index + match[0].length - word.length
        return {
          uri,
          range: { start: { line: number, character }, end: { line: number, character: character + word.length } },
        }
      }),
    ),
  )
}

function handle(data) {
  if (process.env.FAKE_LSP_LOG && data.method) appendFileSync(process.env.FAKE_LSP_LOG, data.method + "\n")
  const params = data.params ?? {}
  if (data.method === "initialize") {
    root = fileURLToPath(params.rootUri)
    return send({ id: data.id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true } } })
  }
  if (data.method === "textDocument/didOpen") return open.set(params.textDocument.uri, params.textDocument.text)
  if (data.method === "textDocument/didChange")
    return open.set(params.textDocument.uri, params.contentChanges.at(-1).text)
  const all = root ? documents() : new Map()
  const here = params.textDocument ? all.get(params.textDocument.uri) : undefined
  const found = here !== undefined && params.position ? wordAt(here, params.position) : undefined
  const known = found && found.word !== "nothing" ? found : undefined
  if (data.method === "textDocument/hover")
    return send({
      id: data.id,
      result: known
        ? { contents: { kind: "markdown", value: `**${known.word}**: \`fake type\`` }, range: known.range }
        : null,
    })
  if (data.method === "textDocument/definition") {
    if (!known) return send({ id: data.id, result: null })
    if (known.word === "printf")
      return send({
        id: data.id,
        result: [
          {
            uri: "file:///usr/include/fake-stdio.h",
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
          },
        ],
      })
    const def = occurrences(all, known.word, `\\bdef ${known.word}\\b`)[0]
    const first = occurrences(new Map([[params.textDocument.uri, here]]), known.word)[0]
    return send({ id: data.id, result: def ?? first })
  }
  if (data.method === "textDocument/references")
    return send({ id: data.id, result: known ? occurrences(all, known.word) : [] })
  if (data.method === "textDocument/completion") {
    const words = [...new Set([...all.values()].flatMap((text) => text.match(/[A-Za-z_]\w*/g) ?? []))]
    const items = [
      ...words.map((word) => ({ label: word, kind: 6 })),
      { label: "helper", kind: 3, detail: "fn helper(arg)", insertText: "helper(${1:arg})", insertTextFormat: 2 },
    ]
    return send({ id: data.id, result: { isIncomplete: false, items } })
  }
  if (data.method === "textDocument/rename") {
    if (!known) return send({ id: data.id, result: null })
    const changes = Map.groupBy(occurrences(all, known.word), (item) => item.uri)
    const edits = Object.fromEntries(
      [...changes].map(([uri, items]) => [uri, items.map((item) => ({ range: item.range, newText: params.newName }))]),
    )
    if (known.word === "outsider") edits["file:///usr/include/fake-stdio.h"] = []
    return send({ id: data.id, result: { changes: edits } })
  }
  if (data.method === "textDocument/formatting")
    return send({
      id: data.id,
      result: (here ?? "").split("\n").flatMap((line, number) => {
        const trimmed = line.trimEnd()
        return trimmed === line
          ? []
          : [
              {
                range: {
                  start: { line: number, character: trimmed.length },
                  end: { line: number, character: line.length },
                },
                newText: "",
              },
            ]
      }),
    })
  if (data.method === "exit") process.exit(0)
  if (data.id !== undefined && data.method) send({ id: data.id, result: null })
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end === -1) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? 0)
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
