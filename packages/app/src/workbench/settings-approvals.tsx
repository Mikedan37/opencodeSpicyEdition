// Settings → Permissions: what this project allows without asking, saved from an approval's Always ▾ → This project.
// × removes a rule; its row folds away first.
import { batch, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { approvalRule } from "./approval"
import { createWorkbenchClient, errorText, type ApprovalRule } from "./client"

const FOLD_MS = 180

export function SettingsApprovals(props: { directory: () => string | undefined }) {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const client = createMemo(() => {
    const directory = props.directory()
    if (!directory) return
    return createWorkbenchClient({ server: serverSDK().server.http, directory, fetch: platform.fetch })
  })
  const [rules, { mutate }] = createResource(client, (current) => current.listApprovals())
  const [leaving, setLeaving] = createSignal<ApprovalRule[]>([])
  const same = (a: ApprovalRule) => (b: ApprovalRule) => a.permission === b.permission && a.pattern === b.pattern
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches

  // "bun test …", "all edits", "webfetch", "skill release": a tool's rule for some uses names the tool too.
  const words = (rule: ApprovalRule) => {
    const value = approvalRule(rule)
    if (value.everything)
      return language.t(value.kind === "edit" ? "workbench.approval.allEdits" : "workbench.approval.allCommands")
    return value.kind === "tool" && rule.pattern !== "*" ? `${rule.permission} ${value.text}` : value.text
  }

  const remove = (rule: ApprovalRule) => {
    const current = client()
    if (!current || leaving().some(same(rule))) return
    setLeaving((list) => [...list, rule])
    const folded = new Promise((resolve) => setTimeout(resolve, reduced ? 0 : FOLD_MS))
    const settle = (next?: readonly ApprovalRule[]) =>
      batch(() => {
        if (next) mutate([...next])
        setLeaving((list) => list.filter((item) => !same(rule)(item)))
      })
    current.removeApproval(rule).then(
      (next) => folded.then(() => settle(next)),
      (error: unknown) => {
        settle()
        showToast({
          variant: "error",
          title: language.t("workbench.approvals.removeFailed"),
          description: errorText(error),
        })
      },
    )
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.permissions.title")}</h2>
      </div>
      <div data-component="workbench-approvals" class="settings-v2-tab-body">
        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("workbench.approvals.title")}</h3>
          <Switch>
            <Match when={!client()}>
              <p class="text-[13px] text-v2-text-text-muted">{language.t("workbench.approvals.noProject")}</p>
            </Match>
            <Match when={rules.error}>
              <p role="alert" class="text-[13px] text-v2-state-fg-danger">
                {language.t("workbench.approvals.failed", { error: errorText(rules.error) })}
              </p>
            </Match>
            <Match when={rules.latest}>
              {(list) => (
                <Show
                  when={list().length}
                  fallback={
                    <p data-slot="approvals-empty" class="text-[13px] text-v2-text-text-muted">
                      {language.t("workbench.approvals.empty")}
                    </p>
                  }
                >
                  <ul data-component="settings-v2-list" class="py-1">
                    <For each={list()}>
                      {(rule) => {
                        const folding = () => leaving().some(same(rule))
                        return (
                          <li
                            data-rule={rule.permission}
                            data-state={folding() ? "leaving" : undefined}
                            class="grid transition-[grid-template-rows,opacity] duration-[180ms] ease-out motion-reduce:transition-none"
                            style={{ "grid-template-rows": folding() ? "0fr" : "1fr", opacity: folding() ? 0 : 1 }}
                          >
                            <div class="min-h-0 overflow-hidden">
                              <div class="flex items-center gap-3 py-2">
                                <span class="w-18 shrink-0 text-[12px] text-v2-text-text-muted">
                                  {language.t(`workbench.approvals.kind.${approvalRule(rule).kind}`)}
                                </span>
                                <code
                                  class="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-base"
                                  title={`${rule.permission} ${rule.pattern}`}
                                >
                                  {words(rule)}
                                </code>
                                <IconButtonV2
                                  size="small"
                                  variant="ghost-muted"
                                  data-action="approval-remove"
                                  aria-label={language.t("workbench.approvals.remove", { rule: words(rule) })}
                                  disabled={folding()}
                                  onClick={() => remove(rule)}
                                  icon={<IconV2 name="xmark-small" size="small" />}
                                />
                              </div>
                            </div>
                          </li>
                        )
                      }}
                    </For>
                  </ul>
                </Show>
              )}
            </Match>
            <Match when={true}>
              <div class="flex items-center gap-2 text-[13px] text-v2-text-text-muted">
                <LoaderV2 width={12} height={12} />
                {language.t("workbench.approvals.loading")}
              </div>
            </Match>
          </Switch>
        </section>
      </div>
    </>
  )
}
