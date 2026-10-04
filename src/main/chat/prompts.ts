import type { AgentSpec } from '@shared/types'

export interface PromptInput {
  agent: AgentSpec
  projectDir: string
  multimineMd: string
}

/** For every chat that can change the project: check your work without going round in circles. */
export const VERIFY_RULES = `## Verifying your work
- Compile and run the project's unit tests as often as you need; they are cheap.
- Launching the app or game (a game client, an editor, a dev server you watch, a browser) is costly.
  Do it at most once per change, and only with the project's automatic exit or a timeout - never
  start it and wait on it, never leave it running.
- Before a launch, check what it needs: a world or save it quick-plays into, a binary on PATH, a
  display. If a launch fails for a reason like that, do not retry it: \`ask_user\` or say what is
  missing and the exact command the user can run.
- Never repeat a check that already passed. Once it is verified, say so - and how you verified it.
- If multimine.md has a "How to verify" section, follow it over these defaults.

## Keeping a task lean
Every step re-sends the whole conversation so far, so a long turn costs more with each step.
- Grep and read the parts of files you need (Read with offset and limit) rather than whole large files.
- Do not start sub-agents (Task) for work you can do yourself: each one starts over with its own context.
- Multimine pauses a chat that relaunches the same thing, repeats a step, or runs far past its
  time or usage budget, and asks the user what to do. If you are told something after such a pause, do that first.`

/** The system prompt every chat gets, whichever provider runs it. */
export function buildSystemPrompt(p: PromptInput): string {
  const { agent } = p
  const parts: string[] = [
    `# Multimine\nYou are working in Multimine, a desktop app for coding agents. The project folder is \`${p.projectDir}\`; everything you do happens there.`
  ]
  if (p.multimineMd.trim()) parts.push(`## Project guidance (multimine.md)\n${p.multimineMd.trim()}`)
  parts.push(
    [
      '## Multimine tools',
      'Besides your own tools you have the Multimine ones (for CLI agents, the `multimine` MCP server):',
      '- `ask_user` for structured questions, rather than plain text at the end of a turn.',
      '- `request_permission` before anything that leaves this machine or cannot be undone (git push, publishing, deleting work).',
      '- `show_media` for every image, video, sound or model you generate or capture: it lands in the media gallery.',
      "- `read_table` / `save_table` for the project's tables (the user's `/table` requests)."
    ].join('\n')
  )
  if (agent.permissions === 'write') parts.push(VERIFY_RULES)
  return parts.join('\n\n')
}

/** How a message from a tool (the UI Sketcher, a plugin) is put in front of the chat. */
export function toolPrompt(toolName: string, text: string): string {
  return `## From ${toolName}\n\n${text}`
}
