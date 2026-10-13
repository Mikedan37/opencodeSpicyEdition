import type { DoctorProbe } from "./client"

// What fixes a tool the doctor did not find or could not run. The doctor's own reason wins when it names a command
// in parentheses (lldb-dap blocked by Developer Mode: "sudo DevToolsSecurity -enable").
// ponytail: one install command per tool, the common one; a per-platform table when people hit the gaps.
const INSTALL: Record<string, string> = {
  pyright: "npm install -g pyright",
  ty: "pip install ty",
  ruff: "pip install ruff",
  mypy: "pip install mypy",
  pytest: "pip install pytest",
  debugpy: "pip install debugpy",
  python3: "brew install python",
  "typescript-language-server": "npm install -g typescript-language-server typescript",
  tsc: "npm install --save-dev typescript",
  "bun test": "curl -fsSL https://bun.sh/install | bash",
  "js-debug": "code --install-extension ms-vscode.js-debug",
  "rust-analyzer": "rustup component add rust-analyzer",
  "cargo check": "curl https://sh.rustup.rs -sSf | sh",
  "cargo test": "curl https://sh.rustup.rs -sSf | sh",
  gopls: "go install golang.org/x/tools/gopls@latest",
  dlv: "go install github.com/go-delve/delve/cmd/dlv@latest",
  "go vet": "brew install go",
  "go test": "brew install go",
  clangd: "brew install llvm",
  clang: "xcode-select --install",
  swiftc: "xcode-select --install",
  "swift test": "xcode-select --install",
  "sourcekit-lsp": "xcode-select --install",
  "lldb-dap": "xcode-select --install",
}

export function fixCommand(probe: DoctorProbe) {
  if (probe.status === "ok") return
  const named = probe.reason?.match(/\(((?:sudo|npm|pip|brew|xcode-select|rustup|go) [^)]+)\)/)?.[1]
  return named ?? INSTALL[probe.tool]
}
