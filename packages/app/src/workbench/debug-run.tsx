import { createMemo, createSignal, Match, Show, Switch, untrack } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { isLive, programOutput } from "./debug"
import { useDebug } from "./debug-context"
import { DebugToolbar, SessionPicker, sessionLabel } from "./debug-ui"
import { OutputText } from "./output-panel"
import { useWorkbench } from "./panel"
import { PanelState, PLAY_GLYPH, Glyph, TONE_CLASS } from "./ui"

// Bottom panel Run tab: the terminal of the selected session's program when the adapter ran it in one
// (DebugSessionInfo.ptyID). It stays after the program exits, with the exit code from pty.exited. The /pty routes do
// not attach to an exited PTY, so a tab that was not attached when the program ended replays the debugger's copy of
// its output instead.
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
                  {(ptyID) => {
                    const saved = debug.terminals.get(ptyID)
                    const ended = () => exit() !== undefined
                    // Mounted while the program ran: still attached when it ends, so it holds all of the output.
                    const early = !untrack(ended)
                    const [replay, setReplay] = createSignal(!early && !saved?.whole)
                    const sessionID = untrack(() => session()!.id)
                    return (
                      <Show when={!replay()} fallback={<RunReplay sessionID={sessionID} />}>
                        <div class="relative min-h-0 flex-1" data-run-pty={ptyID}>
                          <div class="absolute inset-0">
                            <Terminal
                              pty={{
                                ...saved,
                                id: ptyID,
                                title: session() ? sessionLabel(session()!) : ptyID,
                                titleNumber: 0,
                              }}
                              class="!px-[14px]"
                              onCleanup={(pty) => {
                                if (!replay())
                                  debug.terminals.set(ptyID, { ...pty, whole: saved?.whole || (early && ended()) })
                              }}
                              // The PTY is gone (the program ended while nothing was attached, e.g. before a reload).
                              onConnectError={() => saved?.whole || setReplay(true)}
                            />
                          </div>
                        </div>
                      </Show>
                    )
                  }}
                </Show>
              </>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}

function RunReplay(props: { sessionID: string }) {
  const debug = useDebug()
  const language = useLanguage()
  void debug.backlog(props.sessionID)
  const console = () => debug.state.consoles[props.sessionID]
  const output = createMemo(() => programOutput(console()))
  return (
    <div data-run-replay class="flex min-h-0 flex-1 flex-col">
      <Switch
        fallback={
          <PanelState
            icon={<Glyph path={PLAY_GLYPH} />}
            title={language.t(console()?.backlog === "ready" ? "workbench.run.empty" : "workbench.run.gone.title")}
            description={console()?.backlog === "ready" ? undefined : language.t("workbench.run.gone.description")}
          />
        }
      >
        <Match when={output().text}>
          <div class="shrink-0 px-[14px] pt-2 text-[11px] text-v2-text-text-faint">
            {language.t("workbench.run.replay")}
            <Show when={output().dropped}>
              {(count) => <div>{language.plural("workbench.debug.console.dropped", count())}</div>}
            </Show>
          </div>
          <OutputText
            text={output().text}
            base={debug.absolute(".")}
            label={language.t("workbench.run.replay.label")}
            class="min-h-0 flex-1 px-1.5 py-2"
          />
        </Match>
        <Match when={console()?.backlog === "loading" || console()?.backlog === "idle"}>
          <PanelState
            icon={<LoaderV2 width={16} height={16} />}
            title={language.t("workbench.debug.console.loading")}
          />
        </Match>
      </Switch>
    </div>
  )
}
