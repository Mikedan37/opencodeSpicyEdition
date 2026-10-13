import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { Workbench } from "@opencode-ai/schema/workbench"
import { AgentAvatar } from "@/agenthq/avatar"
import { useAgentHQ } from "@/agenthq/context"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { showToast } from "@/utils/toast"
import { errorText } from "./client"
import { CodeView } from "./code-view"
import { useEditor } from "./editor-context"
import { useWorkbench } from "./panel"
import { TOOL_TEMPLATE, toolArgs, toolFields, type ToolField } from "./tools"
import { PanelState, RequestErrorState, TONE_CLASS } from "./ui"

type Tool = Workbench.CustomTool
type Status = Workbench.CustomToolStatus

const STATUS_TONE: Record<Status, keyof typeof TONE_CLASS> = {
  draft: "warning",
  enabled: "success",
  disabled: "neutral",
  invalid: "danger",
}
const SECTION = "mb-1 mt-4 text-[11px] font-[530] uppercase tracking-[0.04em] text-v2-text-text-muted"
const INPUT =
  "h-7 rounded-[6px] bg-v2-background-bg-layer-01 px-2 text-[12px] text-v2-text-text-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
const CODE = "overflow-hidden rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]"

const time = (at: number, t: Parameters<typeof getRelativeTime>[1]) => getRelativeTime(new Date(at).toISOString(), t)

function StatusPill(props: { status: Status }) {
  const language = useLanguage()
  return (
    <span
      data-tool-status={props.status}
      class={`inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-[530] ${TONE_CLASS[STATUS_TONE[props.status]]}`}
    >
      {language.t(`workbench.tools.status.${props.status}`)}
    </span>
  )
}

// "You" for the user's own drafts; for an agent's, its Agent HQ identity when the drafting session is one of its
// sessions, else the opencode agent's name.
function Author(props: { by: Workbench.CustomToolAuthor }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const agent = createMemo(() => {
    if (props.by.by !== "agent" || !props.by.sessionID) return
    const session = Object.values(agenthq.state.sessions).find((item) => item.providerSessionID === props.by.sessionID)
    return session && agenthq.state.agents.find((item) => item.id === session.agentID)
  })
  return (
    <Switch fallback={<span class="truncate">{props.by.agent ?? language.t("workbench.tools.by.agent")}</span>}>
      <Match when={props.by.by === "user"}>
        <span class="truncate">{language.t("workbench.tools.by.user")}</span>
      </Match>
      <Match when={agent()}>
        {(value) => (
          <span class="flex min-w-0 items-center gap-1">
            <AgentAvatar avatar={value().avatar} name={value().name} size={14} />
            <span class="truncate">{value().name}</span>
          </span>
        )}
      </Match>
    </Switch>
  )
}

