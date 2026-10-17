// @vitest-environment jsdom
/** Extra-key byte encoding and terminal-local committed-input modifiers. */
import { expect, it, vi } from 'vitest'
import { MobileTerminalInput, terminalCharacter, terminalExtraKey } from '../src/client/mobile-input.ts'

it('encodes every ASCII control letter and standard punctuation without changing batches or CJK', () => {
  for (let code = 65; code <= 90; code++) {
    for (const char of [String.fromCharCode(code), String.fromCharCode(code + 32)]) {
      expect(terminalCharacter(char, { ctrl: true, alt: false })).toBe(String.fromCharCode(code - 64))
    }
  }
  for (const [char, code] of [[' ', 0], ['@', 0], ['[', 27], ['\\', 28], [']', 29], ['^', 30], ['_', 31], ['?', 127]] as const) {
    expect(terminalCharacter(char, { ctrl: true, alt: false })).toBe(String.fromCharCode(code))
  }
  expect(terminalCharacter('a', { ctrl: true, alt: true })).toBe('\x1b\x01')
  expect(terminalCharacter('a', { ctrl: false, alt: true })).toBe('\x1ba')
  for (const text of ['abc', '中', '😀', '']) expect(terminalCharacter(text, { ctrl: true, alt: true })).toBe(text)
})

it('encodes explicit control keys and normal, application and modified arrows', () => {
  const none = { ctrl: false, alt: false }
  expect(terminalExtraKey('interrupt', true, { ctrl: true, alt: true })).toBe('\x03')
  expect(terminalExtraKey('eof', false, none)).toBe('\x04')
  expect(terminalExtraKey('escape', false, none)).toBe('\x1b')
  expect(terminalExtraKey('tab', false, none)).toBe('\t')
  for (const [key, suffix] of [['up', 'A'], ['down', 'B'], ['right', 'C'], ['left', 'D']] as const) {
    expect(terminalExtraKey(key, false, none)).toBe(`\x1b[${suffix}`)
    expect(terminalExtraKey(key, true, none)).toBe(`\x1bO${suffix}`)
    expect(terminalExtraKey(key, true, { ctrl: true, alt: false })).toBe(`\x1b[1;5${suffix}`)
    expect(terminalExtraKey(key, false, { ctrl: true, alt: true })).toBe(`\x1b[1;7${suffix}`)
  }
})

function fixture() {
  const node = document.createElement('div')
  const textarea = document.createElement('textarea')
  node.append(textarea)
  const send = vi.fn()
  const changed = vi.fn()
  const input = new MobileTerminalInput(node, textarea, send, changed)
  input.enable(true)
  const commit = (data: string) => {
    textarea.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
    input.input(data)
  }
  return { node, textarea, send, changed, input, commit }
}

it('sends Ctrl+A once then plain keys, with independent modifiers per terminal', () => {
  const a = fixture(), b = fixture()
  a.input.toggle('ctrl')
  b.commit('a')
  a.commit('a'); a.commit('x')
  expect(a.send.mock.calls).toEqual([['\x01'], ['x']])
  expect(b.send.mock.calls).toEqual([['a']])
  a.input.toggle('alt'); a.commit('b'); a.commit('c')
  expect(a.send.mock.calls.slice(-2)).toEqual([['\x1bb'], ['c']])
  a.input.dispose(); b.input.dispose()
})

it('does not consume Ctrl for protocol replies, paste or composition updates', () => {
  const h = fixture()
  h.input.toggle('ctrl')
  h.input.input('\x1b[12;4R')
  h.commit('a')
  expect(h.send.mock.calls).toEqual([['\x1b[12;4R'], ['\x01']])
  h.input.toggle('ctrl')
  h.textarea.dispatchEvent(new Event('paste', { bubbles: true }))
  h.commit('a')
  expect(h.send).toHaveBeenLastCalledWith('a')
  h.input.toggle('ctrl')
  h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  h.input.toggle('alt')
  h.textarea.dispatchEvent(new InputEvent('input', { data: 'a', isComposing: true, bubbles: true }))
  h.input.input('a')
  expect(h.send).toHaveBeenLastCalledWith('a')
  h.textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'a', bubbles: true }))
  h.textarea.dispatchEvent(new InputEvent('input', { data: 'a', isComposing: true, bubbles: true }))
  h.input.input('a')
  expect(h.send).toHaveBeenLastCalledWith('\x01')
  h.input.toggle('ctrl'); h.commit('word')
  expect(h.send).toHaveBeenLastCalledWith('word')
  h.commit('a')
  expect(h.send).toHaveBeenLastCalledWith('a')
  h.input.dispose()
})

it('clears locks on hide, readonly and blur, disables buttons, and removes captured listeners', () => {
  const h = fixture()
  h.input.toggle('ctrl'); h.input.enable(false)
  h.input.toggle('ctrl'); h.input.key('interrupt', false)
  expect(h.send).not.toHaveBeenCalled()
  h.input.enable(true); h.commit('a')
  expect(h.send).toHaveBeenLastCalledWith('a')
  h.input.toggle('ctrl')
  h.textarea.dispatchEvent(new FocusEvent('blur'))
  h.commit('a')
  expect(h.send).toHaveBeenLastCalledWith('a')
  h.input.toggle('alt'); h.input.key('up', true)
  expect(h.send).toHaveBeenLastCalledWith('\x1b[1;3A')
  const remove = vi.spyOn(h.node, 'removeEventListener')
  h.input.dispose()
  expect(remove).toHaveBeenCalledTimes(7)
  h.changed.mockClear()
  h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  expect(h.changed).not.toHaveBeenCalled()
})
