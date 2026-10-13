import { For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { resolveFileDiff } from "@opencode-ai/session-ui/session-diff"
import { shortPath } from "./snapshot"

// One entry per file of a unified diff: git's (`diff --git`) or jsdiff's (`Index:`), named after its `+++` header
// (else `---`, else the `Index:` line). A diff with neither marker is one file.
export function splitPatch(diff: string) {
  const lines = diff.split("\n")
  const starts = lines.flatMap((line, index) =>
    line.startsWith("diff --git ") || line.startsWith("Index: ") ? [index] : [],
  )
  const chunks = (starts.length ? starts : [0]).map((start, index, all) =>
    lines.slice(start, all[index + 1] ?? lines.length).join("\n"),
  )
  return chunks
    .filter((chunk) => chunk.trim())
    .map((patch) => ({ file: fileName(patch), patch: patch.endsWith("\n") ? patch : patch + "\n" }))
}

function fileName(patch: string) {
  const header = (prefix: string) =>
    patch
      .split("\n")
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .split("\t")[0]
      ?.trim()
  const name = [header("+++ "), header("--- "), header("Index: ")].find((item) => item && item !== "/dev/null")
  return name?.replace(/^[ab]\//, "") ?? ""
}

// A unified diff drawn with the timeline's diff view, file by file; names inside `root` are shown relative to it.
export function PatchView(props: { diff: string; class?: string; root?: string }) {
  const fileComponent = useFileComponent()
  const name = (file: string) => (props.root ? shortPath(props.root, file) : file)
  return (
    <div data-component="patch-view" class={`flex flex-col gap-2 ${props.class ?? ""}`}>
      <For each={splitPatch(props.diff)}>
        {(entry) => (
          <div data-patch-file={entry.file} class="min-w-0">
            <Show when={entry.file}>
              <div class="truncate pb-0.5 font-mono text-[11px] text-v2-text-text-muted" title={entry.file}>
                {name(entry.file)}
              </div>
            </Show>
            <Dynamic
              component={fileComponent}
              mode="diff"
              fileDiff={resolveFileDiff({ file: entry.file || "diff", patch: entry.patch })}
              hunkSeparators="simple"
              diffStyle="unified"
            />
          </div>
        )}
      </For>
    </div>
  )
}
