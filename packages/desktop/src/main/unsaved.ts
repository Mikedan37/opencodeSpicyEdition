// spicy: unsaved edits in the IDE editor. While a buffer is dirty the renderer's beforeunload handler keeps the page
// (packages/app/src/workbench/editor.ts `guardUnload`). Electron then asks nobody: it emits will-prevent-unload and
// keeps the page, so a reload, a window close or a quit silently does not happen. windows.ts asks with this dialog.
// Save all is left out: it would need the renderer to save first; Cancel, then Cmd+S, does that.

// The dialog for a window whose page blocked its unload (English only, like the editor's own strings).
export function unsavedPrompt(quitting: boolean) {
  return {
    type: "warning" as const,
    message: "You have unsaved changes",
    detail: "Edits in the editor that are not saved will be lost.",
    buttons: [quitting ? "Quit anyway" : "Discard changes", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

// `answer`: the test hook (OPENCODE_SPICY_UNSAVED_ANSWER=discard|cancel), which replaces the dialog so an automated run
// never shows one; else `response`, the dialog's button index. Discarding lets the page unload; cancelling keeps it,
// and a quit in progress stops (its windows stay, and so does the sidecar).
export function unsavedDecision(input: { answer?: string; response?: number; quitting: boolean }) {
  const discard = input.answer ? input.answer === "discard" : input.response === 0
  return { allowUnload: discard, cancelQuit: !discard && input.quitting }
}
