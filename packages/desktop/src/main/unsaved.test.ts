import { describe, expect, test } from "bun:test"
import { unsavedDecision, unsavedPrompt } from "./unsaved"

describe("unsaved editor edits", () => {
  test("the dialog's first button lets the page go; Cancel keeps it and stops a quit in progress", () => {
    expect(unsavedDecision({ response: 0, quitting: true })).toEqual({ allowUnload: true, cancelQuit: false })
    expect(unsavedDecision({ response: 1, quitting: true })).toEqual({ allowUnload: false, cancelQuit: true })
    expect(unsavedDecision({ response: 1, quitting: false })).toEqual({ allowUnload: false, cancelQuit: false })
    expect(unsavedDecision({ response: 0, quitting: false })).toEqual({ allowUnload: true, cancelQuit: false })
  })

  test("the test hook answers without a dialog", () => {
    expect(unsavedDecision({ answer: "discard", quitting: true })).toEqual({ allowUnload: true, cancelQuit: false })
    expect(unsavedDecision({ answer: "cancel", quitting: true })).toEqual({ allowUnload: false, cancelQuit: true })
    // Anything else keeps the page: losing edits takes an explicit answer.
    expect(unsavedDecision({ answer: "yes", response: 0, quitting: false })).toEqual({
      allowUnload: false,
      cancelQuit: false,
    })
  })

  test("Cancel is the default and the escape answer; the first button names what happens", () => {
    const quit = unsavedPrompt(true)
    expect(quit.buttons).toEqual(["Quit anyway", "Cancel"])
    expect([quit.defaultId, quit.cancelId]).toEqual([1, 1])
    expect(unsavedPrompt(false).buttons).toEqual(["Discard changes", "Cancel"])
  })
})
