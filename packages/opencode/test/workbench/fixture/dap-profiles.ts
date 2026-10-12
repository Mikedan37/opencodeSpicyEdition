// Capability lists captured from the real adapters on 2026-10-11 (lldb-dap LLVM 21, debugpy 1.8.20).

export const lldbDap = {
  capabilities: [
    "supportTerminateDebuggee",
    "supportsBreakpointLocationsRequest",
    "supportsCancelRequest",
    "supportsCompletionsRequest",
    "supportsConditionalBreakpoints",
    "supportsConfigurationDoneRequest",
    "supportsDataBreakpoints",
    "supportsDelayedStackTraceLoading",
    "supportsDisassembleRequest",
    "supportsEvaluateForHovers",
    "supportsExceptionFilterOptions",
    "supportsExceptionInfoRequest",
    "supportsFunctionBreakpoints",
    "supportsHitConditionalBreakpoints",
    "supportsInstructionBreakpoints",
    "supportsLogPoints",
    "supportsModulesRequest",
    "supportsReadMemoryRequest",
    "supportsSetVariable",
    "supportsSteppingGranularity",
    "supportsValueFormattingOptions",
    "supportsWriteMemoryRequest",
  ],
  filters: ["cpp_catch", "cpp_throw", "objc_catch", "objc_throw", "swift_catch", "swift_throw"],
}

export const debugpy = {
  capabilities: [
    "supportsClipboardContext",
    "supportsCompletionsRequest",
    "supportsConditionalBreakpoints",
    "supportsConfigurationDoneRequest",
    "supportsDebuggerProperties",
    "supportsDelayedStackTraceLoading",
    "supportsEvaluateForHovers",
    "supportsExceptionInfoRequest",
    "supportsExceptionOptions",
    "supportsFunctionBreakpoints",
    "supportsGotoTargetsRequest",
    "supportsHitConditionalBreakpoints",
    "supportsLogPoints",
    "supportsModulesRequest",
    "supportsSetExpression",
    "supportsSetVariable",
    "supportsStepInTargetsRequest",
    "supportsTerminateDebuggee",
    "supportsTerminateRequest",
    "supportsValueFormattingOptions",
  ],
  filters: ["raised", "uncaught", "userUnhandled"],
}

export const profiles = { "lldb-dap": lldbDap, debugpy }
