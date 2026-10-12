import { describe, expect, test } from "bun:test"
import path from "path"
import { WorkbenchCheckers } from "@/workbench/verify/checkers"
import { WorkbenchParse } from "@/workbench/verify/parse"
import { tmpdir } from "../fixture/fixture"
import { write, zoo } from "../fixture/workbench/zoo"

// VER-01 / VER-13: outputs captured from the installed tools (macOS arm64, 2026-10-12) with the exact commands the
// checkers plan, on the bug zoo in test/fixture/workbench/zoo.ts. Paths under the capture root read /ROOT.
type Golden = { command: string[]; cwd: string; exitCode: number; stdout: string; stderr: string; report?: string }

const golden = (name: string) =>
  Bun.file(path.join(__dirname, "../fixture/workbench/golden", `${name}.json`)).json() as Promise<Golden>

const parse = async (name: string, parser: (output: WorkbenchParse.Output) => unknown[]) => {
  const item = await golden(name)
  return parser({
    stdout: WorkbenchParse.stripAnsi(item.stdout),
    stderr: WorkbenchParse.stripAnsi(item.stderr),
    exitCode: item.exitCode,
    cwd: item.cwd,
    report: item.report,
  })
}

const at = (line: number, character: number, endLine = line, endCharacter = character) => ({
  start: { line, character },
  end: { line: endLine, character: endCharacter },
})

