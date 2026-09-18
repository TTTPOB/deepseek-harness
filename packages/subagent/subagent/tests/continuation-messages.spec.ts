import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { withContinuableReturnGuidance } from '../src/continuation-messages.ts'

describe('continuable return guidance', () => {
  it('uses settlement for the final report and reserves send_message for early findings', () => {
    const content = withContinuableReturnGuidance(SessionId('parent'), [
      { type: 'text', text: 'Do the task.' },
    ])
    const guidance = content.at(-1)

    expect(guidance).toMatchObject({ type: 'text' })
    if (guidance?.type !== 'text') throw new Error('expected text guidance')
    expect(guidance.text).toContain('settlement will automatically notify the parent')
    expect(guidance.text).toContain('Use send_message only when information genuinely needs to reach the parent before you settle')
    expect(guidance.text).toContain('do not end the turn until your final report is complete')
  })
})
