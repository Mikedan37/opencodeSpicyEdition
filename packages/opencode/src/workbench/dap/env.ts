// spicy: every process the debugger starts (adapters, the debugged program in its terminal, the project's own Python
// and build) gets this process's environment without the opencode server's credentials, as Agent HQ's agents do
// (AgentProvider.agentEnv). Everything else passes through, provider keys included: a program under debug can need
// its own keys, and the human launched it.
import { AgentProvider } from "@/agenthq/provider"

/** The variables left out: what AgentProvider.agentEnv drops from this process's environment. */
export function credentials() {
  const kept = AgentProvider.agentEnv()
  return Object.keys(process.env).filter((key) => !(key in kept))
}

/** For Process.spawn/text/run, which add this process's environment back: an undefined value unsets a variable. */
export function child(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(credentials().map((key) => [key, undefined])), ...env }
}

export * as DebugEnv from "./env"
