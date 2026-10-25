import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, sep } from 'node:path'
import { cellText, type Table } from '@shared/tables/model'
import type { Workspace } from '../app'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** How many rows a table picture shows; the CSV beside it has them all. */
export const TABLE_ROWS = 40

/** A table as a small dark web page, to be photographed for Telegram: its colours, its first rows. */
export function tableHtml(t: Table, project: string, maxRows = TABLE_ROWS): string {
  const rows = t.rows.slice(0, maxRows)
  const head = t.columns.map((c) => `<th class="${c.type === 'number' ? 'n' : ''}">${esc(c.label)}</th>`).join('')
  const body = rows
    .map((r) => {
      const cells = t.columns.map((c) => {
        const v = cellText(r.cells[c.key] ?? null)
        if (c.type === 'enum' && v) {
          const color = c.colors?.[v] ?? '#6366f1'
          return `<td><span class="chip" style="background:${esc(color)}33;color:${esc(color)};border-color:${esc(color)}66">${esc(v)}</span></td>`
        }
        if (c.type === 'bool') return `<td>${v === 'true' ? '✓' : v === 'false' ? '–' : esc(v)}</td>`
        return `<td class="${c.type === 'number' ? 'n' : ''}">${esc(v)}</td>`
      })
      return `<tr${r.idea ? ' class="idea"' : ''}>${cells.join('')}</tr>`
    })
    .join('')
  const more = t.rows.length > rows.length ? `<div class="more">Showing ${rows.length} of ${t.rows.length} rows: all of them are in the CSV.</div>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html{background:#0b0d1f;overflow:hidden}body{margin:0;padding:22px 24px;background:#0b0d1f;color:#e0e7ff;font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;width:fit-content;min-width:520px}
h1{font-size:19px;margin:0 0 2px;color:#fff}.sub{color:#a5b4fc;font-size:12px;margin-bottom:14px}
table{border-collapse:collapse;border:1px solid #2a2f5a;border-radius:10px;overflow:hidden}
th{background:#1a1d40;color:#c7d2fe;text-align:left;font-size:12px;letter-spacing:.03em;padding:8px 12px;white-space:nowrap}
td{padding:7px 12px;border-top:1px solid #20244a;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
tr:nth-child(even) td{background:#10132b}.n{text-align:right;font-variant-numeric:tabular-nums}
tr.idea td{color:#fcd34d}.chip{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid;font-size:12px}
.more{color:#a5b4fc;font-size:12px;margin-top:10px}</style></head><body>
<h1>${esc(t.name)}</h1><div class="sub">${esc(project)} · ${t.rows.length} rows${t.description ? ` · ${esc(t.description)}` : ''}</div>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}</body></html>`
}

/** The whole table as CSV, for a spreadsheet. */
export function tableCsv(t: Table): string {
  const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [t.columns.map((c) => q(c.label)).join(','), ...t.rows.map((r) => t.columns.map((c) => q(cellText(r.cells[c.key] ?? null))).join(','))]
  return `﻿${lines.join('\r\n')}\r\n`
}

/** The table as aligned plain text, when there is no way to take a picture of it. */
export function tableText(t: Table, maxRows = 25): string {
  const cols = t.columns.slice(0, 6)
  const rows = t.rows.slice(0, maxRows).map((r) => cols.map((c) => cellText(r.cells[c.key] ?? null).slice(0, 18)))
  const widths = cols.map((c, i) => Math.max(c.label.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i])).join('  ')
  return [line(cols.map((c) => c.label)), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

export interface Shot {
  /** Absolute path. */
  path: string
  ts: number
  chat: string
  project: string
  /** In the media gallery, a file a turn wrote, or one a chat looked at (a screenshot it took to check). */
  source: 'gallery' | 'changed' | 'viewed'
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i

/** Every string inside a tool call's input. */
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])

/**
 * Image paths a tool call mentions: an input that is itself one (the file it read, spaces and all),
 * and any word in its input or output that is one (a screenshot a command saved).
 */
function mentioned(input: unknown, output = ''): string[] {
  const out = new Set<string>()
  const values = strings(input)
  for (const v of values) if (IMAGE.test(v.trim()) && !/\n/.test(v)) out.add(v.trim())
  for (const text of [...values, output])
    for (const word of text.split(/[\s"'`<>()|,;]+/)) {
      const p = word.replace(/[.:]+$/, '')
      if (IMAGE.test(p)) out.add(p)
    }
  return [...out]
}

/**
 * The pictures chats made or looked at while they worked, newest first: their gallery items, the
 * image files their turns wrote, and image files their tool calls read or printed (a screenshot
 * Claude Code took to see the game, say). Images the user attached are left out.
 */
export function recentShots(spaces: Workspace[], o: { chat?: string; project?: string; limit?: number } = {}): Shot[] {
  const found = new Map<string, Shot>()
  const add = (s: Shot) => {
    const key = normalize(s.path)
    if (key.includes(`${sep}.multimine${sep}media${sep}attachments${sep}`)) return
    const prev = found.get(key)
    if (prev && prev.ts >= s.ts) return
    try {
      if (!existsSync(key) || !statSync(key).isFile()) return
    } catch {
      return
    }
    found.set(key, { ...s, path: key })
  }
  const want = (name: string, id: string) => !o.chat || id === o.chat || name.toLowerCase().includes(o.chat.toLowerCase())
  for (const ws of spaces) {
    const project = basename(ws.dir)
    if (o.project && project.toLowerCase() !== o.project.toLowerCase() && ws.dir !== o.project) continue
    const resolve = (p: string) => (isAbsolute(p) ? p : join(ws.dir, p))
    for (const chat of ws.project.list()) {
      if (!want(chat.name, chat.id)) continue
      for (const m of ws.engine.media) if (m.agentId === chat.id && m.kind === 'image') add({ path: m.path, ts: m.ts, chat: chat.name, project, source: 'gallery' })
      for (const msg of ws.engine.chats[chat.id] ?? []) {
        if (msg.role !== 'assistant') continue
        for (const f of msg.changes?.files ?? []) if (f.status !== 'D' && IMAGE.test(f.path)) add({ path: resolve(f.path), ts: msg.ts, chat: chat.name, project, source: 'changed' })
        for (const t of msg.tools ?? []) {
          for (const p of mentioned(t.input, t.output)) add({ path: resolve(p), ts: t.startedAt ?? msg.ts, chat: chat.name, project, source: 'viewed' })
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.min(10, o.limit ?? 5)))
}
