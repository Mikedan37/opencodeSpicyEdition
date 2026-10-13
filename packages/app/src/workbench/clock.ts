import { createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"

const [now, setNow] = createSignal(Date.now())
let users = 0
let timer: ReturnType<typeof setInterval> | undefined

// "2 m ago" in the fork's views: one shared 30 s tick moves every relative time on; it runs while one is on screen.
export function useRelativeTime() {
  const language = useLanguage()
  if (users++ === 0) {
    setNow(Date.now())
    timer = setInterval(() => setNow(Date.now()), 30_000)
  }
  onCleanup(() => {
    if (--users === 0) clearInterval(timer)
  })
  return (at: number) => {
    now()
    return getRelativeTime(new Date(at).toISOString(), language.t)
  }
}
