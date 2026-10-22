import { createContext } from "reka-ui"
import type { Ref } from "vue"

export const [useCommand, provideCommandContext] = createContext<{
  allItems: Ref<Map<string, string>>
  allGroups: Ref<Map<string, Set<string>>>
  filterState: {
    search: string
    filtered: { count: number, items: Map<string, number>, groups: Set<string> }
  }
}>("Command")

export const [useCommandGroup, provideCommandGroupContext] = createContext<{
  id?: string
}>("CommandGroup")
