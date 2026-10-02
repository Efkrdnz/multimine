import { exec } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Permission } from '@shared/types'
import { hardStop } from '../providers/guard'
import type { ToolDef } from '../providers/types'

export const SKIP = new Set(['.git', 'node_modules', 'build', 'out', 'dist', '.gradle', 'run', '.idea', 'target', '__pycache__'])
const MAX_READ = 200_000

/** Resolves a path the model gave inside the project, refusing anything that escapes it. */
export function insideProject(root: string, p: string): string {
  const full = resolve(root, isAbsolute(p) ? relative(root, p) : p)
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${p} is outside the project`)
  return full
}

export async function walk(root: string, dir: string, depth: number, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) return
    if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.multimine')) continue
    const full = join(dir, e.name)
    const rel = relative(root, full).split(sep).join('/')
    if (e.isDirectory()) {
      out.push(rel + '/')
      if (depth > 0) await walk(root, full, depth - 1, out, limit)
    } else out.push(rel)
  }
}

function globToRegex(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.')
  return new RegExp(`(^|/)${re}$`)
}

/**
 * File tools for API-key agents (CLI agents bring their own). What an agent gets follows its
 * permission: chat gets none, read gets list/read/search, write adds write/edit/run.
 */
export function workspaceTools(
  root: string,
  permission: Permission,
  approveAction: (title: string, detail: string, always?: boolean) => Promise<boolean>
): ToolDef[] {
  if (permission === 'chat') return []
  const tools: ToolDef[] = [
    {
      name: 'list_files',
      description: 'List files and folders in the project (skips .git, node_modules, build output).',
      shape: { path: z.string().optional().describe('Folder relative to the project root'), depth: z.number().int().min(0).max(6).optional() },
      handler: async (a) => {
        const base = insideProject(root, String(a.path ?? '.'))
        const out: string[] = []
        await walk(root, base, Number(a.depth ?? 1), out, 800)
        return { text: out.join('\n') || '(empty)' }
      }
    },
    {
      name: 'read_file',
      description: 'Read a text file in the project. Use offset/limit (lines) for big files.',
      shape: { path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).optional() },
      handler: async (a) => {
        const text = await readFile(insideProject(root, String(a.path)), 'utf8')
        const lines = text.split('\n')
        const from = Number(a.offset ?? 0)
        const to = a.limit ? from + Number(a.limit) : lines.length
        const body = lines
          .slice(from, to)
          .map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`)
          .join('\n')
        return { text: body.length > MAX_READ ? body.slice(0, MAX_READ) + '\n... (truncated; use offset/limit)' : body }
      }
    },
    {
      name: 'search',
      description: 'Search file contents with a regular expression. Returns path:line: text.',
      shape: { pattern: z.string(), path: z.string().optional(), glob: z.string().optional().describe('e.g. **/*.java') },
      handler: async (a) => {
        const re = new RegExp(String(a.pattern), 'i')
        const files: string[] = []
        await walk(root, insideProject(root, String(a.path ?? '.')), 30, files, 20000)
        const g = a.glob ? globToRegex(String(a.glob)) : null
        const hits: string[] = []
        for (const f of files) {
          if (f.endsWith('/') || (g && !g.test(f))) continue
          const full = join(root, f)
          try {
            if ((await stat(full)).size > 2_000_000) continue
            const lines = (await readFile(full, 'utf8')).split('\n')
            lines.forEach((l, i) => {
              if (hits.length < 300 && re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 240)}`)
            })
          } catch {
            // binary or unreadable
          }
          if (hits.length >= 300) break
        }
        return { text: hits.join('\n') || 'No matches.' }
      }
    }
  ]
  if (permission !== 'write') return tools
  tools.push(
    {
      name: 'write_file',
      description: 'Create or overwrite a file in the project.',
      shape: { path: z.string(), content: z.string() },
      handler: async (a) => {
        const full = insideProject(root, String(a.path))
        if (!(await approveAction(`write ${a.path}`, String(a.content).slice(0, 1500)))) return { text: 'The user did not allow this write.', isError: true }
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, String(a.content), 'utf8')
        return { text: `Wrote ${a.path}` }
      }
    },
    {
      name: 'edit_file',
      description: 'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all.',
      shape: { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
      handler: async (a) => {
        const full = insideProject(root, String(a.path))
        if (!(await approveAction(`edit ${a.path}`, `- ${String(a.old_string).slice(0, 700)}\n+ ${String(a.new_string).slice(0, 700)}`))) return { text: 'The user did not allow this edit.', isError: true }
        const text = await readFile(full, 'utf8')
        const old = String(a.old_string)
        const count = text.split(old).length - 1
        if (count === 0) return { text: 'old_string not found', isError: true }
        if (count > 1 && !a.replace_all) return { text: `old_string occurs ${count} times; make it unique or set replace_all`, isError: true }
        await writeFile(full, a.replace_all ? text.split(old).join(String(a.new_string)) : text.replace(old, () => String(a.new_string)), 'utf8')
        return { text: `Edited ${a.path} (${a.replace_all ? count : 1} replacement${count > 1 && a.replace_all ? 's' : ''})` }
      }
    },
    {
      name: 'run_command',
      description: 'Run a shell command in the project folder (build, test, git status...). 3 minute limit.',
      shape: { command: z.string() },
      handler: async (a) => {
        const cmd = String(a.command)
        const stop = hardStop(cmd)
        if (!(await approveAction(stop ?? `run: ${cmd.slice(0, 60)}`, cmd, !!stop))) return { text: `The user did not allow: ${stop ?? cmd}`, isError: true }
        return new Promise((done) =>
          exec(cmd, { cwd: root, timeout: 180_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
            const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(-60_000)
            done({ text: `${err ? `exit ${err.code ?? 1}\n` : ''}${out}` || '(no output)', isError: !!err })
          })
        )
      }
    }
  )
  return tools
}
