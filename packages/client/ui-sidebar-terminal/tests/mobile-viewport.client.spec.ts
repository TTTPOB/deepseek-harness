// @vitest-environment jsdom
/** Fullscreen terminal surface budgets and reversible viewport listeners. */
import { afterEach, expect, it, vi } from 'vitest'
import { observeTerminalViewport } from '../src/client/mobile-viewport.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

function fixture() {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 })
  const mobile = Object.assign(new EventTarget(), { matches: true })
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('matchMedia', () => mobile)
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  const cancel = vi.fn((key: number) => { frames.delete(key) })
  vi.stubGlobal('cancelAnimationFrame', cancel)
  const panel = document.createElement('div')
  panel.setAttribute('data-sidebar-right-panel', 'fullscreen')
  const surface = document.createElement('div')
  const error = document.createElement('p')
  panel.append(surface, error); document.body.append(panel)
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 52, 390, 736))
  vi.spyOn(error, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 788, 390, 0))
  let active = true
  const phoneChange = vi.fn()
  const sizing = observeTerminalViewport(surface, () => active, phoneChange)
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0) }
  return { surface, error, panel, viewport, mobile, sizing, frames, cancel, flush, phoneChange, hide: () => { active = false } }
}

it('bounds the real surface before fit and accounts for pan and following content once', () => {
  const h = fixture()
  expect(h.surface.style.maxHeight).toBe('736px')
  h.viewport.height = 520
  h.viewport.dispatchEvent(new Event('resize')); h.viewport.dispatchEvent(new Event('scroll'))
  expect(h.frames.size).toBe(1)
  h.flush()
  expect(h.surface.style.maxHeight).toBe('468px')
  expect(h.surface.style.marginTop).toBe('0px')
  h.viewport.offsetTop = 100
  vi.spyOn(h.error, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 40))
  h.sizing.sync()
  expect(h.surface.style.marginTop).toBe('48px')
  expect(h.surface.style.maxHeight).toBe('480px')
  h.viewport.height = 844; h.viewport.offsetTop = 0
  vi.spyOn(h.error, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 0))
  h.sizing.sync()
  expect(h.surface.style.maxHeight).toBe('736px')
  h.sizing.dispose()
})

it('leaves desktop, zoomed, hidden and non-fullscreen surfaces unmodified', () => {
  const h = fixture()
  h.mobile.matches = false; h.mobile.dispatchEvent(new Event('change')); h.flush()
  expect(h.phoneChange).toHaveBeenLastCalledWith(false)
  expect(h.surface.style.maxHeight).toBe('')
  h.mobile.matches = true; h.viewport.scale = 1.2; h.sizing.sync()
  expect(h.surface.style.marginTop).toBe('')
  h.viewport.scale = 1; h.panel.removeAttribute('data-sidebar-right-panel'); h.sizing.sync()
  expect(h.surface.style.maxHeight).toBe('')
  h.panel.setAttribute('data-sidebar-right-panel', 'fullscreen'); h.hide(); h.sizing.sync()
  expect(h.surface.style.maxHeight).toBe('')
  h.sizing.dispose()
})

it('cancels the pending frame and all listeners and releases its inline sizing on dispose', () => {
  const h = fixture()
  window.dispatchEvent(new Event('resize'))
  expect(h.frames.size).toBe(1)
  h.sizing.dispose()
  expect(h.cancel).toHaveBeenCalledOnce()
  expect(h.surface.style.maxHeight).toBe('')
  h.viewport.dispatchEvent(new Event('resize')); h.viewport.dispatchEvent(new Event('scroll'))
  h.mobile.dispatchEvent(new Event('change')); window.dispatchEvent(new Event('resize'))
  expect(h.frames.size).toBe(0)
})

it('does not install listeners when VisualViewport is unavailable', () => {
  vi.stubGlobal('visualViewport', undefined)
  const surface = document.createElement('div')
  const sizing = observeTerminalViewport(surface, () => true)
  sizing.sync(); sizing.dispose()
  expect(surface.style.maxHeight).toBe('')
})
