import { Match, Switch } from "solid-js"
import { PROJECT_AVATAR_VARIANTS, type ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import type { AgentHQ } from "@opencode-ai/schema/agent-hq"

type Avatar = AgentHQ.AgentIdentity["avatar"]

// Character glyphs drawn on a 24px grid with the current text color. Static markup, never user input.
export const AVATAR_PRESETS = {
  fox: '<path d="M3.5 4.5L8 9h8l4.5-4.5-1 8.5L12 20l-7.5-7z"/><path d="M8 9l-1.5 4.5M16 9l1.5 4.5"/><circle cx="9.5" cy="12" r=".9" fill="currentColor"/><circle cx="14.5" cy="12" r=".9" fill="currentColor"/><path d="M11 17.3l1 1 1-1z" fill="currentColor"/>',
  octopus:
    '<path d="M5.5 13.5V11a6.5 6.5 0 0 1 13 0v2.5"/><path d="M5.5 13.5c0 2.5-1 4-2.5 5M9 14v3c0 1.5-.8 2.6-2 3.4M12 14v6M15 14v3c0 1.5.8 2.6 2 3.4M18.5 13.5c0 2.5 1 4 2.5 5"/><circle cx="9.5" cy="10.5" r=".9" fill="currentColor"/><circle cx="14.5" cy="10.5" r=".9" fill="currentColor"/>',
  owl: '<path d="M5 9.5C5 6 8 3.5 12 3.5S19 6 19 9.5V15a7 7 0 0 1-14 0z"/><path d="M6 3.5l2 3M18 3.5l-2 3"/><circle cx="9" cy="10.5" r="2.6"/><circle cx="15" cy="10.5" r="2.6"/><circle cx="9" cy="10.5" r=".9" fill="currentColor"/><circle cx="15" cy="10.5" r=".9" fill="currentColor"/><path d="M11 13.6l1 1.6 1-1.6z" fill="currentColor"/><path d="M9 18.5h6"/>',
  robot:
    '<rect x="5" y="7.5" width="14" height="11" rx="2.5"/><path d="M12 7.5V5M3.5 11.5v3M20.5 11.5v3M9.5 15.5h5"/><circle cx="12" cy="4" r=".9" fill="currentColor"/><rect x="8.3" y="10.8" width="2" height="2" rx=".5" fill="currentColor"/><rect x="13.7" y="10.8" width="2" height="2" rx=".5" fill="currentColor"/>',
  cat: '<path d="M5 3.5l3.5 4.5h7L19 3.5V13a7 7 0 0 1-14 0z"/><path d="M12 15v1.2M10.5 17.2c.8.6 2.2.6 3 0M2.5 13.5H6M2.5 16H6M18 13.5h3.5M18 16h3.5"/><circle cx="9.5" cy="12.3" r=".9" fill="currentColor"/><circle cx="14.5" cy="12.3" r=".9" fill="currentColor"/>',
  bear: '<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="6.5" r="2.5"/><circle cx="12" cy="13" r="7.5"/><ellipse cx="12" cy="15.8" rx="3" ry="2.2"/><circle cx="9" cy="11.5" r=".9" fill="currentColor"/><circle cx="15" cy="11.5" r=".9" fill="currentColor"/><circle cx="12" cy="15" r=".8" fill="currentColor"/>',
} as const

export type AvatarPreset = keyof typeof AVATAR_PRESETS
export const AVATAR_PRESET_IDS = Object.keys(AVATAR_PRESETS) as AvatarPreset[]
export const AVATAR_COLORS = PROJECT_AVATAR_VARIANTS

export function agentInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase()
}

export function AgentAvatar(props: { avatar: Avatar; name: string; size?: number; class?: string }) {
  const size = () => props.size ?? 32
  // The contract stores a theme token name; anything else falls back instead of reaching a style value.
  const color = () => (AVATAR_COLORS.includes(props.avatar.color as ProjectAvatarVariant) ? props.avatar.color : "gray")
  const preset = () => (props.avatar.kind === "preset" ? AVATAR_PRESETS[props.avatar.value as AvatarPreset] : undefined)
  return (
    <span
      data-component="agent-avatar"
      aria-hidden="true"
      class={`inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-[6px] leading-none ${props.class ?? ""}`}
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        color: "var(--v2-avatar-fg)",
        background: `var(--v2-avatar-bg-${color()})`,
        "box-shadow": `inset 0 0 0 0.5px var(--v2-avatar-border-${color()})`,
      }}
    >
      <Switch
        fallback={
          <span class="font-[530]" style={{ "font-size": `${Math.round(size() * 0.4)}px` }}>
            {(props.avatar.kind === "initials" && props.avatar.value.slice(0, 2).toUpperCase()) ||
              agentInitials(props.name)}
          </span>
        }
      >
        <Match when={preset()}>
          {(markup) => (
            <svg
              width={Math.round(size() * 0.72)}
              height={Math.round(size() * 0.72)}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              innerHTML={markup()}
            />
          )}
        </Match>
        <Match when={props.avatar.kind === "emoji" && props.avatar.value}>
          {(emoji) => <span style={{ "font-size": `${Math.round(size() * 0.6)}px` }}>{emoji()}</span>}
        </Match>
      </Switch>
    </span>
  )
}
