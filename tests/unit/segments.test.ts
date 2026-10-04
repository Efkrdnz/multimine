import { expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { appendNote, appendStream, appendTool, blocks, closeSegments } from '@shared/segments'

const reply = (): ChatMessage => ({ id: 'r', agentId: 'a', role: 'assistant', from: 'a', text: '', ts: 0, tools: [] })

it('keeps a reply in the order it happened, with runs of tools as one block of work', () => {
  const m = reply()
  appendStream(m, 'thinking', 'Where is the ', 0)
  appendStream(m, 'thinking', 'registry?', 100)
  appendTool(m, 't1', 1500)
  appendTool(m, 't2', 1600)
  appendStream(m, 'text', 'Found it. ', 2000)
  appendStream(m, 'thinking', 'Now the edit.', 2100)
  appendTool(m, 't3', 2500)
  appendStream(m, 'text', 'Done.', 3000)
  closeSegments(m, 3200)
  expect(blocks(m, 9999)).toEqual([
    { kind: 'thinking', text: 'Where is the registry?', at: 0, ms: 1500, open: false },
    { kind: 'work', toolIds: ['t1', 't2'] },
    { kind: 'text', text: 'Found it. ' },
    { kind: 'thinking', text: 'Now the edit.', at: 2100, ms: 400, open: false },
    { kind: 'work', toolIds: ['t3'] },
    { kind: 'text', text: 'Done.' }
  ])
  // the flat fields still hold everything, the separate stretches apart
  expect(m.text).toBe('Found it. \n\nDone.')
  expect(m.thinking).toBe('Where is the registry?\n\nNow the edit.')
})

it('says thinking is still going while nothing else has started, and puts notes where they happened', () => {
  const m = reply()
  appendStream(m, 'thinking', 'hmm', 0)
  expect(blocks(m, 800)).toEqual([{ kind: 'thinking', text: 'hmm', at: 0, ms: 800, open: true }])
  appendStream(m, 'text', 'Working on it', 900)
  appendNote(m, '*Switched to Codex*', 1000)
  appendStream(m, 'text', 'Continuing.', 1100)
  expect(m.text).toBe('Working on it\n\n*Switched to Codex*\n\nContinuing.')
  expect(blocks(m).map((b) => b.kind)).toEqual(['thinking', 'text'])
})

it('says a run of work in a line', async () => {
  const { workSummary } = await import('@shared/activity')
  expect(
    workSummary([
      { name: 'Read', input: { file_path: 'a.java' } },
      { name: 'Read', input: { file_path: 'b.java' } },
      { name: 'Grep', input: { pattern: 'x' } },
      { name: 'Edit', input: { file_path: 'a.java' } },
      { name: 'Bash', input: { command: './gradlew build' } },
      { name: 'TodoWrite', input: {} }
    ])
  ).toBe('Read 2 files · searched 1 time · edited 1 file · ran 1 command · planning')
})
