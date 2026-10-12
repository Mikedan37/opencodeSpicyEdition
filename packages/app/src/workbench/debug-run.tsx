import { Match, Show, Switch } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { isLive } from "./debug"
import { useDebug } from "./debug-context"
import { DebugToolbar, SessionPicker, sessionLabel } from "./debug-ui"
import { useWorkbench } from "./panel"
import { PanelState, PLAY_GLYPH, Glyph, TONE_CLASS } from "./ui"

// Bottom panel Run tab: the terminal of the selected session's program when the adapter ran it in one
// (DebugSessionInfo.ptyID). It stays after the program exits, with the exit code from pty.exited.
export default function DebugRunPanel() {
  const debug = useDebug()
  const workbench = useWorkbench()
  const language = useLanguage()
  const session = () => debug.selected()
  return (
    <div data-component="workbench-run" class="flex min-h-0 flex-1 flex-col">
      <Switch>
        <Match when={!session()}>
          <PanelState
            icon={<Glyph path={PLAY_GLYPH} />}
            title={language.t("workbench.run.title")}
            description={language.t("workbench.run.description")}
          >
            <ButtonV2 size="small" variant="neutral" onClick={() => debug.openStart()}>
              {language.t("workbench.debug.action.start")}
            </ButtonV2>
          </PanelState>
        </Match>
        <Match when={!session()?.ptyID}>
          <div class="flex h-10 shrink-0 items-center gap-2 px-2">
            <DebugToolbar />
            <span class="mx-1 h-4 w-px shrink-0 bg-v2-border-border-muted" />
            <SessionPicker />
          </div>
          <PanelState
            icon={<Glyph path={PLAY_GLYPH} />}
            title={language.t("workbench.run.internal.title")}
            description={language.t("workbench.run.internal.description")}
          >
            <ButtonV2 size="small" variant="neutral" onClick={() => workbench.open("debug")}>
              {language.t("workbench.run.showConsole")}
            </ButtonV2>
          </PanelState>
        </Match>
        <Match when={session()?.ptyID}>
          {(id) => {
            const exit = () => debug.state.exits[id()]
            const status = () => {
              const code = exit()
              if (code !== undefined)
                return {
                  text: language.t("workbench.run.exited", { code }),
                  tone: code ? "danger" : "neutral",
                } as const
              const current = session()
              if (current && isLive(current))
                return { text: language.t(`workbench.debug.state.${current.state}`), tone: "success" } as const
              return { text: language.t("workbench.debug.state.terminated"), tone: "neutral" } as const
            }
            return (
              <>
                <div class="flex h-10 shrink-0 items-center gap-2 px-2">
                  <DebugToolbar />
                  <span class="mx-1 h-4 w-px shrink-0 bg-v2-border-border-muted" />
                  <SessionPicker />
                  <span class="flex-1" />
                  <span
                    data-slot="run-status"
                    class={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-[530] ${TONE_CLASS[status().tone]}`}
                  >
                    {status().text}
                  </span>
                </div>
                <Show when={id()} keyed>
                  {(ptyID) => (
                    <div class="relative min-h-0 flex-1" data-run-pty={ptyID}>
                      <div class="absolute inset-0">
                        <Terminal
                          pty={{
                            ...debug.terminals.get(ptyID),
                            id: ptyID,
                            title: session() ? sessionLabel(session()!) : ptyID,
                            titleNumber: 0,
                          }}
                          class="!px-[14px]"
                          onCleanup={(pty) => debug.terminals.set(ptyID, pty)}
                          // The program's PTY can be gone after it exits; what was shown stays.
                          onConnectError={() => undefined}
                        />
                      </div>
                    </div>
                  )}
                </Show>
              </>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}
