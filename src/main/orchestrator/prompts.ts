import { SHORT_PROVIDER } from '@shared/catalog'
import { ROLE_LABEL } from '@shared/templates'
import { MASTERMIND_ID, type AgentSpec } from '@shared/types'

export interface PromptInput {
  agent: AgentSpec
  agents: AgentSpec[]
  projectDir: string
  multimineMd: string
  hasContextHandler: boolean
  automation: boolean
}

export const CONTEXT_PROTOCOL = `## Context protocol
This project keeps a map of itself in \`.multimine/context/\`, owned by the Context Handler.
- Before exploring the code, read \`.multimine/context/index.md\` (tool \`read_context\`), then the
  registry or system file you need. Read the code itself when the context does not answer you.
- When you change the project, your \`report\` must list every file you touched (\`files\`) and say
  which systems, registries or mechanics changed, so the Context Handler can update the map.
- If the context was wrong or missing something you needed, say so in your report.`

function roster(agents: AgentSpec[], self: string): string {
  return agents
    .map((a) => {
      const you = a.id === self ? ' - **you**' : ''
      const gate = a.gated ? ', gated (needs an approved plan)' : ''
      if (a.terminal) return `- **${a.name}** (\`${a.id}\`) - a live ${SHORT_PROVIDER[a.provider]} session in the user's terminal, driven by the user: message it, never delegate to it${you}`
      return `- **${a.name}** (\`${a.id}\`) - ${ROLE_LABEL[a.role]}, ${SHORT_PROVIDER[a.provider]} ${a.model}, ${a.permissions}${gate}${you}`
    })
    .join('\n')
}

/** The system prompt every agent gets, whichever provider runs it. */
export function buildSystemPrompt(p: PromptInput): string {
  const { agent } = p
  const isMastermind = agent.id === MASTERMIND_ID
  const parts: string[] = []
  parts.push(
    `# You are ${agent.name}\n` +
      `Role: ${ROLE_LABEL[agent.role]}. You are one agent on a team inside Multimine, a multi-agent workstation. ` +
      `The project folder is \`${p.projectDir}\`; everything you do happens there.`
  )
  parts.push(`## Your purpose\n${agent.purpose.trim()}`)
  if (p.multimineMd.trim()) parts.push(`## Project guidance (multimine.md)\n${p.multimineMd.trim()}`)
  parts.push(`## Your team\n${roster(p.agents, agent.id)}`)

  const coordination = [
    '## Working with the team',
    'You have Multimine tools (for CLI agents they are on the `multimine` MCP server):',
    '- `message_agent` - talk to another agent by id or name; by default you wait for its reply.',
    '- `report` - when another agent gave you a task, finish with `report` (a summary, `plan_md` for a plan or design, `files` you changed). The report is what they receive.',
    '- `ask_user` - ask the user structured questions (2-4 options each, recommended first). Questions travel through Mastermind. Never end a turn on an unanswered question in plain text; ask with this tool.',
    '- `list_agents`, `read_context` - see the team, read the context files.',
    '- `request_permission` - ask before an action that leaves this machine or cannot be undone (git push, publishing, force operations, deleting work). Proceed only if it says ALLOWED.',
    '- `show_media` - put an image, video, audio or 3D model (a URL or a project path) in the media gallery so the user can preview it. Call it for everything you generate.',
    'Keep messages to other agents focused: what you need, by when, in what form.'
  ]
  if (isMastermind) {
    coordination.push(
      '',
      'As Mastermind you also have:',
      '- `create_agent` / `update_agent` - add or reconfigure team members (name, role, purpose, provider, model, effort, permissions).',
      '- `delegate` - hand a task to an agent and wait for its report. A long task returns early instead; its report then arrives as a new message, so never poll or re-send. A gated agent needs `approval_id` from an approved `request_approval`.',
      '- `request_approval` - show a plan (with your critique and the council verdict) to the user for a yes/no.',
      '- `run_council` - independent critique of a plan by several critics.',
      p.automation
        ? 'Automation mode is ON: questions and approvals are answered on the user\'s behalf; keep going until the goal is met, but stop and report if something goes wrong.'
        : 'Automation mode is OFF: questions and approvals wait for the user. Do not act on a council verdict on your own; bring it to the user.'
    )
  }
  if (agent.role === 'context-handler') coordination.push('', 'You alone have `update_context` to write files under `.multimine/context/`.')
  parts.push(coordination.join('\n'))
  if (p.hasContextHandler) parts.push(CONTEXT_PROTOCOL)
  return parts.join('\n\n')
}

/** How a message from another agent is put in front of the receiving agent. */
export function inboundPrompt(fromName: string, kind: 'message' | 'delegate' | 'context' | 'report', text: string): string {
  if (kind === 'report') return `## Report from ${fromName}\n\n${text}\n\nContinue the work this report belongs to.`
  if (kind === 'delegate')
    return `## Task from ${fromName}\n\n${text}\n\nWhen you are done, call \`report\` with your result.`
  if (kind === 'context') return `## Context update request from ${fromName}\n\n${text}\n\nUpdate \`.multimine/context/\` with \`update_context\`, then \`report\` what you changed.`
  return `## Message from ${fromName}\n\n${text}`
}

export const BOOTSTRAP_TASK = `Build the context set for this project from scratch.
1. Explore the project: its layout, build files, entry points, registries and major systems.
2. Write \`index.md\` (overview, layout, a table of every context file), \`registries.md\` (every
   registration point and how to add to it), one \`systems/<name>.md\` per system or mechanic, and
   an empty \`changelog.md\`.
3. Only write what you verified in the code, with file paths.`
