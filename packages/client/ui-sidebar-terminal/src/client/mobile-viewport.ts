/** Visible-area sizing for a fullscreen phone terminal, without changing its pane. */

/**
 * Bound a terminal surface to the visible viewport; xterm's existing observer fits the new box.
 * @param surface - flex surface containing the emulator and its local key row.
 * @param active - whether this occurrence is currently visible in fullscreen presentation.
 * @param onPhoneChange - clear input modifiers when the touch key row becomes unavailable.
 * @returns immediate synchronization and owned listener/frame cleanup.
 */
export function observeTerminalViewport(
  surface: HTMLElement, active: () => boolean, onPhoneChange?: (phone: boolean) => void,
): { sync: () => void; dispose: () => void } {
  const viewport = window.visualViewport ?? null
  if (viewport === null) return { sync: () => {}, dispose: () => {} }
  const mobile = window.matchMedia('(max-width: 1023px) and (pointer: coarse)')
  let frame: number | undefined
  const reset = (): void => { surface.style.removeProperty('max-height'); surface.style.removeProperty('margin-top') }
  const sync = (): void => {
    reset()
    if (!active() || !mobile.matches || Math.abs(viewport.scale - 1) >= 0.05
      || surface.closest('[data-sidebar-right-panel="fullscreen"]') === null) return
    const rect = surface.getBoundingClientRect()
    let following = 0
    for (let sibling = surface.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
      following += sibling.getBoundingClientRect().height
    }
    const top = Math.max(rect.top, viewport.offsetTop)
    surface.style.marginTop = `${Math.max(0, top - rect.top)}px`
    surface.style.maxHeight = `${Math.max(0, Math.min(rect.bottom, viewport.offsetTop + viewport.height - following) - top)}px`
  }
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => { frame = undefined; sync() })
  }
  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  const change = (): void => { onPhoneChange?.(mobile.matches); schedule() }
  mobile.addEventListener('change', change)
  sync()
  return {
    sync,
    dispose: () => {
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      mobile.removeEventListener('change', change)
      if (frame !== undefined) cancelAnimationFrame(frame)
      reset()
    },
  }
}
