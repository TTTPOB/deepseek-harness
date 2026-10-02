/** Main and modal owners of the single plugin management assembly. */
import type { ReactNode } from 'react'
import { IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createNavigationStore } from './navigation-store.ts'
import type { PluginManagerFace } from './manager-store.ts'
import css from './ManagerEntry.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Shared manager assembly; its owner renders only one occurrence at a time. */
    'plugins.manager': {
      scope: 'root'
      locale: 'pluginManager'
      store: ReturnType<typeof createNavigationStore>
      inject: PluginManagerFace
      children: {
        'plugins.item': { kind: 'list'; scope: 'root' }
        'plugins.bundle.activation': { kind: 'keyed'; scope: 'root' }
        'plugins.bundle.config': { kind: 'keyed'; scope: 'root' }
        'plugins.row.config': { kind: 'keyed'; scope: 'root' }
        'plugins.detail.actions': { kind: 'list'; scope: 'root' }
        'plugins.detail.badge': { kind: 'list'; scope: 'root' }
        'plugins.detail.section': { kind: 'list'; scope: 'root' }
      }
    }
  }
}

type MainProps = PropsRuntime<'main'> & PropsRenderFactories & PropsStore<ReturnType<typeof createNavigationStore>>
type ModalProps = PropsRuntime<'shell.overlay'> & PropsRenderFactories
  & PropsStore<ReturnType<typeof createNavigationStore>> & PropsLocale<'pluginManager'>

/** Render the desktop assembly only when the modal does not own it.
 * @param props - framework-bound main entry props.
 * @returns the manager assembly or no main content while modal-owned.
 */
export function ManagerMain(props: MainProps): ReactNode {
  const modalOpen = props.useStore(state => state.modalOpen)
  return modalOpen ? null : props.renderFactorySlot('plugins.manager', {})
}

/** Keep the background panel mounted and let the native Modal own focus and Escape.
 * @param props - framework-bound overlay entry props.
 * @returns the native modal with the shared manager assembly.
 */
export function ManagerModal(props: ModalProps): ReactNode {
  const modalOpen = props.useStore(state => state.modalOpen)
  return (
    <Modal open={modalOpen} onClose={props.actions.closeModal} title={props.t('panel')}
      headless className={css.dialog ?? ''}>
      <div className={css.toolbar}>
        <button type="button" className={css.close} aria-label={props.t('close')} onClick={props.actions.closeModal}>
          <IconCloseOutlineRegular size={18} />
        </button>
      </div>
      {modalOpen && <div className={css.page}>{props.renderFactorySlot('plugins.manager', {})}</div>}
    </Modal>
  )
}
