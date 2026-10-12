// Shared redaction for everything the Workbench shows the model or the UI:
// debugger values, console rows, program output and evidence excerpts.

const MASK = "[REDACTED]"

// Matched against a lowercased name with separators removed, so apiKey, API_KEY
// and x-api-key all hit. "author" is the one common false positive of "auth".
const SECRET_NAME = /password|passwd|secret|token|apikey|auth(?!or)|authorization|cookie|privatekey|credential/

const SECRET_VALUE = [
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, // PEM blocks
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic/Stripe style secret keys
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT
]

export function secretName(name: string) {
  return SECRET_NAME.test(name.toLowerCase().replace(/[-_\s.]/g, ""))
}

export function text(input: string) {
  return SECRET_VALUE.reduce((result, pattern) => result.replace(pattern, MASK), input)
}

/** Redacts a named value: the whole value when the name looks secret, known secret shapes otherwise. */
export function value(name: string, input: string) {
  return secretName(name) ? MASK : text(input)
}

/** Deep copy with secret-named fields masked and secret-shaped strings replaced. */
export function deep(input: unknown, name = ""): unknown {
  if (typeof input === "string") return value(name, input)
  if (Array.isArray(input)) return input.map((item) => deep(item, name))
  if (typeof input !== "object" || input === null) return input
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, secretName(key) ? MASK : deep(item, key)]))
}

export * as Redact from "./redact"