// Bottom panel Tools tab: tools agents or the user drafted (nothing in a draft runs before the user approves it), and
// the created tools, custom_<name>, with their source, arguments, and a test run.
export default function ToolsPanel() {
  const workbench = useWorkbench()
  const language = useLanguage()
  const tools = workbench.tools
  const creating = () => tools.state.creating
  const setCreating = tools.setCreating
  const current = createMemo(() => tools.find(tools.state.selected) ?? tools.groups()[0]?.tools[0])

  return (
    <div data-component="workbench-tools" class="flex min-h-0 flex-1 flex-col">
      <Switch
        fallback={
          <div class="flex min-h-0 flex-1">
            <div class="flex w-[min(340px,38%)] shrink-0 flex-col border-r border-v2-border-border-muted">
              <div class="flex h-9 shrink-0 items-center gap-2 border-b border-v2-border-border-muted px-3">
                <span class="text-[12px] font-[530] text-v2-text-text-base">{language.t("workbench.tools.list")}</span>
                <span class="flex-1" />
                <ButtonV2
                  size="small"
                  variant="neutral"
                  data-action="tool-new"
                  class="shrink-0 whitespace-nowrap"
                  onClick={() => setCreating(true)}
                >
                  {language.t("workbench.tools.new")}
                </ButtonV2>
              </div>
              <nav aria-label={language.t("workbench.tools.list")} class="min-h-0 flex-1 overflow-y-auto pb-2">
                <For each={tools.groups()}>
                  {(group) => (
                    <section data-tool-group={group.status}>
                      <h4 class={`${SECTION} px-3`}>{language.t(`workbench.tools.group.${group.status}`)}</h4>
                      <ul>
                        <For each={group.tools}>
                          {(tool) => (
                            <li>
                              <ToolRow
                                tool={tool}
                                selected={!creating() && tool.name === current()?.name}
                                onSelect={() => {
                                  setCreating(false)
                                  tools.select(tool.name)
                                }}
                              />
                            </li>
                          )}
                        </For>
                      </ul>
                    </section>
                  )}
                </For>
              </nav>
            </div>
            <Switch
              fallback={
                <PanelState
                  title={language.t("workbench.tools.empty.title")}
                  description={language.t("workbench.tools.empty.description")}
                />
              }
            >
              <Match when={creating()}>
                <NewTool
                  onCancel={() => setCreating(false)}
                  onSaved={(tool) => {
                    setCreating(false)
                    tools.select(tool.name)
                  }}
                />
              </Match>
              <Match when={current()} keyed>
                {(tool) => <ToolDetail tool={tool} />}
              </Match>
            </Switch>
          </div>
        }
      >
        <Match when={tools.state.status === "unavailable"}>
          <PanelState title={language.t("workbench.tools.unavailable")} />
        </Match>
        <Match when={tools.state.status === "failed" && tools.state.list.length === 0}>
          <RequestErrorState error={new Error(tools.state.error)} onRetry={() => void tools.load()} />
        </Match>
        <Match when={tools.state.status === "loading" && tools.state.list.length === 0}>
          <PanelState icon={<LoaderV2 />} title={language.t("workbench.tools.loading")} />
        </Match>
      </Switch>
    </div>
  )
}

function ToolRow(props: { tool: Tool; selected: boolean; onSelect: () => void }) {
  const language = useLanguage()
  return (
    <button
      type="button"
      data-tool={props.tool.name}
      aria-current={props.selected ? "true" : undefined}
      class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)]"
      classList={{ "bg-v2-background-bg-layer-02": props.selected }}
      onClick={props.onSelect}
    >
      <span class="flex min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-[12px] font-[530] text-v2-text-text-base">
          {props.tool.name}
        </span>
        <span class="shrink-0 text-[11px] text-v2-text-text-faint">{time(props.tool.updatedAt, language.t)}</span>
      </span>
      <span class="truncate text-[11px] text-v2-text-text-muted" title={props.tool.description}>
        {props.tool.description}
      </span>
      <span class="flex min-w-0 items-center gap-1 text-[11px] text-v2-text-text-faint">
        <Author by={props.tool.createdBy} />
      </span>
    </button>
  )
}

