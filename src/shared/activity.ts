/**
 * A tool call in words a person reads at a glance: a verb and the one thing it is acting on.
 * "Running · gradlew runClient", "Editing · AbilityRegistry.java", "Searching · registerAbility".
 */
export function describeTool(name: string, input: unknown): { verb: string; brief: string } {
  const n = name.replace(/^mcp__multimine__/, '').replace(/^mcp__/, '')
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const file = (p: unknown) => str(p).split(/[\\/]/).pop() ?? ''
  const cmd = str(i.command ?? i.cmd)
  switch (n) {
    case 'Bash':
    case 'shell':
    case 'run_command':
      return { verb: 'Running', brief: shortCommand(cmd) }
    case 'BashOutput':
    case 'TaskOutput':
      return { verb: 'Watching output', brief: str(i.bash_id ?? i.task_id) }
    case 'KillShell':
    case 'KillBash':
      return { verb: 'Stopping', brief: str(i.shell_id ?? i.bash_id) }
    case 'Read':
    case 'read_file':
      return { verb: 'Reading', brief: file(i.file_path ?? i.path) }
    case 'Write':
    case 'write_file':
      return { verb: 'Writing', brief: file(i.file_path ?? i.path) }
    case 'Edit':
    case 'MultiEdit':
    case 'edit_file':
    case 'NotebookEdit':
    case 'edit':
      return { verb: 'Editing', brief: file(i.file_path ?? i.path ?? i.notebook_path) }
    case 'Grep':
    case 'Glob':
    case 'search':
    case 'list_files':
      return { verb: 'Searching', brief: str(i.pattern ?? i.query ?? i.path) }
    case 'WebFetch':
    case 'WebSearch':
    case 'web_search':
      return { verb: 'Browsing', brief: str(i.url ?? i.query) }
    case 'Task':
    case 'Agent':
      return { verb: 'Sub-agent', brief: str(i.description ?? i.subagent_type) }
    case 'TodoWrite':
      return { verb: 'Planning', brief: '' }
    case 'message_agent':
    case 'delegate':
      return { verb: n === 'delegate' ? 'Delegating' : 'Messaging', brief: str(i.agent ?? i.to) }
    case 'report':
      return { verb: 'Reporting', brief: '' }
    case 'ask_user':
      return { verb: 'Asking you', brief: '' }
    default:
      return { verb: n, brief: str(i.path ?? i.file_path ?? i.title ?? i.query ?? '') }
  }
}

/** A command as it is worth showing: no `cd ... &&` prefix, no `./`, no shell noise, short. */
export function shortCommand(cmd: string): string {
  let c = cmd.trim().replace(/\s+/g, ' ')
  c = c.replace(/^(cd\s+("[^"]*"|\S+)\s*(&&|;)\s*)+/, '')
  c = c.replace(/^\.[\\/]/, '')
  return c.length > 80 ? `${c.slice(0, 77)}...` : c
}

/** m:ss, or h:mm:ss past an hour. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "45s", "3m 10s", "1h 4m": a finished duration. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const DONE: Record<string, [string, string, string]> = {
  // verb -> [past tense, one, many]
  Reading: ['Read', 'file', 'files'],
  Writing: ['Wrote', 'file', 'files'],
  Editing: ['Edited', 'file', 'files'],
  Running: ['Ran', 'command', 'commands'],
  Searching: ['Searched', 'time', 'times'],
  Browsing: ['Browsed', 'page', 'pages'],
  'Sub-agent': ['Ran', 'sub-agent', 'sub-agents'],
  Messaging: ['Messaged', 'agent', 'agents'],
  Delegating: ['Delegated', 'task', 'tasks']
}

/** A run of tool calls said in a line: "Read 4 files · Edited 2 files · Ran 1 command". */
export function workSummary(calls: { name: string; input: unknown }[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) {
    const v = describeTool(c.name, c.input).verb
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([v, n], i) => {
      const d = DONE[v]
      const head = d ? `${d[0]} ${n} ${n === 1 ? d[1] : d[2]}` : `${v} ${n === 1 ? '' : `×${n}`}`.trim()
      return i === 0 ? head : head.charAt(0).toLowerCase() + head.slice(1)
    })
    .join(' · ')
}
