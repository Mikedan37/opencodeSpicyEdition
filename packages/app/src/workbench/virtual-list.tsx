import { createVirtualizer } from "@tanstack/solid-virtual"
import { createEffect, For, on, Show, type JSX } from "solid-js"

// Variable-height virtualized list. `follow` keeps the newest row in view while the reader is at the bottom (chat).
export function VirtualList<T>(props: {
  items: readonly T[]
  // Defaults to the index, which suits append-only lists.
  itemKey?: (item: T) => string
  estimate: number
  label: string
  follow?: boolean
  class?: string
  children: (item: T) => JSX.Element
}) {
  let scroller: HTMLDivElement | undefined
  let pinned = true
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.items.length
    },
    get getItemKey() {
      const items = props.items
      const key = props.itemKey
      return (index: number) => (key && items[index] !== undefined ? key(items[index]) : index)
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => props.estimate,
    initialRect: { width: 0, height: 400 },
    overscan: 8,
  })

  createEffect(
    on(
      () => virtualizer.getTotalSize(),
      () => {
        if (!props.follow || !pinned || !scroller) return
        scroller.scrollTop = scroller.scrollHeight
      },
    ),
  )

  return (
    <div
      ref={scroller}
      role="region"
      aria-label={props.label}
      tabIndex={0}
      class={`min-h-0 overflow-y-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--v2-border-border-focus)] ${props.class ?? ""}`}
      onScroll={(event) => {
        const el = event.currentTarget
        pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 32
      }}
    >
      <div style={{ position: "relative", height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>
          {(row) => (
            <div
              data-index={row.index}
              ref={(el) => queueMicrotask(() => el.isConnected && virtualizer.measureElement(el))}
              style={{
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                transform: `translateY(${row.start}px)`,
              }}
            >
              <Show when={props.items[row.index]} keyed>
                {(item) => props.children(item)}
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
