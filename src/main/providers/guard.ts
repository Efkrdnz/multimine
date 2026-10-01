/**
 * Actions that always wait for the user, automation mode or not: they leave the machine, or they
 * destroy what cannot be rebuilt. Returns a short title when the command is one of them.
 */
export function hardStop(command: string): string | null {
  const c = command.replace(/\s+/g, ' ')
  if (/\bgit\s+push\b/.test(c)) return 'git push'
  if (/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)\b/.test(c)) return 'discard git history or changes'
  if (/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/.test(c)) return 'recursive delete'
  if (/\b(npm|pnpm|yarn)\s+publish\b/.test(c)) return 'publish a package'
  if (/\b(shutdown|reboot|mkfs|format)\b/.test(c)) return 'system-level command'
  return null
}
