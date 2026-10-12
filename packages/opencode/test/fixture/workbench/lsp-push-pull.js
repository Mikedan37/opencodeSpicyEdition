// Fake language server that reports the same error by push (on open) and by pull (textDocument/diagnostic).
let buffer = Buffer.alloc(0)

const error = {
  range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
  severity: 1,
  code: "E100",
  codeDescription: { href: "https://example.com/E100" },
  source: "fake",
  message: "planted error",
}

function send(message) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...message })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`)
}

function handle(data) {
  if (data.method === "initialize")
    return send({ id: data.id, result: { capabilities: { textDocumentSync: 1, diagnosticProvider: {} } } })
  if (data.method === "textDocument/didOpen")
    return send({
      method: "textDocument/publishDiagnostics",
      params: { uri: data.params.textDocument.uri, diagnostics: [error] },
    })
  if (data.method === "textDocument/diagnostic") return send({ id: data.id, result: { kind: "full", items: [error] } })
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
