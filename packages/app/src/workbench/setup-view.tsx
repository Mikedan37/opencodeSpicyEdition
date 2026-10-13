import { createMemo, createResource, For, Match, Show, Switch } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { createWorkbenchClient, errorText, type DoctorProbe, type DoctorReport } from "./client"
import { fixCommand } from "./setup"

const AREAS = ["lsp", "check", "test", "debug"] as const
const MARK = { ok: "✓", missing: "✗", broken: "✗", blocked: "✗" } as const

// Settings → IDE setup (UX audit #8): GET /workbench/doctor for the open project as languages × language server,
// checks, tests and debugger, each tool ✓ or ✗ with why and the command that fixes it. Nothing is installed here.
export function SettingsWorkbench(props: { directory: () => string | undefined }) {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const client = createMemo(() => {
    const directory = props.directory()
    if (!directory) return
    return createWorkbenchClient({ server: serverSDK().server.http, directory, fetch: platform.fetch })
  })
  const [report, { refetch }] = createResource(client, (current) => current.doctor())

  return (
    <>
      <div class="settings-v2-tab-header flex items-center justify-between gap-3">
        <h2 class="settings-v2-tab-title">{language.t("workbench.setup.title")}</h2>
        <Show when={client()}>
          <ButtonV2
            size="small"
            variant="neutral"
            data-action="setup-recheck"
            disabled={report.loading}
            onClick={() => void refetch()}
          >
            <Show when={report.loading}>
              <LoaderV2 width={12} height={12} />
            </Show>
            {language.t("workbench.setup.recheck")}
          </ButtonV2>
        </Show>
      </div>
      <div data-component="workbench-setup" class="settings-v2-tab-body flex flex-col gap-3 pb-6">
        <p class="text-[13px] leading-5 text-v2-text-text-muted">{language.t("workbench.setup.description")}</p>
        <Switch>
          <Match when={!client()}>
            <p class="text-[13px] text-v2-text-text-muted">{language.t("workbench.setup.noProject")}</p>
          </Match>
          <Match when={report.error}>
            <p role="alert" class="text-[13px] text-v2-state-fg-danger">
              {language.t("workbench.setup.failed", { error: errorText(report.error) })}
            </p>
          </Match>
          <Match when={report.latest}>{(value) => <Grid report={value()} />}</Match>
          <Match when={true}>
            <div class="flex items-center gap-2 text-[13px] text-v2-text-text-muted">
              <LoaderV2 width={12} height={12} />
              {language.t("workbench.setup.loading")}
            </div>
          </Match>
        </Switch>
      </div>
    </>
  )
}

function Grid(props: { report: DoctorReport }) {
  const language = useLanguage()
  return (
    <table class="w-full table-fixed border-collapse text-[12px]">
      <thead>
        <tr class="text-left text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted">
          <th scope="col" class="w-24 py-1.5 pr-3 font-[530]">
            {language.t("workbench.setup.column.language")}
          </th>
          <For each={AREAS}>
            {(area) => (
              <th scope="col" class="py-1.5 pr-3 font-[530]">
                {language.t(`workbench.setup.column.${area}`)}
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.report.languages}>
          {(entry) => (
            <tr data-language={entry.id} class="border-t border-v2-border-border-muted align-top">
              <th scope="row" class="py-2 pr-3 text-left text-[13px] font-[530] text-v2-text-text-base">
                {entry.name}
              </th>
              <For each={AREAS}>
                {(area) => (
                  <td data-area={area} class="py-2 pr-3">
                    <div class="flex flex-col gap-1.5">
                      <Show when={area === "lsp" && !entry.lsp.enabled}>
                        <Line
                          ok={false}
                          label={language.t("workbench.setup.lspOff", { server: entry.lsp.server })}
                          detail={entry.lsp.reason}
                          command={'"lsp": true'}
                        />
                      </Show>
                      <For
                        each={entry.probes.filter((probe) => probe.area === area)}
                        fallback={
                          <Show when={area !== "lsp" || entry.lsp.enabled}>
                            <span class="text-v2-text-text-muted">{language.t("workbench.setup.none")}</span>
                          </Show>
                        }
                      >
                        {(probe) => <ProbeLine probe={probe} />}
                      </For>
                    </div>
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

function ProbeLine(props: { probe: DoctorProbe }) {
  const language = useLanguage()
  return (
    <Line
      ok={props.probe.status === "ok"}
      status={props.probe.status}
      label={label(props.probe)}
      detail={
        props.probe.status === "ok"
          ? undefined
          : [language.t(`workbench.setup.status.${props.probe.status}`), props.probe.reason].filter(Boolean).join(": ")
      }
      command={fixCommand(props.probe)}
    />
  )
}

// "ruff 0.6.2", not "ruff ruff 0.6.2": versions often start with the tool's own name.
function label(probe: DoctorProbe) {
  const version = probe.status === "ok" ? probe.version : undefined
  if (!version) return probe.tool
  return version.toLowerCase().startsWith(probe.tool.toLowerCase().split(" ")[0]!)
    ? version
    : `${probe.tool} ${version}`
}

function Line(props: {
  ok: boolean
  status?: DoctorProbe["status"]
  label: string
  detail?: string
  command?: string
}) {
  const language = useLanguage()
  const copy = (command: string) =>
    navigator.clipboard.writeText(command).then(
      () => showToast({ variant: "success", title: language.t("workbench.setup.copied", { command }) }),
      (error: unknown) =>
        showToast({ variant: "error", title: language.t("workbench.setup.copyFailed"), description: errorText(error) }),
    )
  return (
    <div data-probe={props.label} data-status={props.status ?? (props.ok ? "ok" : "off")} class="flex flex-col gap-1">
      <span class="flex min-w-0 items-start gap-1.5">
        <span
          aria-hidden="true"
          class="shrink-0 font-[530]"
          classList={{ "text-[var(--spicy-fg-success)]": props.ok, "text-v2-state-fg-danger": !props.ok }}
        >
          {props.ok ? MARK.ok : MARK.missing}
        </span>
        <span class="sr-only">{language.t(props.ok ? "workbench.setup.ready" : "workbench.setup.notReady")}</span>
        <span class="min-w-0 break-words text-v2-text-text-base">{props.label}</span>
      </span>
      <Show when={props.detail}>
        <span class="break-words pl-4 text-[11px] leading-4 text-v2-text-text-muted">{props.detail}</span>
      </Show>
      <Show when={props.command}>
        {(command) => (
          <span class="flex min-w-0 flex-col items-start gap-0.5 pl-4">
            <code class="max-w-full break-all rounded-[4px] bg-v2-background-bg-layer-02 px-1.5 py-0.5 font-mono text-[11px] text-v2-text-text-base">
              {command()}
            </code>
            <ButtonV2
              size="small"
              variant="ghost"
              data-action="setup-copy"
              aria-label={language.t("workbench.setup.copy", { command: command() })}
              onClick={() => void copy(command())}
            >
              {language.t("workbench.setup.copyShort")}
            </ButtonV2>
          </span>
        )}
      </Show>
    </div>
  )
}
