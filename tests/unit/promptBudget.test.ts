import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MOCK_DEFAULTS, newChat } from '@shared/chat'
import { CONCISE_RULES } from '@shared/economy'
import { buildSystemPrompt } from '../../src/main/chat/prompts'

/**
 * Every model call carries the system prompt again, so its size is a fixed cost on every step of
 * every turn. The multi-agent version sent ~4,900 characters to an Implementer and ~5,400 to
 * Mastermind with the template multimine.md (measured on archive/multi-agent). Keep a chat's well
 * under that: the number here is a budget, not a target.
 */
it('keeps the prompt every chat carries small', () => {
  const md = readFileSync('templates/multimine.md', 'utf8')
  const writer = buildSystemPrompt({ agent: newChat('c', MOCK_DEFAULTS), projectDir: '/p', multimineMd: md })
  const reader = buildSystemPrompt({ agent: newChat('c', { ...MOCK_DEFAULTS, permissions: 'read' }), projectDir: '/p', multimineMd: md })
  console.log(`chat prompt: ${writer.length} characters (read-only ${reader.length}), economy adds ${CONCISE_RULES.length}`)
  expect(writer.length).toBeLessThan(3600)
  expect(reader.length).toBeLessThan(1600)
})
