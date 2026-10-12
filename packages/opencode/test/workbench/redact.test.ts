import { describe, expect, test } from "bun:test"
import { Redact } from "../../src/workbench/redact"

describe("workbench redaction (SEC-03 unit)", () => {
  test("secret-looking names", () => {
    const secret = [
      "password",
      "db_password",
      "api_key",
      "apiKey",
      "X-API-KEY",
      "authToken",
      "AUTHORIZATION",
      "cookie",
      "private_key",
      "client_secret",
      "GITHUB_TOKEN",
    ]
    const plain = ["author", "name", "xs", "total", "orders", "path"]
    expect(secret.filter((name) => !Redact.secretName(name))).toEqual([])
    expect(plain.filter(Redact.secretName)).toEqual([])
  })

  test("secret-shaped values", () => {
    const input = [
      "aws AKIAABCDEFGHIJKLMNOP",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "slack xoxb-1234567890-abcdefghij",
      "key sk-live-0123456789abcdefghijkl",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "pem -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY----- after",
    ].join("\n")
    expect(Redact.text(input)).toBe(
      [
        "aws [REDACTED]",
        "gh [REDACTED]",
        "slack [REDACTED]",
        "key [REDACTED]",
        "jwt [REDACTED]",
        "pem [REDACTED] after",
      ].join("\n"),
    )
    expect(Redact.text("alice 15.0 sk-short")).toBe("alice 15.0 sk-short")
  })

  test("named values and nested data", () => {
    expect(Redact.value("api_key", "'anything'")).toBe("[REDACTED]")
    expect(Redact.value("note", "'uses sk-live-0123456789abcdefghijkl'")).toBe("'uses [REDACTED]'")
    expect(Redact.deep({ user: "ada", auth: { token: "t" }, list: ["AKIAABCDEFGHIJKLMNOP"] })).toEqual({
      user: "ada",
      auth: "[REDACTED]",
      list: ["[REDACTED]"],
    })
  })
})
