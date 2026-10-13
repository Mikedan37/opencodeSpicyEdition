import { createEffect, on, onCleanup, onMount } from "solid-js"
import { Compartment, EditorState } from "@codemirror/state"
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { HIGHLIGHT, loadLanguage, THEME } from "./codemirror"

// A file's text in the editor's look, read-only unless `onChange` is given. `path` picks the language. A read-only view
// follows `source`; an editable one starts from it and reports every change.
export function CodeView(props: {
  source: string
  path: string
  label: string
  onChange?: (text: string) => void
  class?: string
}) {
  const theme = useTheme()
  const language = new Compartment()
  const dark = new Compartment()
  const editable = !!props.onChange
  let host!: HTMLDivElement

  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.source,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          syntaxHighlighting(HIGHLIGHT),
          THEME,
          language.of([]),
          dark.of(EditorView.darkTheme.of(theme.mode() === "dark")),
          EditorView.contentAttributes.of({ "aria-label": props.label }),
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
          editable
            ? [
                history(),
                drawSelection(),
                indentOnInput(),
                bracketMatching(),
                keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
                EditorView.updateListener.of((update) => {
                  if (update.docChanged) props.onChange?.(update.state.doc.toString())
                }),
              ]
            : [],
        ],
      }),
    })
    let alive = true
    void loadLanguage(props.path).then(
      (extension) => alive && extension && view.dispatch({ effects: language.reconfigure(extension) }),
    )
    createEffect(
      on(
        () => props.source,
        (source) => {
          if (editable || source === view.state.doc.toString()) return
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } })
        },
        { defer: true },
      ),
    )
    createEffect(() => {
      view.dispatch({ effects: dark.reconfigure(EditorView.darkTheme.of(theme.mode() === "dark")) })
    })
    onCleanup(() => {
      alive = false
      view.destroy()
    })
  })

  return <div ref={host} data-component="code-view" class={props.class} />
}