function ToolDetail(props: { tool: Tool }) {
  const workbench = useWorkbench()
  const editor = useEditor()
  const language = useLanguage()
  const tools = workbench.tools
  const busy = () => !!tools.state.busy[props.tool.name]
  const fail = (action: "approve" | "reject" | "enable" | "disable" | "delete") => (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t(`workbench.tools.failed.${action}`),
      description: errorText(error),
    })
  const remove = async () => {
    const choice = await editor.ask({
      title: language.t("workbench.tools.delete.title", { id: props.tool.id }),
      description: language.t("workbench.tools.delete.description"),
      choices: [
        { id: "cancel", label: language.t("common.cancel"), variant: "ghost" },
        { id: "delete", label: language.t("workbench.tools.delete"), variant: "danger" },
      ],
    })
    if (choice === "delete") await tools.delete(props.tool.name).catch(fail("delete"))
  }
  const action = (id: string, label: string, variant: "contrast" | "ghost", onClick: () => void) => (
    <ButtonV2
      size="small"
      variant={variant}
      data-action={`tool-${id}`}
      class="shrink-0 whitespace-nowrap"
      disabled={busy()}
      onClick={onClick}
    >
      {label}
    </ButtonV2>
  )

  return (
    <div
      data-component="workbench-tool"
      data-tool={props.tool.name}
      data-status={props.tool.status}
      class="min-w-0 flex-1 overflow-y-auto px-4 py-3"
    >
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="min-w-0 truncate font-mono text-[14px] font-[530] text-v2-text-text-base">{props.tool.id}</h3>
        <StatusPill status={props.tool.status} />
        <span class="flex-1" />
        <Switch>
          <Match when={props.tool.status === "draft"}>
            {action(
              "approve",
              language.t("workbench.tools.approve"),
              "contrast",
              () => void tools.approve(props.tool).catch(fail("approve")),
            )}
            {action(
              "reject",
              language.t("workbench.tools.reject"),
              "ghost",
              () => void tools.reject(props.tool.name).catch(fail("reject")),
            )}
          </Match>
          <Match when={props.tool.status === "enabled"}>
            {action(
              "disable",
              language.t("workbench.tools.disable"),
              "ghost",
              () => void tools.disable(props.tool.name).catch(fail("disable")),
            )}
            {action("delete", language.t("workbench.tools.delete"), "ghost", () => void remove())}
          </Match>
          <Match when={props.tool.status === "disabled"}>
            {action(
              "enable",
              language.t("workbench.tools.enable"),
              "contrast",
              () => void tools.enable(props.tool).catch(fail("enable")),
            )}
            {action("delete", language.t("workbench.tools.delete"), "ghost", () => void remove())}
          </Match>
          <Match when={props.tool.status === "invalid"}>
            {action("delete", language.t("workbench.tools.delete"), "ghost", () => void remove())}
          </Match>
        </Switch>
      </div>
      <p class="mt-1 select-text text-[12px] leading-[18px] text-v2-text-text-base">{props.tool.description}</p>
      <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-v2-text-text-faint">
        <Author by={props.tool.createdBy} />
        <span>{time(props.tool.updatedAt, language.t)}</span>
        <span class="min-w-0 truncate font-mono" title={props.tool.path}>
          {props.tool.path}
        </span>
      </div>

      <Show when={tools.state.notice[props.tool.name] === "stale"}>
        <div
          role="alert"
          data-slot="tool-stale"
          class="mt-3 rounded-[6px] bg-v2-state-bg-warning px-3 py-2 text-[12px] leading-[18px] text-v2-state-fg-warning"
        >
          {language.t("workbench.tools.stale")}
        </div>
      </Show>
      <Switch>
        <Match when={props.tool.status === "draft"}>
          <p class="mt-3 text-[12px] leading-[18px] text-v2-text-text-muted">
            {language.t("workbench.tools.draft.note", { id: props.tool.id })}
          </p>
        </Match>
        <Match when={props.tool.status === "disabled"}>
          <p class="mt-3 text-[12px] leading-[18px] text-v2-text-text-muted">
            {language.t("workbench.tools.disabled.note")}
          </p>
        </Match>
        <Match when={props.tool.status === "invalid"}>
          <div data-slot="tool-reason" class="mt-3 rounded-[6px] bg-v2-state-bg-danger px-3 py-2">
            <div class="text-[11px] font-[530] text-v2-state-fg-danger">
              {language.t("workbench.tools.invalid.title")}
            </div>
            <div class="select-text whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-v2-state-fg-danger">
              {props.tool.reason}
            </div>
          </div>
        </Match>
      </Switch>

      <h4 class={SECTION}>{language.t("workbench.tools.args")}</h4>
      <Show
        when={props.tool.args.length > 0}
        fallback={<p class="text-[12px] text-v2-text-text-faint">{language.t("workbench.tools.args.none")}</p>}
      >
        <table data-slot="tool-args" class="w-full border-collapse text-left text-[12px]">
          <thead class="text-[11px] text-v2-text-text-muted">
            <tr>
              <th class="py-1 pr-3 font-[530]">{language.t("workbench.tools.args.name")}</th>
              <th class="py-1 pr-3 font-[530]">{language.t("workbench.tools.args.type")}</th>
              <th class="py-1 pr-3 font-[530]">{language.t("workbench.tools.args.required")}</th>
              <th class="py-1 font-[530]">{language.t("workbench.tools.args.description")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.tool.args}>
              {(arg) => (
                <tr class="border-t border-v2-border-border-muted align-top">
                  <td class="py-1 pr-3 font-mono text-v2-text-text-base">{arg.name}</td>
                  <td class="py-1 pr-3 font-mono text-v2-text-text-muted">{arg.type ?? ""}</td>
                  <td class="py-1 pr-3 text-v2-text-text-muted">
                    {language.t(arg.required ? "workbench.tools.args.yes" : "workbench.tools.args.no")}
                  </td>
                  <td class="py-1 text-v2-text-text-base">{arg.description ?? ""}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <Show when={props.tool.status === "enabled"}>
        <TestRun tool={props.tool} />
      </Show>

      <h4 class={SECTION}>{language.t("workbench.tools.source")}</h4>
      <CodeView
        source={props.tool.source}
        path={props.tool.path}
        label={language.t("workbench.tools.source")}
        class={CODE}
      />
    </div>
  )
}

// The test run: a form from the tool's inputSchema; the result is what the agent would see.
function TestRun(props: { tool: Tool }) {
  const workbench = useWorkbench()
  const language = useLanguage()
  const tools = workbench.tools
  const fields = createMemo(() => toolFields(props.tool.inputSchema))
  const [values, setValues] = createStore<Record<string, string | boolean | undefined>>({})
  const [outcome, setOutcome] = createSignal<{ title?: string; output: string; error?: boolean }>()
  const busy = () => tools.state.busy[props.tool.name] === "run"
  const PROBLEM = {
    required: "workbench.tools.run.required",
    number: "workbench.tools.run.number",
    integer: "workbench.tools.run.integer",
    json: "workbench.tools.run.jsonInvalid",
  } as const
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const result = toolArgs(fields(), values, props.tool.inputSchema)
    if ("error" in result)
      return setOutcome({
        output: language.t(PROBLEM[result.error.problem], { field: result.error.field }),
        error: true,
      })
    setOutcome(undefined)
    void tools.run(props.tool.name, result.args).then(
      (value) => value && setOutcome({ title: value.title, output: value.output }),
      (error: unknown) => setOutcome({ output: errorText(error), error: true }),
    )
  }
  const input = (field: ToolField) => (
    <Switch
      fallback={
        <TextInputV2
          class="!w-full"
          name={field.name}
          type={field.kind === "string" ? "text" : "number"}
          step={field.kind === "integer" ? "1" : "any"}
          value={(values[field.name] as string | undefined) ?? ""}
          onInput={(event) => setValues(field.name, event.currentTarget.value)}
        />
      }
    >
      <Match when={field.kind === "boolean"}>
        <CheckboxV2
          label={field.name}
          hideLabel
          checked={values[field.name] === true}
          onChange={(value: boolean) => setValues(field.name, value)}
        />
      </Match>
      <Match when={field.kind === "enum"}>
        <select
          name={field.name}
          class={`${INPUT} w-full`}
          value={(values[field.name] as string | undefined) ?? ""}
          onChange={(event) => setValues(field.name, event.currentTarget.value)}
        >
          <Show when={!field.required}>
            <option value="" />
          </Show>
          <For each={field.options}>{(option) => <option value={option}>{option}</option>}</For>
        </select>
      </Match>
      <Match when={field.kind === "json"}>
        <TextareaV2
          name={field.name}
          rows={3}
          class="!w-full font-mono"
          placeholder={language.t("workbench.tools.run.json")}
          value={(values[field.name] as string | undefined) ?? ""}
          onInput={(event) => setValues(field.name, event.currentTarget.value)}
        />
      </Match>
    </Switch>
  )

  return (
    <form data-slot="tool-run" class="mt-1" onSubmit={submit}>
      <h4 class={SECTION}>{language.t("workbench.tools.run")}</h4>
      <p class="mb-2 text-[12px] text-v2-text-text-muted">{language.t("workbench.tools.run.note")}</p>
      <div class="flex flex-col gap-2">
        <For each={fields()}>
          {(field) => (
            <Field>
              <Field.Label>
                <span class="font-mono">{field.name}</span>
                <Show when={!field.required}>
                  <span class="ml-1.5 text-v2-text-text-faint">{language.t("workbench.tools.run.optional")}</span>
                </Show>
                <Show when={field.description}>
                  <span class="ml-1.5 text-v2-text-text-muted">{field.description}</span>
                </Show>
              </Field.Label>
              {input(field)}
            </Field>
          )}
        </For>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <ButtonV2
          type="submit"
          size="small"
          variant="neutral"
          data-action="tool-run"
          class="shrink-0 whitespace-nowrap"
          disabled={busy()}
        >
          {language.t("workbench.tools.run.submit")}
        </ButtonV2>
        <Show when={busy()}>
          <LoaderV2 width={12} height={12} />
        </Show>
      </div>
      <Show when={outcome()}>
        {(value) => (
          <div
            data-slot="tool-run-result"
            data-error={value().error ? "" : undefined}
            class="mt-2"
            ref={(element) => queueMicrotask(() => element.scrollIntoView({ block: "nearest" }))}
          >
            <Show when={value().title}>
              <div class="mb-1 text-[11px] text-v2-text-text-muted">{value().title}</div>
            </Show>
            <pre
              aria-label={language.t("workbench.tools.run.output")}
              class="max-h-60 select-text overflow-auto whitespace-pre-wrap break-words rounded-[6px] px-3 py-2 font-mono text-[12px] leading-[18px]"
              classList={{
                "bg-v2-state-bg-danger text-v2-state-fg-danger": !!value().error,
                "bg-v2-background-bg-layer-01 text-v2-text-text-base": !value().error,
              }}
            >
              {value().output}
            </pre>
          </div>
        )}
      </Show>
    </form>
  )
}

