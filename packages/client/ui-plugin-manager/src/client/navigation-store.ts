/** Plugin page selection shared by the page and cross-plugin navigation. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** The plugin list or one bundle, official item, or bundle row. */
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'row'; readonly name: string; readonly rowId: string }

type NavigationState = { view: View; modalOpen: boolean }
type NavigationActions = {
  setView: (draft: NavigationState, view: View) => void
  openModal: (draft: NavigationState) => void
  closeModal: (draft: NavigationState) => void
}

/**
 * Create plugin page selection before the first page render.
 * @returns the registration-owned navigation store handle.
 */
export function createNavigationStore(): EngineStoreHandle<NavigationState, NavigationActions> {
  return defineStore({
    init: (): NavigationState => ({ view: { kind: 'list' }, modalOpen: false }),
    actions: {
      setView: (draft, view: View) => { draft.view = view },
      openModal: (draft) => {
        if (draft.modalOpen) return
        draft.view = { kind: 'list' }
        draft.modalOpen = true
      },
      closeModal: (draft) => {
        draft.modalOpen = false
        draft.view = { kind: 'list' }
      },
    },
  })
}
