// Bug zoo for the Workbench verification tests. Projects live as strings so the package typecheck and
// repo tooling never see the planted errors; `write` materializes one into a temp directory.
// The golden outputs in ./golden were captured from these exact sources on macOS arm64.
import path from "path"
import fs from "fs/promises"

export const zoo = {
  // Z-TYPE-TS: TS2322 + TS2304
  ts: {
    "tsconfig.json": `{
  "compilerOptions": { "strict": true, "noEmit": true, "target": "es2022", "module": "esnext", "types": [] },
  "include": ["src"]
}
`,
    "src/index.ts": `export const total: number = "zero"
export const label = missingName + 1
`,
  },
  // Z-TYPE-C: int conversion + undeclared identifier
  c: {
    "main.c": `int main(void) {
  int *p = 5;
  return undeclared + *p;
}
`,
  },
  // Z-LINK-C: declared, never defined; -fsyntax-only passes, the link fails
  "link-c": {
    "main.c": `int helper(int x);

int main(void) { return helper(1); }
`,
  },
  swift: {
    "main.swift": `let count: Int = "one"
print(count)
`,
  },
  swiftpm: {
    "Package.swift": `// swift-tools-version:5.9
import PackageDescription

let package = Package(name: "app", targets: [.executableTarget(name: "app", path: "Sources/app")])
`,
    "Sources/app/main.swift": `let count: Int = "one"
print(count)
`,
  },
  rust: {
    "Cargo.toml": `[package]
name = "zoo"
version = "0.1.0"
edition = "2021"
`,
    "src/main.rs": `fn main() {
    let count: i32 = "one";
    println!("{}", count);
}
`,
  },
  go: {
    "go.mod": `module example.com/zoo

go 1.22
`,
    "main.go": `package main

import "fmt"

func main() {
	var count int = "one"
	fmt.Println(count)
}
`,
  },
  govet: {
    "go.mod": `module example.com/vet

go 1.22
`,
    "main.go": `package main

import "fmt"

func main() {
	name := "alice"
	fmt.Printf("%d\\n", name)
}
`,
  },
  py: {
    "app.py": `def double(x: int) -> int:
    return x * 2


print(double("two"))
print(missing_name)
`,
  },
  // Z-MONO: two TS projects, two Go modules and a Cargo workspace, all clean
  mono: {
    "web/tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "types": [] }, "include": ["src"] }
`,
    "web/src/app.ts": `export const app: string = "web"
`,
    "api/tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "types": [] }, "include": ["src"] }
`,
    "api/src/server.ts": `export const port: number = 8080
`,
    "svc-a/go.mod": `module example.com/a

go 1.22
`,
    "svc-a/main.go": `package main

func main() {}
`,
    "svc-b/go.mod": `module example.com/b

go 1.22
`,
    "svc-b/main.go": `package main

func main() {}
`,
    "crates/Cargo.toml": `[workspace]
members = ["one", "two"]
resolver = "2"
`,
    "crates/one/Cargo.toml": `[package]
name = "one"
version = "0.1.0"
edition = "2021"
`,
    "crates/one/src/lib.rs": `pub fn one() -> i32 {
    1
}
`,
    "crates/two/Cargo.toml": `[package]
name = "two"
version = "0.1.0"
edition = "2021"
`,
    "crates/two/src/lib.rs": `pub fn two() -> i32 {
    2
}
`,
  },
  // VER-06: project code runs during the check (a Cargo build script, a SwiftPM plugin)
  "rust-build": {
    "Cargo.toml": `[package]
name = "scripted"
version = "0.1.0"
edition = "2021"
`,
    "build.rs": `fn main() {}
`,
    "src/main.rs": `fn main() {}
`,
  },
  "swiftpm-plugin": {
    "Package.swift": `// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "app",
  targets: [
    .executableTarget(name: "app", path: "Sources/app"),
    .plugin(name: "Gen", capability: .buildTool(), path: "Plugins/Gen"),
  ]
)
`,
    "Sources/app/main.swift": `print("hi")
`,
  },
  // Z-TEST-*: the same averaging bug, failing tests per runner. Executed fixtures fail through ordinary
  // assertions only: nothing aborts, traps or panics on a signal (crash reports, "quit unexpectedly" dialogs).
  "go-test": {
    "go.mod": `module example.com/avg

go 1.22
`,
    "avg.go": `package avg

func Average(xs []int) int {
	if len(xs) == 0 {
		return -1
	}
	total := 0
	for _, x := range xs {
		total += x
	}
	return total / len(xs)
}
`,
    "avg_test.go": `package avg

import "testing"

func TestAverage(t *testing.T) {
	if got := Average([]int{2, 4}); got != 4 {
		t.Errorf("Average = %d, want 4", got)
	}
}

func TestEmpty(t *testing.T) {
	if got := Average(nil); got != 0 {
		t.Fatalf("Average(nil) = %d, want 0", got)
	}
}
`,
  },
  "node-test": {
    "package.json": `{ "name": "avg", "type": "module", "scripts": { "test": "node --test" } }
`,
    "avg.test.mjs": `import { test } from "node:test"
import assert from "node:assert"

const average = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

test("average of empty list", () => {
  assert.strictEqual(average([]), 0)
})
`,
  },
  "bun-test": {
    "package.json": `{ "name": "avg" }
`,
    "bunfig.toml": "",
    "avg.test.ts": `import { expect, test } from "bun:test"

const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

test("average of empty list", () => {
  expect(average([])).toBe(0)
})
`,
  },
  "cargo-test": {
    "Cargo.toml": `[package]
name = "avg"
version = "0.1.0"
edition = "2021"
`,
    "src/lib.rs": `pub fn average(xs: &[i32]) -> i32 {
    xs.iter().sum::<i32>() / xs.len().max(1) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn average_of_two() {
        assert_eq!(average(&[2, 4]), 4);
    }
}
`,
  },
  // VER-14: pytest (JUnit) and swift test (xUnit, one XCTest and one swift-testing failure)
  pytest: {
    "pyproject.toml": `[project]
name = "avg"
version = "0.1.0"
`,
    "avg.py": `def average(xs):
    return sum(xs) / len(xs)
`,
    "test_avg.py": `from avg import average


def test_average():
    assert average([2, 4]) == 4


def test_empty():
    assert average([]) == 0
`,
  },
  "swift-test": {
    "Package.swift": `// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Avg",
  targets: [
    .target(name: "Avg"),
    .testTarget(name: "AvgTests", dependencies: ["Avg"]),
  ]
)
`,
    "Sources/Avg/Avg.swift": `public func average(_ xs: [Int]) -> Int {
  xs.reduce(0, +) / max(xs.count, 1)
}
`,
    "Tests/AvgTests/AvgTests.swift": `import XCTest
@testable import Avg

final class AvgTests: XCTestCase {
  func testAverage() {
    XCTAssertEqual(average([2, 4]), 4)
  }
}
`,
    "Tests/AvgTests/AvgSwiftTesting.swift": `import Testing
@testable import Avg

@Test func emptyList() {
  #expect(average([]) == 1)
}
`,
  },
} satisfies Record<string, Record<string, string>>

export async function write(dir: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([name, text]) => {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await Bun.write(path.join(dir, name), text)
    }),
  )
  return dir
}
