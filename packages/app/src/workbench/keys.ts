// Fork command ids with keybinds.
export const DEBUG_KEYS = {
  continue: "debug.continue",
  pause: "debug.pause",
  next: "debug.stepOver",
  stepIn: "debug.stepInto",
  stepOut: "debug.stepOut",
  stop: "debug.stop",
  toggleBreakpoint: "debug.toggleBreakpoint",
  show: "debug.show",
} as const

export const EDITOR_KEYS = {
  save: "workbench.editor.save",
} as const

// Fork commands whose keys also fire while typing, like an IDE's run keys. context/command.tsx spreads this list into
// EDITABLE_KEYBIND_IDS, so later fork keys are added here, not there.
export const SPICY_EDITABLE_KEYBIND_IDS = [
  DEBUG_KEYS.continue,
  DEBUG_KEYS.pause,
  DEBUG_KEYS.next,
  DEBUG_KEYS.stepIn,
  DEBUG_KEYS.stepOut,
  DEBUG_KEYS.stop,
  DEBUG_KEYS.toggleBreakpoint,
  DEBUG_KEYS.show,
]
