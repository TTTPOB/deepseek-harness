/** One-shot modifiers for the current terminal's committed text and extra keys. */

/** Terminal-local modifier state. */
export interface TerminalModifiers { ctrl: boolean; alt: boolean }
/** Extra keys encoded by the terminal owner. */
export type TerminalExtraKey = 'escape' | 'tab' | 'left' | 'down' | 'up' | 'right' | 'interrupt' | 'eof'

/**
 * Encode one ASCII character, leaving unsupported text unchanged.
 * @param text - committed character, never a composition update or paste.
 * @param modifiers - one-shot terminal modifiers.
 * @returns terminal input bytes represented as a string.
 */
export function terminalCharacter(text: string, modifiers: TerminalModifiers): string {
  if (text.length !== 1 || text.charCodeAt(0) > 127) return text
  let value = text
  if (modifiers.ctrl) {
    if (/^[a-z]$/i.test(text)) value = String.fromCharCode(text.toUpperCase().charCodeAt(0) - 64)
    else if (text === ' ') value = '\x00'
    else if (/^[@\[\\\]\^_]$/.test(text)) value = String.fromCharCode(text.charCodeAt(0) & 31)
    else if (text === '?') value = '\x7f'
  }
  return modifiers.alt ? `\x1b${value}` : value
}

/**
 * Encode an extra key using the emulator's current cursor mode.
 * @param key - the explicit extra-key action.
 * @param applicationCursor - current DECCKM state.
 * @param modifiers - modifiers consumed by this action.
 * @returns raw terminal input.
 */
export function terminalExtraKey(key: TerminalExtraKey, applicationCursor: boolean, modifiers: TerminalModifiers): string {
  if (key === 'interrupt') return '\x03'
  if (key === 'eof') return '\x04'
  if (key === 'escape' || key === 'tab') return terminalCharacter(key === 'escape' ? '\x1b' : '\t', modifiers)
  const suffix = { left: 'D', down: 'B', up: 'A', right: 'C' }[key]
  const modifier = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0)
  return modifier === 1 ? `\x1b${applicationCursor ? 'O' : '['}${suffix}` : `\x1b[1;${modifier}${suffix}`
}

/** Local input state; DOM commits identify text before xterm's own listeners run. */
export class MobileTerminalInput {
  private modifiers: TerminalModifiers = { ctrl: false, alt: false }
  private composing = false
  private pending: string | undefined
  private enabled = false
  private readonly listeners: [string, EventListener][]

  /**
   * @param node - emulator container receiving captured textarea events.
   * @param textarea - xterm's public input textarea.
   * @param send - the existing model.write callback.
   * @param changed - local control-state rendering callback.
   */
  constructor(node: HTMLElement, textarea: HTMLTextAreaElement, private readonly send: (data: string) => void,
    private readonly changed: (modifiers: TerminalModifiers, composing: boolean) => void) {
    const capture = (listener: (event: Event) => void): EventListener => (event) => { if (event.target === textarea) listener(event) }
    this.listeners = [
      ['keydown', capture((event) => {
        const key = (event as KeyboardEvent).key
        this.pending = this.composing ? undefined : key.length === 1 ? key : key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : key === 'Backspace' ? '\x7f' : undefined
        if (!this.composing && (key === 'Escape' || key.startsWith('Arrow'))) this.clear()
      })],
      ['keypress', capture((event) => { this.pending = this.composing ? undefined : (event as KeyboardEvent).key })],
      ['input', capture((event) => {
        const input = event as InputEvent
        this.pending = this.composing ? undefined : input.isComposing ? this.pending
          : input.data ?? (input.inputType === 'deleteContentBackward' ? '\x7f' : undefined)
      })],
      ['compositionstart', capture(() => { this.composing = true; this.pending = undefined; this.publish() })],
      ['compositionend', capture((event) => { this.composing = false; this.pending = (event as CompositionEvent).data; this.publish() })],
      ['paste', capture(() => { this.pending = undefined; this.clear() })],
      ['blur', capture(() => { this.cancel() })],
    ]
    for (const [type, listener] of this.listeners) node.addEventListener(type, listener, true)
    this.dispose = () => { for (const [type, listener] of this.listeners) node.removeEventListener(type, listener, true) }
  }

  /** Remove owned DOM listeners without publishing after unmount. */
  readonly dispose: () => void

  /**
   * Reset modifiers when the occurrence hides or loses input control.
   * @param enabled - current visible, writable attachment.
   */
  enable(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.cancel() }

  /**
   * Toggle a modifier only outside an existing composition.
   * @param key - one-shot modifier.
   */
  toggle(key: keyof TerminalModifiers): void {
    if (!this.enabled || this.composing) return
    this.modifiers = { ...this.modifiers, [key]: !this.modifiers[key] }
    this.publish()
  }

  /**
   * Forward xterm data; only a matching DOM commit may consume modifiers.
   * @param data - xterm onData packet, including protocol responses.
   */
  input(data: string): void {
    if (!this.enabled || this.composing || this.pending === undefined || data.startsWith('\x1b')) { this.send(data); return }
    const value = this.pending === data ? terminalCharacter(data, this.modifiers) : data
    this.pending = undefined
    this.clear()
    this.send(value)
  }

  /**
   * Send a known extra key without refocusing or synthesizing DOM keys.
   * @param key - explicit action.
   * @param applicationCursor - emulator cursor-key mode.
   */
  key(key: TerminalExtraKey, applicationCursor: boolean): void {
    if (!this.enabled || this.composing) return
    const value = terminalExtraKey(key, applicationCursor, this.modifiers)
    this.pending = undefined
    this.clear()
    this.send(value)
  }

  private cancel(): void {
    this.pending = undefined
    const composing = this.composing
    this.composing = false
    this.clear()
    if (composing) this.publish()
  }
  private clear(): void {
    if (!this.modifiers.ctrl && !this.modifiers.alt) return
    this.modifiers = { ctrl: false, alt: false }
    this.publish()
  }
  private publish(): void { this.changed(this.modifiers, this.composing) }
}
