/**
 * Actions that always wait for the user, automation mode or not: they leave the machine, or they
 * destroy what cannot be rebuilt. Returns a short title when the command is one of them.
 */
export function hardStop(command: string): string | null {
  const c = command.replace(/\s+/g, ' ')
  // global options may sit between git and its command: `git -C dir push`
  if (/\bgit\b[^|;&]*?\spush\b/.test(c)) return 'git push'
  if (/\bgit\b[^|;&]*?\s(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+(-D|--delete\s+--force|--force\s+--delete)|restore\b|stash\s+(drop|clear))/.test(c)) return 'discard git history or changes'
  for (const m of c.matchAll(/\brm\s+([^|;&]*)/g)) if (m[1].split(' ').some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === '--recursive')) return 'recursive delete'
  if (/\bfind\b[^|;&]*\s-delete\b/.test(c)) return 'recursive delete'
  if (/\b(npm|pnpm|yarn)\s+publish\b/.test(c)) return 'publish a package'
  if (/\b(shutdown|reboot|mkfs|format)\b/.test(c)) return 'system-level command'
  return null
}

/** Commands that only look at things, and the flags that would make each of them write or run something. */
const LOOKERS: Record<string, string[]> = {
  ls: [],
  dir: [],
  cat: [],
  head: [],
  tail: [],
  wc: [],
  pwd: [],
  echo: [],
  type: [],
  which: [],
  stat: [],
  grep: [],
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  rg: ['--pre', '-z', '--search-zip'],
  tree: ['-o'],
  file: ['-C', '--compile'],
  git: ['--output', '--ext-diff', '-c', '--config-env', '--exec-path']
}
const GIT_LOOKS = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'blame', 'branch', 'rev-parse'])
const BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '-l', '--all', '--remotes', '--list', '--show-current', '--merged', '--no-merged', '--contains', '--no-color'])

/**
 * Splits a command line into the words of each command in it, or returns null when it holds
 * anything that could run or write something we cannot see from the words alone: substitution,
 * redirection, backgrounding, a newline or an unclosed quote.
 */
function commands(line: string): string[][] | null {
  // discarding output or merging stderr is harmless and common
  const cmd = line.replace(/(^|\s)[12&]?>\s*\/dev\/null(?=\s|$)/g, '$1').replace(/(^|\s)2>&1(?=\s|$)/g, '$1')
  if (/[`$<>\n\r\\(){}!]/.test(cmd)) return null
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let quoted = false
  const endWord = () => {
    if (word || quoted) words.push(word)
    word = ''
    quoted = false
  }
  const endCommand = () => {
    endWord()
    if (!words.length) return false
    out.push(words)
    words = []
    return true
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      if (ch === quote) quote = null
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
    } else if (ch === ' ' || ch === '\t') endWord()
    else if (ch === '|' || ch === ';' || ch === '&') {
      // `|`, `||`, `&&` and `;` join commands; a lone `&` sends one to the background
      if (ch === '&' && cmd[i + 1] !== '&') return null
      if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i++
      if (!endCommand()) return null
    } else word += ch
  }
  if (quote || !endCommand()) return null
  return out
}

function looks(words: string[]): boolean {
  const [name, ...args] = words
  // no `VAR=x cmd`, and no paths: `./ls` is whatever that file is
  if (!name || name.includes('=') || name.includes('/') || !(name in LOOKERS)) return false
  const banned = LOOKERS[name]
  if (args.some((a) => banned.includes(a.split('=')[0]))) return false
  if (name !== 'git') return true
  const [sub, ...rest] = args
  if (!sub || !GIT_LOOKS.has(sub)) return false
  if (sub !== 'branch') return true
  // `git branch x` creates a branch: only listing flags, and a pattern or commit only for a listing
  const flags = rest.filter((a) => a.startsWith('-'))
  if (flags.some((f) => !BRANCH_FLAGS.has(f.split('=')[0]))) return false
  return flags.length === rest.length || flags.some((f) => ['-l', '--list', '--contains', '--merged', '--no-merged'].includes(f.split('=')[0]))
}

/**
 * A shell command that only looks at things: every command in it is a known reader, with none of
 * the flags that make it write or run something else. Anything this cannot prove is refused to a
 * read-only agent and asked about otherwise.
 */
export function readOnlyCommand(cmd: string): boolean {
  const list = commands(cmd)
  return !!list && list.every(looks)
}
