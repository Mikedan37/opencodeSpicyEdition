import { createContext, createRoot, For, onCleanup, useContext, type ParentProps } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useCommand } from "@/context/command"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { tabCloseGuards, useLayout } from "@/context/layout"
import { useSessionKey } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { createEditorStore, guardUnload } from "./editor"
import { EDITOR_KEYS } from "./keys"
import { useWorkbench } from "./panel"

type Choice<T extends string> = { id: T; label: string; variant: "neutral" | "ghost" | "danger" }

function createEditor() {
  const workbench = useWorkbench()
  const file = useFile()
  const dialog = useDialog()
  const language = useLanguage()
  const command = useCommand()
  const layout = useLayout()
  const { sessionKey } = useSessionKey()
  const store = createEditorStore(workbench.client)
  guardUnload(store.anyDirty, window)

  // Resolves with the chosen action, or undefined when the dialog is dismissed.
  const ask = <T extends string>(input: { title: string; description: string; choices: Choice<T>[] }) =>
    new Promise<T | undefined>((resolve) => {
      const pick = (choice?: T) => {
        resolve(choice)
        if (choice) dialog.close()
      }
      dialog.show(
        () => (
          <DialogV2 fit>
            <DialogHeader hideClose>
              <DialogTitleGroup title={input.title} description={input.description} />
            </DialogHeader>
            <DialogFooter>
              <For each={input.choices}>
                {(choice) => (
                  <ButtonV2 variant={choice.variant} data-choice={choice.id} onClick={() => pick(choice.id)}>
                    {choice.label}
                  </ButtonV2>
                )}
              </For>
            </DialogFooter>
          </DialogV2>
        ),
        () => resolve(undefined),
      )
    })

  // A refused save (the file changed on disk) shows in the editor's conflict bar; other failures here.
  const save = (path: string, content: string) =>
    store.save(path, content).catch((error: unknown) => {
      showToast({
        variant: "error",
        title: language.t("workbench.editor.saveFailed", { file: getFilename(path) }),
        description: errorText(error),
      })
      return undefined
    })

  // Closing a tab whose file has unsaved edits asks first: Save, Don't save, or keep the tab.
  const guard = (tab: string, close: () => void) => {
    const path = file.pathFromTab(tab)
    if (!path) return true
    // Nothing unsaved: the buffer goes with the tab.
    if (!store.dirty(path)) {
      store.discard(path)
      return true
    }
    void ask({
      title: language.t("workbench.editor.close.title", { file: getFilename(path) }),
      description: language.t("workbench.editor.close.description"),
      choices: [
        { id: "cancel", label: language.t("common.cancel"), variant: "ghost" },
        { id: "discard", label: language.t("workbench.editor.close.discard"), variant: "ghost" },
        { id: "save", label: language.t("workbench.editor.close.save"), variant: "neutral" },
      ],
    }).then(async (choice) => {
      if (choice === "discard") {
        store.discard(path)
        return close()
      }
      const text = store.text(path)
      if (choice !== "save" || text === undefined) return
      if ((await save(path, text)) !== "saved") return
      store.discard(path)
      close()
    })
    return false
  }
  tabCloseGuards.add(guard)
  onCleanup(() => tabCloseGuards.delete(guard))

  // Cmd+S saves the side panel's active file tab, wherever the focus is. The tab is read at keypress in a root that is
  // disposed right away, so this provider keeps no per-session memos.
  const activeFile = () =>
    createRoot((dispose) => {
      const tab = layout.tabs(sessionKey()).active()
      dispose()
      return tab ? file.pathFromTab(tab) : undefined
    })
  command.register("editor", () => [
    {
      id: EDITOR_KEYS.save,
      title: language.t("workbench.editor.save"),
      category: language.t("workbench.editor.category"),
      keybind: "mod+s",
      onSelect: () => {
        const path = activeFile()
        const text = path && store.dirty(path) ? store.text(path) : undefined
        if (path && text !== undefined) void save(path, text)
      },
    },
  ])

  return { store, ask, save }
}

export type EditorContextValue = ReturnType<typeof createEditor>
const EditorContext = createContext<EditorContextValue>()

export function EditorProvider(props: ParentProps) {
  return <EditorContext.Provider value={createEditor()}>{props.children}</EditorContext.Provider>
}

export function useEditor() {
  const value = useContext(EditorContext)
  if (!value) throw new Error("Editor context must be used within EditorProvider")
  return value
}

// Shared components (the tab bar) render outside the session page too.
export const useEditorOptional = () => useContext(EditorContext)
