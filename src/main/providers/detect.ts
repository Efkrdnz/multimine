import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliStatus } from '@shared/types'

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })
    })
  })
}

export async function detectClaude(path?: string): Promise<CliStatus> {
  const r = await run(path || 'claude', ['--version'])
  if (!r.ok) return { installed: false, detail: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in. The bundled runtime may still work if you are logged in.' }
  const creds = existsSync(join(homedir(), '.claude', '.credentials.json')) || !!process.env.ANTHROPIC_API_KEY || process.platform === 'darwin'
  return { installed: true, version: r.out.split('\n')[0], loggedIn: creds, detail: creds ? undefined : 'Run `claude` in a terminal and log in with your subscription.' }
}

export async function detectCodex(path?: string): Promise<CliStatus> {
  const exe = path || 'codex'
  const r = await run(exe, ['--version'])
  if (!r.ok) return { installed: false, detail: 'Install the Codex CLI (npm i -g @openai/codex) and run `codex login`.' }
  const login = await run(exe, ['login', 'status'])
  const loggedIn = login.ok && !/not logged in/i.test(login.out)
  return { installed: true, version: r.out.split('\n')[0], loggedIn, detail: loggedIn ? login.out.split('\n')[0] : 'Run `codex login` and sign in with ChatGPT.' }
}
