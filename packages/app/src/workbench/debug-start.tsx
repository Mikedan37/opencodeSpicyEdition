import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { errorText } from "./client"
import { guessAdapter, launchConfigurations, splitArgs } from "./debug"
import { useDebug } from "./debug-context"
import { useWorkbench } from "./panel"

const PROGRAM = ""

// Starts a program under the debugger: a file in the project or a .vscode/launch.json configuration. Server errors
// (no Python, debugpy missing, Developer Mode off) are shown as the server words them.
export function DebugStartDialog(props: { file?: string }) {
  const debug = useDebug()
  const workbench = useWorkbench()
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const [draft, setDraft] = createStore({
    configuration: PROGRAM,
    configurations: [] as { name: string; type?: string }[],
    program: props.file?.endsWith(".py") ? props.file : "",
    args: "",
    stopOnEntry: false,
    starting: false,
    error: "",
  })

  void sdk()
    .client.file.read({ path: ".vscode/launch.json" })
    .then((result) => {
      const configurations = launchConfigurations(result.data?.content ?? "")
      setDraft("configurations", configurations)
      if (configurations.length && !draft.program) setDraft("configuration", configurations[0]!.name)
    })
    .catch(() => undefined)

  const config = () => draft.configurations.find((item) => item.name === draft.configuration)
  const valid = () => !!config() || !!draft.program.trim()

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!valid() || draft.starting) return
    const chosen = config()
    const program = draft.program.trim()
    const exceptions = debug.prefs.exceptions[guessAdapter(chosen ? { type: chosen.type ?? "" } : { program })]
    const args = splitArgs(draft.args)
    setDraft({ starting: true, error: "" })
    debug
      .start({
        ...(chosen ? { configuration: chosen.name } : { program }),
        ...(args.length ? { args } : {}),
        ...(draft.stopOnEntry ? { stopOnEntry: true } : {}),
        ...(exceptions ? { exceptions } : {}),
        ...(props.file ? { file: props.file } : {}),
      })
      .then(
        () => {
          dialog.close()
          workbench.show("console")
        },
        (error: unknown) => setDraft({ starting: false, error: errorText(error) }),
      )
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents" data-component="debug-start-dialog">
        <DialogHeader>
          <DialogTitle>{language.t("workbench.debug.start.title")}</DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex w-[min(480px,calc(100vw-48px))] flex-col gap-5 px-4 pt-4 pb-1">
          <Show when={draft.configurations.length}>
            <Field>
              <Field.Label>{language.t("workbench.debug.start.what")}</Field.Label>
              <select
                name="configuration"
                class="h-8 w-full rounded-[6px] bg-v2-background-bg-layer-01 px-2 text-[13px] text-v2-text-text-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
                value={draft.configuration}
                onChange={(event) => setDraft("configuration", event.currentTarget.value)}
              >
                <option value={PROGRAM}>{language.t("workbench.debug.start.program")}</option>
                <For each={draft.configurations}>
                  {(item) => (
                    <option value={item.name}>{language.t("workbench.debug.start.configuration", item)}</option>
                  )}
                </For>
              </select>
            </Field>
          </Show>
          <Show when={!config()}>
            <Field>
              <Field.Label>{language.t("workbench.debug.start.program")}</Field.Label>
              <TextInputV2
                autofocus
                class="!w-full [&_input]:font-mono"
                name="program"
                spellcheck={false}
                placeholder="src/main.py"
                value={draft.program}
                onInput={(event) => setDraft("program", event.currentTarget.value)}
              />
            </Field>
            <Field>
              <Field.Label>{language.t("workbench.debug.start.args")}</Field.Label>
              <TextInputV2
                class="!w-full [&_input]:font-mono"
                name="args"
                spellcheck={false}
                placeholder="--verbose input.txt"
                value={draft.args}
                onInput={(event) => setDraft("args", event.currentTarget.value)}
              />
            </Field>
          </Show>
          <CheckboxV2
            label={language.t("workbench.debug.start.stopOnEntry")}
            checked={draft.stopOnEntry}
            onChange={(value: boolean) => setDraft("stopOnEntry", value)}
          />
          <Show when={draft.error}>
            <div
              role="alert"
              data-slot="debug-start-error"
              class="select-text whitespace-pre-wrap break-words rounded-[6px] bg-v2-state-bg-danger px-3 py-2 font-mono text-[12px] leading-[18px] text-v2-state-fg-danger"
            >
              {draft.error}
            </div>
          </Show>
        </DialogBody>
        <DialogFooter>
          <span class="flex-1" />
          <ButtonV2 type="button" variant="neutral" disabled={draft.starting} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={!valid() || draft.starting}>
            {draft.starting ? language.t("workbench.debug.start.starting") : language.t("workbench.debug.start.submit")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