// The user's own draft: saved like an agent's draft, then reviewed and approved like any other.
function NewTool(props: { onCancel: () => void; onSaved: (tool: Tool) => void }) {
  const workbench = useWorkbench()
  const language = useLanguage()
  const [draft, setDraft] = createStore({ name: "", description: "", source: TOOL_TEMPLATE, saving: false })
  const save = (event: SubmitEvent) => {
    event.preventDefault()
    if (draft.saving) return
    setDraft("saving", true)
    void workbench.tools
      .create({ name: draft.name.trim(), description: draft.description.trim(), source: draft.source })
      .then(props.onSaved, (error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("workbench.tools.failed.create"),
          description: errorText(error),
        }),
      )
      .finally(() => setDraft("saving", false))
  }
  return (
    <form data-component="workbench-tool-new" class="min-w-0 flex-1 overflow-y-auto px-4 py-3" onSubmit={save}>
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-[14px] font-[530] text-v2-text-text-base">{language.t("workbench.tools.new")}</h3>
        <span class="flex-1" />
        <ButtonV2 type="button" size="small" variant="ghost" class="shrink-0" onClick={props.onCancel}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          type="submit"
          size="small"
          variant="contrast"
          data-action="tool-save"
          class="shrink-0 whitespace-nowrap"
          disabled={draft.saving || !draft.name.trim() || !draft.description.trim()}
        >
          {language.t("workbench.tools.form.save")}
        </ButtonV2>
      </div>
      <div class="mt-3 flex flex-col gap-3">
        <Field>
          <Field.Label>{language.t("workbench.tools.form.name")}</Field.Label>
          <TextInputV2
            autofocus
            class="!w-full font-mono"
            name="name"
            value={draft.name}
            placeholder="greet"
            onInput={(event) => setDraft("name", event.currentTarget.value)}
          />
          <span class="text-[11px] text-v2-text-text-faint">{language.t("workbench.tools.form.name.hint")}</span>
        </Field>
        <Field>
          <Field.Label>{language.t("workbench.tools.form.description")}</Field.Label>
          <TextInputV2
            class="!w-full"
            name="description"
            value={draft.description}
            placeholder={language.t("workbench.tools.form.description.placeholder")}
            onInput={(event) => setDraft("description", event.currentTarget.value)}
          />
        </Field>
        <div>
          <div class="mb-1 text-[12px] font-[530] text-v2-text-text-base">
            {language.t("workbench.tools.form.source")}
          </div>
          <CodeView
            source={TOOL_TEMPLATE}
            path="tool.ts"
            label={language.t("workbench.tools.form.source")}
            onChange={(text) => setDraft("source", text)}
            class={CODE}
          />
        </div>
      </div>
    </form>
  )
}
