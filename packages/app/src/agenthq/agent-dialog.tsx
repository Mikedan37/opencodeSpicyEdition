import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { errorText, type AgentDraft } from "@/workbench/client"
import { AgentAvatar, agentInitials, AVATAR_COLORS, AVATAR_PRESET_IDS } from "./avatar"
import { useAgentHQ } from "./context"

type Agent = AgentHQ.AgentIdentity

export function createAgentDraft(agent: Agent | undefined, directory: string) {
  return createStore({
    name: agent?.name ?? "",
    avatar: agent?.avatar ?? { kind: "preset" as const, value: "fox", color: "orange" },
    emoji: agent?.avatar.kind === "emoji" ? agent.avatar.value : "",
    provider: agent?.provider as AgentHQ.ProviderID | undefined,
    model: agent?.model ?? "",
    specialty: agent?.specialty ?? "",
    projectDirectory: agent?.projectDirectory ?? directory,
    saving: false,
    confirmDelete: false,
  })
}

const label = "select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base"

export function AgentDialog(props: { agent?: Agent; draft: ReturnType<typeof createAgentDraft>; reopen: () => void }) {
  const agenthq = useAgentHQ()
  const language = useLanguage()
  const dialog = useDialog()
  const serverSDK = useServerSDK()
  const pickDirectory = useDirectoryPicker()
  const [draft, setDraft] = props.draft
  const mounted = { value: true }
  onCleanup(() => (mounted.value = false))

  void agenthq.refreshProviders().catch(() => undefined)
  createEffect(() => {
    if (draft.provider) return
    const first = agenthq.state.providers.find((provider) => provider.available)
    if (first) setDraft("provider", first.id)
  })

  const provider = () => agenthq.state.providers.find((item) => item.id === draft.provider)
  // An unavailable provider can't take new agents, but an existing agent can still be renamed.
  const valid = () =>
    !!draft.name.trim() &&
    !!draft.projectDirectory.trim() &&
    (!!provider()?.available || (!!props.agent && draft.provider === props.agent.provider))

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!valid() || draft.saving || !draft.provider) return
    const body: AgentDraft = {
      name: draft.name.trim(),
      avatar: draft.avatar.kind === "initials" ? { ...draft.avatar, value: agentInitials(draft.name) } : draft.avatar,
      provider: draft.provider,
      // Edits send null to clear an optional field (AgentRegistry.UpdateInput); creation omits it.
      model: draft.model.trim() || (props.agent ? null : undefined),
      specialty: draft.specialty.trim() || (props.agent ? null : undefined),
      projectDirectory: draft.projectDirectory.trim(),
    }
    setDraft("saving", true)
    const request = props.agent
      ? agenthq.updateAgent(props.agent.id, body)
      : agenthq.createAgent(body).then((agent) => agenthq.selectAgent(agent.id))
    request
      .then(
        () => dialog.close(),
        (error: unknown) =>
          showToast({ variant: "error", title: language.t("agenthq.dialog.failed"), description: errorText(error) }),
      )
      .finally(() => setDraft("saving", false))
  }

  const remove = (agent: Agent) => {
    if (!draft.confirmDelete) return setDraft("confirmDelete", true)
    setDraft("saving", true)
    agenthq
      .removeAgent(agent.id)
      .then(
        () => dialog.close(),
        (error: unknown) =>
          showToast({ variant: "error", title: language.t("agenthq.dialog.failed"), description: errorText(error) }),
      )
      .finally(() => setDraft("saving", false))
  }

  const browse = () =>
    pickDirectory({
      server: serverSDK().server,
      title: language.t("agenthq.dialog.project"),
      onSelect: (result) => {
        if (typeof result === "string") setDraft("projectDirectory", result)
        if (!mounted.value) props.reopen()
      },
    })

  const pick = (avatar: Agent["avatar"]) => setDraft("avatar", avatar)
  const pressed = (kind: Agent["avatar"]["kind"], value?: string) =>
    draft.avatar.kind === kind && (value === undefined || draft.avatar.value === value)
  const choice =
    "flex size-10 items-center justify-center rounded-[10px] outline outline-1 outline-transparent transition-[background-color,outline-color] hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus aria-pressed:[box-shadow:inset_0_0_0_2px_var(--v2-border-border-focus)]"

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents" data-component="agenthq-dialog">
        <DialogHeader>
          <DialogTitle>
            {props.agent ? language.t("agenthq.dialog.edit") : language.t("agenthq.dialog.create")}
          </DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex max-h-[min(640px,calc(100vh-160px))] w-full flex-col gap-5 overflow-y-auto px-4 pt-4 pb-1">
          <Field>
            <Field.Label>{language.t("agenthq.dialog.name")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              name="name"
              value={draft.name}
              onInput={(event) => setDraft("name", event.currentTarget.value)}
            />
          </Field>

          <div class="flex flex-col gap-2">
            <div class={label}>{language.t("agenthq.dialog.avatar")}</div>
            <div class="-ml-1 flex flex-wrap items-center gap-1">
              <For each={AVATAR_PRESET_IDS}>
                {(id) => (
                  <button
                    type="button"
                    class={choice}
                    aria-pressed={pressed("preset", id)}
                    aria-label={language.t(`agenthq.dialog.avatar.${id}`)}
                    onClick={() => pick({ kind: "preset", value: id, color: draft.avatar.color })}
                  >
                    <AgentAvatar avatar={{ kind: "preset", value: id, color: draft.avatar.color }} name="" size={32} />
                  </button>
                )}
              </For>
              <button
                type="button"
                class={choice}
                aria-pressed={pressed("initials")}
                aria-label={language.t("agenthq.dialog.avatar.initials")}
                onClick={() => pick({ kind: "initials", value: agentInitials(draft.name), color: draft.avatar.color })}
              >
                <AgentAvatar
                  avatar={{ kind: "initials", value: agentInitials(draft.name) || "?", color: draft.avatar.color }}
                  name={draft.name}
                  size={32}
                />
              </button>
              <TextInputV2
                class="!w-24"
                aria-label={language.t("agenthq.dialog.avatar.emoji")}
                placeholder={language.t("agenthq.dialog.avatar.emoji")}
                maxLength={8}
                value={draft.emoji}
                onInput={(event) => {
                  const value = event.currentTarget.value.trim()
                  setDraft("emoji", value)
                  if (value) pick({ kind: "emoji", value, color: draft.avatar.color })
                }}
              />
            </div>
            <div class="-ml-1 flex flex-wrap gap-1" aria-label={language.t("agenthq.dialog.avatar.color")} role="group">
              <For each={AVATAR_COLORS}>
                {(color) => (
                  <button
                    type="button"
                    class="flex size-7 items-center justify-center rounded-[8px] outline outline-1 outline-transparent hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus aria-pressed:[box-shadow:inset_0_0_0_2px_var(--v2-border-border-focus)]"
                    aria-pressed={(draft.avatar.color ?? "gray") === color}
                    aria-label={language.t("agenthq.dialog.avatar.color.select", { color })}
                    onClick={() => pick({ ...draft.avatar, color })}
                  >
                    <span class="size-4 rounded-[4px]" style={{ background: `var(--v2-avatar-bg-${color})` }} />
                  </button>
                )}
              </For>
            </div>
          </div>

          <fieldset class="flex flex-col gap-1.5">
            <legend class={`${label} mb-2`}>{language.t("agenthq.dialog.provider")}</legend>
            <Show
              when={agenthq.state.providers.length > 0}
              fallback={
                <span class="text-[12px] text-v2-text-text-muted">{language.t("agenthq.dialog.provider.none")}</span>
              }
            >
              <For each={agenthq.state.providers}>
                {(item) => (
                  <label
                    data-provider={item.id}
                    class="flex items-start gap-2 rounded-[6px] px-2 py-1.5"
                    classList={{
                      "cursor-pointer hover:bg-v2-overlay-simple-overlay-hover": item.available,
                      "opacity-60": !item.available,
                    }}
                  >
                    <input
                      type="radio"
                      name="agenthq-provider"
                      class="mt-0.5"
                      value={item.id}
                      checked={draft.provider === item.id}
                      disabled={!item.available}
                      onChange={() => setDraft("provider", item.id)}
                    />
                    <span class="flex min-w-0 flex-col gap-0.5">
                      <span class="flex items-center gap-1.5 text-[13px] text-v2-text-text-base">
                        {item.name}
                        <Show when={item.version}>
                          <span class="text-[11px] text-v2-text-text-faint">{item.version}</span>
                        </Show>
                        <Show when={item.available && item.auth === "required"}>
                          <Tag>{language.t("agenthq.dialog.provider.auth")}</Tag>
                        </Show>
                      </span>
                      <Show when={!item.available}>
                        <span class="text-[11px] text-v2-text-text-muted">
                          {item.reason ?? language.t("agenthq.dialog.provider.unavailable")}
                        </span>
                      </Show>
                    </span>
                  </label>
                )}
              </For>
            </Show>
          </fieldset>

          <Field>
            <Field.Label>{language.t("agenthq.dialog.model")}</Field.Label>
            <TextInputV2
              class="!w-full"
              name="model"
              value={draft.model}
              disabled={provider()?.capabilities.models === false}
              placeholder={language.t("agenthq.dialog.model.placeholder")}
              onInput={(event) => setDraft("model", event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{language.t("agenthq.dialog.specialty")}</Field.Label>
            <TextInputV2
              class="!w-full"
              name="specialty"
              value={draft.specialty}
              placeholder={language.t("agenthq.dialog.specialty.placeholder")}
              onInput={(event) => setDraft("specialty", event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{language.t("agenthq.dialog.project")}</Field.Label>
            <div class="flex w-full items-center gap-2">
              <TextInputV2
                class="min-w-0 !w-auto !flex-1 [&_input]:font-mono"
                name="projectDirectory"
                spellcheck={false}
                value={draft.projectDirectory}
                onInput={(event) => setDraft("projectDirectory", event.currentTarget.value)}
              />
              <ButtonV2 type="button" variant="neutral" onClick={browse}>
                {language.t("agenthq.dialog.project.browse")}
              </ButtonV2>
            </div>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Show when={props.agent}>
            {(agent) => (
              <ButtonV2 type="button" variant="danger" disabled={draft.saving} onClick={() => remove(agent())}>
                {draft.confirmDelete
                  ? language.t("agenthq.dialog.delete.confirm")
                  : language.t("agenthq.dialog.delete")}
              </ButtonV2>
            )}
          </Show>
          <span class="flex-1" />
          <ButtonV2 type="button" variant="neutral" disabled={draft.saving} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={!valid() || draft.saving}>
            {draft.saving
              ? language.t("common.saving")
              : props.agent
                ? language.t("common.save")
                : language.t("agenthq.dialog.submit.create")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
