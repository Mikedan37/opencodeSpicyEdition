// The composer chip for the main chat's per-session switch (opencode src/workbench/auto-approve.ts): off in every new
// session, and turning it on asks first. Turning it off does not.
import { createResource, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { createWorkbenchClient, errorText } from "./client"

/** Renders only on a session's page; the new-session composer has no session to switch yet. */
export function AutoApproveChip() {
  const params = useParams()
  return (
    <Show when={params.id} keyed>
      {(id) => <Chip sessionID={id} />}
    </Show>
  )
}

function Chip(props: { sessionID: string }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const client = createWorkbenchClient({
    server: serverSDK().server.http,
    directory: sdk().directory,
    fetch: platform.fetch,
  })
  // undefined while loading, and on a server without the switch: the chip stays hidden.
  // ponytail: one chip for both switches until the UI's own controls replace it.
  const [enabled, { mutate }] = createResource(() =>
    client
      .getAutoApprove(props.sessionID)
      .then((value) => value.edits && value.commands)
      .catch(() => undefined),
  )

  const confirm = () =>
    new Promise<boolean>((resolve) => {
      const pick = (accept: boolean) => {
        resolve(accept)
        dialog.close()
      }
      dialog.show(
        () => (
          <DialogV2 fit>
            <DialogHeader hideClose>
              <DialogTitleGroup
                title={language.t("workbench.autoApprove.confirm.title")}
                description={language.t("workbench.autoApprove.confirm.description")}
              />
            </DialogHeader>
            <DialogFooter>
              <ButtonV2 variant="ghost" data-choice="cancel" onClick={() => pick(false)}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="warning" data-choice="auto-approve" onClick={() => pick(true)}>
                {language.t("workbench.autoApprove.confirm.accept")}
              </ButtonV2>
            </DialogFooter>
          </DialogV2>
        ),
        () => resolve(false),
      )
    })

  const toggle = async () => {
    const next = !enabled()
    if (next && !(await confirm())) return
    await client.setAutoApprove(props.sessionID, { edits: next, commands: next }).then(
      (value) => mutate(value.edits && value.commands),
      (error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("workbench.autoApprove.failed"),
          description: errorText(error),
        }),
    )
  }

  return (
    <Show when={enabled() !== undefined}>
      <TooltipV2
        placement="top"
        gutter={4}
        value={language.t(enabled() ? "workbench.autoApprove.tooltip.on" : "workbench.autoApprove.tooltip.off")}
      >
        <ButtonV2
          data-action="prompt-auto-approve"
          data-state={enabled() ? "on" : "off"}
          aria-pressed={!!enabled()}
          variant={enabled() ? "warning" : "ghost-muted"}
          size="normal"
          style={{ height: "28px" }}
          class="shrink-0 ![font-weight:440]"
          onClick={() => void toggle()}
        >
          {language.t(enabled() ? "workbench.autoApprove.on" : "workbench.autoApprove.off")}
        </ButtonV2>
      </TooltipV2>
    </Show>
  )
}
