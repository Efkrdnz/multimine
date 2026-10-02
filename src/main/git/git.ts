import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GhItem, GitCommit, GitFile, GitStatus } from '@shared/types'

export interface RunResult {
  ok: boolean
  out: string
  err: string
}

function run(cmd: string, args: string[], cwd: string, input?: string, timeout = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout, maxBuffer: 20_000_000, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: String(stdout), err: String(stderr || (error && !stderr ? error.message : '')) })
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** Reads `git status --porcelain=v1 -b`: the branch line, then two status letters and a path per file. */
export function parseStatus(text: string): Omit<GitStatus, 'isRepo' | 'remote'> {
  const lines = text.split('\n').filter(Boolean)
  let branch = ''
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  const files: GitFile[] = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      // "main...origin/main [ahead 1, behind 2]", "No commits yet on main", "HEAD (no branch)"
      let head = line.slice(3).replace(/^(No commits yet on|Initial commit on) /, '')
      const bracket = /\s*\[([^\]]*)\]$/.exec(head)
      const counts = bracket?.[1] ?? ''
      if (bracket) head = head.slice(0, bracket.index)
      const dots = head.indexOf('...')
      branch = dots >= 0 ? head.slice(0, dots) : head
      upstream = dots >= 0 ? head.slice(dots + 3) : undefined
      ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0)
      behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0)
      continue
    }
    const x = line[0]
    const y = line[1]
    let path = line.slice(3)
    let from: string | undefined
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) {
      from = path.slice(0, arrow)
      path = path.slice(arrow + 4)
    }
    path = path.replace(/^"(.*)"$/, '$1')
    files.push({ path, from, index: x, worktree: y, staged: x !== ' ' && x !== '?', untracked: x === '?' })
  }
  return { branch, upstream, ahead, behind, files }
}

/** `owner/repo` from a GitHub remote URL (https or ssh), or null for any other host. */
export function githubRepo(remote: string | undefined): string | null {
  if (!remote) return null
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** The project's git repository, driven through the git CLI. Every call is relative to the project folder. */
export class Git {
  constructor(private readonly dir: string) {}

  private git(args: string[], input?: string, timeout?: number) {
    return run('git', args, this.dir, input, timeout)
  }

  private async must(args: string[], timeout?: number): Promise<string> {
    const r = await this.git(args, undefined, timeout)
    if (!r.ok) throw new Error((r.err || r.out).trim() || `git ${args[0]} failed`)
    return r.out
  }

  async status(): Promise<GitStatus> {
    const inside = await this.git(['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok) return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [] }
    const st = await this.git(['status', '--porcelain=v1', '-b', '--untracked-files=all'])
    const remote = (await this.git(['remote', 'get-url', 'origin'])).out.trim() || undefined
    return { isRepo: true, remote, ...parseStatus(st.out) }
  }

  async init(): Promise<void> {
    await this.must(['init'])
  }

  async diff(path: string, staged: boolean, untracked: boolean): Promise<string> {
    if (untracked) {
      const text = await readFile(join(this.dir, path), 'utf8').catch(() => '(binary or unreadable file)')
      return `new file: ${path}\n` + text.split('\n').slice(0, 2000).map((l) => `+${l}`).join('\n')
    }
    const r = await this.git(['diff', ...(staged ? ['--cached'] : []), '--', path])
    return r.out || '(no textual changes)'
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length) await this.must(['add', '--', ...paths])
  }

  async unstage(paths: string[]): Promise<void> {
    if (!paths.length) return
    const r = await this.git(['restore', '--staged', '--', ...paths])
    // a repository with no commit yet has nothing to restore from
    if (!r.ok) await this.must(['rm', '--cached', '-r', '--quiet', '--', ...paths])
  }

  async commit(message: string): Promise<string> {
    if (!message.trim()) throw new Error('Write a commit message first.')
    return (await this.must(['commit', '-m', message])).trim()
  }

  async log(limit = 60): Promise<GitCommit[]> {
    const r = await this.git(['log', `-n${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%s'])
    if (!r.ok) return []
    return r.out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, short, author, when, subject] = l.split('\x1f')
        return { hash, short, author, when, subject }
      })
  }

  async show(hash: string): Promise<string> {
    return (await this.must(['show', '--stat', '--patch', '--format=%H%n%an <%ae>%n%ad%n%n%B', hash])).slice(0, 400_000)
  }

  async branches(): Promise<{ current: string; local: string[] }> {
    const r = await this.git(['branch', '--format=%(refname:short)'])
    const current = (await this.git(['branch', '--show-current'])).out.trim()
    return { current, local: r.out.split('\n').map((s) => s.trim()).filter(Boolean) }
  }

  async checkout(name: string, create: boolean): Promise<void> {
    await this.must(create ? ['checkout', '-b', name] : ['checkout', name])
  }

  async pull(): Promise<string> {
    return (await this.must(['pull', '--ff-only'], 180_000)).trim() || 'Up to date.'
  }

  async push(): Promise<string> {
    const r = await this.git(['push', '-u', 'origin', 'HEAD'], undefined, 180_000)
    if (!r.ok) throw new Error((r.err || r.out).trim())
    return (r.err || r.out).trim() || 'Pushed.'
  }
}

/**
 * GitHub through whichever door is open: a token from Settings (REST), or the user's logged-in gh
 * CLI (`gh api`). The token wins when both exist, because it is what the user gave Multimine.
 */
export class GitHub {
  constructor(
    private readonly dir: string,
    private readonly token: () => string | undefined
  ) {}

  async auth(): Promise<'token' | 'gh' | null> {
    if (this.token()) return 'token'
    const r = await run('gh', ['auth', 'status'], this.dir, undefined, 10_000)
    return r.ok ? 'gh' : null
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const token = this.token()
    if (token) {
      const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'multimine' },
        body: body ? JSON.stringify(body) : undefined
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${json.message ?? res.statusText}`)
      return json
    }
    const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json']
    if (body) args.push('--input', '-')
    const r = await run('gh', args, this.dir, body ? JSON.stringify(body) : undefined, 60_000)
    if (!r.ok) throw new Error((r.err || r.out).trim() || 'gh api failed. Log in with `gh auth login` or add a GitHub token.')
    return JSON.parse(r.out || 'null')
  }

  async list(repo: string, kind: 'pulls' | 'issues'): Promise<GhItem[]> {
    const items = (await this.request('GET', `/repos/${repo}/${kind}?state=open&per_page=50`)) as any[]
    return items
      .filter((i) => kind === 'pulls' || !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        author: i.user?.login ?? '',
        updated: i.updated_at,
        head: i.head?.ref,
        base: i.base?.ref,
        draft: !!i.draft,
        labels: (i.labels ?? []).map((l: any) => l.name)
      }))
  }

  async defaultBranch(repo: string): Promise<string> {
    return ((await this.request('GET', `/repos/${repo}`)) as any).default_branch ?? 'main'
  }

  async createPr(repo: string, head: string, base: string, title: string, body: string): Promise<GhItem> {
    const pr = await this.request('POST', `/repos/${repo}/pulls`, { title, body, head, base })
    return { number: pr.number, title: pr.title, url: pr.html_url, author: pr.user?.login ?? '', updated: pr.updated_at, head, base, draft: false, labels: [] }
  }
}