describe("VER-01 parser golden files", () => {
  test("clang SARIF keeps rule ids and ranges", async () => {
    expect(await parse("clang-sarif", WorkbenchParse.clang)).toEqual([
      {
        file: "/ROOT/c/main.c",
        range: at(1, 11, 1, 12),
        severity: "error",
        message: "incompatible integer to pointer conversion initializing 'int *' with an expression of type 'int'",
        code: "ext_typecheck_convert_int_pointer",
      },
      {
        file: "/ROOT/c/main.c",
        range: at(2, 9, 2, 19),
        severity: "error",
        message: "use of undeclared identifier 'undeclared'",
        code: "err_undeclared_var_use",
      },
    ])
  })

  test("clang link failure becomes a build error with a stable message", async () => {
    const problems = await parse("clang-link", WorkbenchParse.clang)
    expect(problems).toEqual([
      {
        kind: "build",
        severity: "error",
        code: "link",
        message: [
          "Undefined symbols for architecture arm64:",
          '  "_helper", referenced from:',
          "      _main in main.o",
          "ld: symbol(s) not found for architecture arm64",
          "clang: error: linker command failed with exit code 1 (use -v to see invocation)",
        ].join("\n"),
      },
    ])
  })

  test("the same file passes -fsyntax-only, which is why folders with main() are linked", async () => {
    expect((await golden("clang-link-syntax")).exitCode).toBe(0)
    expect(await parse("clang-link-syntax", WorkbenchParse.clang)).toEqual([])
  })

  test("tsc text", async () => {
    expect(await parse("tsc", WorkbenchParse.tsc)).toEqual([
      {
        file: "/ROOT/ts/src/index.ts",
        range: at(0, 13),
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        code: "TS2322",
      },
      {
        file: "/ROOT/ts/src/index.ts",
        range: at(1, 21),
        severity: "error",
        message: "Cannot find name 'missingName'.",
        code: "TS2304",
      },
    ])
  })

  test("swiftc -typecheck text ignores the source excerpt", async () => {
    expect(await parse("swiftc", WorkbenchParse.swift)).toEqual([
      {
        file: "/ROOT/swift/main.swift",
        range: at(0, 17),
        severity: "error",
        message: "cannot convert value of type 'String' to specified type 'Int'",
      },
    ])
  })

  test("swift build text, with and without color codes", async () => {
    const expected = [
      {
        file: "/ROOT/swiftpm/Sources/app/main.swift",
        range: at(0, 17),
        severity: "error",
        message: "cannot convert value of type 'String' to specified type 'Int'",
      },
    ]
    expect(await parse("swift-build", WorkbenchParse.swift)).toEqual(expected)
    // captured without NO_COLOR: swift build colors its output even through a pipe
    expect((await golden("swift-build-color")).stderr).toContain("\u001b[1;31merror: ")
    expect(await parse("swift-build-color", WorkbenchParse.swift)).toEqual(expected)
  })

  test("cargo JSON keeps the error code, primary label and secondary spans", async () => {
    expect(await parse("cargo", WorkbenchParse.cargo)).toEqual([
      {
        file: "/ROOT/rust/src/main.rs",
        range: at(1, 21, 1, 26),
        severity: "error",
        message: "mismatched types: expected `i32`, found `&str`",
        code: "E0308",
        related: [{ file: "/ROOT/rust/src/main.rs", range: at(1, 15, 1, 18), message: "expected due to this" }],
      },
    ])
  })

  test("go build -json", async () => {
    expect(await parse("go-build", WorkbenchParse.goBuild)).toEqual([
      {
        file: "/ROOT/go/main.go",
        range: at(5, 17),
        severity: "error",
        message: 'cannot use "one" (untyped string constant) as int value in variable declaration',
      },
    ])
  })

  test("go vet text", async () => {
    expect(await parse("go-vet", WorkbenchParse.goVet)).toEqual([
      {
        file: "/ROOT/govet/main.go",
        range: at(6, 13),
        severity: "error",
        message: "fmt.Printf format %d has arg name of wrong type string",
      },
    ])
  })

  test("ruff JSON: undefined names are errors", async () => {
    expect(await parse("ruff", WorkbenchParse.ruff)).toEqual([
      {
        file: "/ROOT/py/app.py",
        range: at(5, 6, 5, 18),
        severity: "error",
        message: "Undefined name `missing_name`",
        code: "F821",
        codeHref: "https://docs.astral.sh/ruff/rules/undefined-name",
      },
    ])
  })

  test("mypy JSON: 0-based columns", async () => {
    expect(await parse("mypy", WorkbenchParse.mypy)).toEqual([
      {
        file: "/ROOT/py/app.py",
        range: at(4, 13),
        severity: "error",
        message: 'Argument 1 to "double" has incompatible type "str"; expected "int"',
        code: "arg-type",
      },
      {
        file: "/ROOT/py/app.py",
        range: at(5, 6),
        severity: "error",
        message: 'Name "missing_name" is not defined',
        code: "name-defined",
      },
    ])
  })

  // VER-13: failing tests parse to the test name, file and line.
  const runner = (id: string) => WorkbenchCheckers.all.find((checker) => checker.id === id)!.parse

  test("go test -json: failing assertions", async () => {
    expect(await parse("go-test", runner("go-test"))).toEqual([
      {
        kind: "test",
        file: "/ROOT/go-test/avg_test.go",
        range: at(6, 0),
        severity: "error",
        message: "TestAverage: Average = 3, want 4",
        code: "TestAverage",
      },
      {
        kind: "test",
        file: "/ROOT/go-test/avg_test.go",
        range: at(12, 0),
        severity: "error",
        message: "TestEmpty: Average(nil) = -1, want 0",
        code: "TestEmpty",
      },
    ])
  })

  // Captured from an earlier version of the fixture whose TestEmpty panicked (a Go runtime panic exits normally,
  // without a crash report). It is parser input only: no test runs it any more.
  test("go test -json: a panic points at the first frame in the package", async () => {
    expect(await parse("go-test-panic", runner("go-test"))).toEqual([
      {
        kind: "test",
        file: "/ROOT/go-test/avg_test.go",
        range: at(6, 0),
        severity: "error",
        message: "TestAverage: Average = 3, want 4",
        code: "TestAverage",
      },
      {
        kind: "test",
        file: "/ROOT/go-test/avg.go",
        range: at(7, 0),
        severity: "error",
        message: "TestEmpty: panic: runtime error: integer divide by zero [recovered, repanicked]",
        code: "TestEmpty",
      },
    ])
  })

  test("node --test JUnit: location from the stack", async () => {
    expect(await parse("node-test", runner("node-test"))).toEqual([
      {
        kind: "test",
        file: "/ROOT/node-test/avg.test.mjs",
        range: at(6, 9),
        severity: "error",
        message: "average of empty list: Expected values to be strictly equal:NaN !== 0",
        code: "average of empty list",
      },
    ])
  })

  test("bun test JUnit", async () => {
    expect(await parse("bun-test", runner("bun-test"))).toEqual([
      {
        kind: "test",
        file: "/ROOT/bun-test/avg.test.ts",
        range: at(5, 22),
        severity: "error",
        message: "average of empty list: expect(received).toBe(expected)\nExpected: 0\nReceived: NaN",
        code: "average of empty list",
      },
    ])
  })

  test("cargo test: location of the failing assertion", async () => {
    expect(await parse("cargo-test", runner("cargo-test"))).toEqual([
      {
        kind: "test",
        file: "/ROOT/cargo-test/src/lib.rs",
        range: at(10, 8),
        severity: "error",
        message: "tests::average_of_two: assertion `left == right` failed",
        code: "tests::average_of_two",
      },
    ])
  })

  // VER-14: pytest --junitxml and swift test --parallel --xunit-output (reports read from the run's report directory)
  test("pytest JUnit: the innermost traceback line in the project", async () => {
    expect(await parse("pytest", WorkbenchParse.pytest)).toEqual([
      {
        kind: "test",
        file: "/ROOT/pytest/test_avg.py",
        range: at(4, 0),
        severity: "error",
        message: "test_average: assert 3.0 == 4\n+  where 3.0 = average([2, 4])",
        code: "test_avg::test_average",
      },
      {
        kind: "test",
        file: "/ROOT/pytest/avg.py",
        range: at(1, 0),
        severity: "error",
        message: "test_empty: ZeroDivisionError: division by zero",
        code: "test_avg::test_empty",
      },
    ])
  })

  test("swift test: xUnit names the failures, the console says where", async () => {
    const item = await golden("swift-test")
    // XCTest results reach xUnit only with --parallel; neither report carries a location
    expect(item.command).toContain("--parallel")
    expect(item.report).toContain('<failure message="failure"></failure>')
    // swift-testing prints a bare file name, so the parser looks it up in the package: use a real copy
    await using tmp = await tmpdir()
    await write(path.join(tmp.path, "swift-test"), zoo["swift-test"])
    const real = (text: string) => text.replaceAll("/ROOT", tmp.path)
    const problems = WorkbenchParse.swiftTest({
      stdout: real(item.stdout),
      stderr: real(item.stderr),
      exitCode: item.exitCode,
      cwd: real(item.cwd),
      report: real(item.report ?? ""),
    })
    expect(problems).toEqual([
      {
        kind: "test",
        file: path.join(tmp.path, "swift-test/Tests/AvgTests/AvgSwiftTesting.swift"),
        range: at(4, 2),
        severity: "error",
        message: "emptyList(): Expectation failed: average([]) == 1",
        code: "emptyList()",
      },
      {
        kind: "test",
        file: path.join(tmp.path, "swift-test/Tests/AvgTests/AvgTests.swift"),
        range: at(5, 0),
        severity: "error",
        message: 'testAverage: XCTAssertEqual failed: ("3") is not equal to ("4")',
        code: "testAverage",
      },
    ])
  })
})
