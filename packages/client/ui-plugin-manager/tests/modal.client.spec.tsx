// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import * as settings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as manager from '../src/client/index.ts'

const PACKAGE = 'dsh-modal-test'
const BUNDLE: BundleInfo = {
  name: PACKAGE, version: '1.0.0', enabled: true, installed: true, optional: false,
  removable: true, rows: [{ rowId: 'row', moduleName: PACKAGE, meta: { description: 'Row description.' } }], overrides: [],
}
type FrameProps = PropsRuntime<'root'> & PropsRenderSlots<'main' | 'shell.overlay'>

function Frame({ usePanelInfo, renderSlot }: FrameProps) {
  const panel = usePanelInfo(state => state.activePanelId)
  return <>
    <input aria-label="Current conversation" defaultValue="draft" />
    <button type="button">Open plugins</button>
    {panel === manager.PANEL_ID && renderSlot('main', {}, { entryKey: manager.PANEL_ID })}
    {renderSlot('shell.overlay', {})}
  </>
}

async function bench() {
  const rt = await SlotTestRuntime.create()
  onTestFinished(() => rt.dispose())
  const locale = new LocaleRuntime(rt.ctx)
  locale.setLocale('en')
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  rt.remote.provideNamespaces({
    settings: { describe: vi.fn(async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })) },
    pluginInventory: { list: vi.fn(async () => ({ ok: true, value: { entries: [], managementAvailable: true } })) },
    pluginRegistryProbe: { fastest: vi.fn(async () => ({ ok: true, value: null })) },
    pluginManager: {
      listBundles: vi.fn(async () => ({ ok: true, value: [BUNDLE] })),
      listPlugins: vi.fn(async () => ({ ok: true, value: [] })),
      registries: vi.fn(async () => ({ ok: true, value: { registry: null, fallbackRegistries: [], resolved: null } })),
    },
  })
  const selectPanel = vi.fn<ILayout['selectPanel']>((activePanelId) => { rt.panelInfo.set({ activePanelId }) })
  rt.ctx.provide('layout', { panelInfo: rt.panelInfo, selectPanel, beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })
  await rt.mount(settings)
  await rt.root.declare({
    main: { kind: 'keyed', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  }, Frame)
  const feature = await rt.mount(manager)
  rt.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#row` }, ({ view }) => <p>Row configuration {view}</p>)
  const root = rt.renderRoot()
  return { rt, selectPanel, feature, root }
}

describe('plugin manager owner modal', () => {
  it('preserves the background and renders list, details and configuration in one native modal', async () => {
    const b = await bench()
    const input = screen.getByRole('textbox', { name: 'Current conversation' })
    fireEvent.change(input, { target: { value: 'unsent draft' } })
    const trigger = screen.getByRole('button', { name: 'Open plugins' })
    trigger.focus()
    await act(async () => { b.rt.ctx.pluginNavigation.openModal() })
    const dialog = screen.getByRole('dialog', { name: 'Plugins' })
    await screen.findByText(PACKAGE)
    expect(b.selectPanel).not.toHaveBeenCalled()
    expect(b.rt.panelInfo.getSnapshot().activePanelId).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Current conversation' })).toBe(input)
    expect(input).toHaveProperty('value', 'unsent draft')
    expect(document.querySelectorAll('[data-plugin-panel]')).toHaveLength(1)
    expect(within(dialog).getAllByRole('heading', { name: 'Plugins' })).toHaveLength(1)
    expect(b.root.container.contains(dialog)).toBe(false)
    expect({ role: dialog.getAttribute('role'), modal: dialog.getAttribute('aria-modal'),
      title: dialog.getAttribute('aria-label'), headings: within(dialog).getAllByRole('heading').map(node => node.textContent),
    }).toEqual({ role: 'dialog', modal: 'true', title: 'Plugins', headings: ['Plugins', 'Installed'] })

    fireEvent.click(within(dialog).getByText(PACKAGE))
    await act(async () => { b.rt.ctx.pluginNavigation.openModal() })
    expect(within(dialog).queryByRole('heading', { name: 'Installed' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: `Configure ${PACKAGE}` }))
    expect(within(dialog).getByText('Row configuration page')).toBeTruthy()
    expect(document.querySelectorAll('[data-plugin-panel]')).toHaveLength(1)
    await act(async () => { b.rt.ctx.pluginNavigation.openBundle(PACKAGE) })
    expect(within(dialog).queryByText('Row configuration page')).toBeNull()
    expect(b.selectPanel).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(input).toHaveProperty('value', 'unsent draft')
    await act(async () => { b.rt.ctx.pluginNavigation.openModal() })
    expect(screen.getByRole('heading', { name: 'Installed' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add plugin' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { b.rt.ctx.pluginNavigation.openBundle(PACKAGE) })
    expect(b.selectPanel).toHaveBeenCalledWith(manager.PANEL_ID)
    expect(document.querySelectorAll('[data-plugin-panel]')).toHaveLength(1)
  })

  it('suppresses the main occurrence while modal-owned and releases the modal on fiber disposal', async () => {
    const b = await bench()
    await act(async () => { b.rt.ctx.pluginNavigation.openBundle(PACKAGE) })
    await screen.findByRole('heading', { name: PACKAGE })
    await act(async () => { b.rt.ctx.pluginNavigation.openModal() })
    expect(document.querySelectorAll('[data-plugin-panel]')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(b.selectPanel).toHaveBeenCalledTimes(1)
    fireEvent.click(within(screen.getByRole('dialog')).getByText(PACKAGE))
    await act(async () => { b.selectPanel(null) })
    expect(within(screen.getByRole('dialog')).queryByRole('heading', { name: 'Installed' })).toBeNull()
    await b.feature.dispose()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.rt.ctx.get('pluginNavigation')).toBeUndefined()
    expect(b.rt.slots.spec('plugins.row.config')).toBeUndefined()
    expect(b.rt.slots.snapshot('factory:plugins.manager')).toEqual([])
  })
})
