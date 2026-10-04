import { cellText, tablePath, type Table } from './model'

/** The most a context table may add to every chat's prompt; past it, rows are left out (and it says so). */
export const CONTEXT_CHARS = 6000
const ALL_CONTEXT_CHARS = 16000

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** One table as a chat reads it: a markdown table, ideas marked, the files its rows live in. */
export function tableMarkdown(t: Table, max = CONTEXT_CHARS): string {
  const head = `| ${t.columns.map((c) => esc(c.label)).join(' | ')} |\n|${t.columns.map(() => '---').join('|')}|`
  const lines: string[] = []
  let size = head.length
  let shown = 0
  for (const r of t.rows) {
    const line = `| ${t.columns.map((c, i) => esc(cellText(r.cells[c.key])) + (i === 0 && r.idea ? ' (idea)' : '')).join(' | ')} |`
    if (size + line.length > max) break
    lines.push(line)
    size += line.length + 1
    shown++
  }
  const files = [...new Set(t.rows.filter((r) => !r.idea).map((r) => r.file ?? Object.values(r.links ?? {})[0]?.file).filter(Boolean))]
  const notes = t.columns.filter((c) => c.note).map((c) => `${c.label}: ${c.note}`)
  return [
    `### ${t.name} (\`${tablePath(t.id)}\`)`,
    t.description ?? '',
    notes.length ? `Columns: ${notes.join('; ')}` : '',
    head,
    ...lines,
    shown < t.rows.length ? `(${t.rows.length - shown} more rows in the file)` : '',
    t.rows.some((r) => r.idea) ? 'Rows marked (idea) are not in the code yet: the user\'s reference values for new work.' : '',
    files.length ? `Code: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', ...' : ''}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The tables the user switched on as context, for every chat's system prompt. They answer "what
 * are the numbers" without reading a single class.
 */
export function contextSection(tables: Table[]): string {
  const on = tables.filter((t) => t.context && t.columns.length)
  if (!on.length) return ''
  const parts: string[] = []
  let size = 0
  for (const t of on) {
    const md = tableMarkdown(t)
    if (size + md.length > ALL_CONTEXT_CHARS) {
      parts.push(`(More tables in \`.multimine/tables/\`: ${on.slice(parts.length).map((x) => x.name).join(', ')}; \`read_table\` reads one.)`)
      break
    }
    parts.push(md)
    size += md.length
  }
  return [
    '## Project tables',
    'The user keeps these values in Multimine tables, linked to the code. Use them instead of searching the code for a value. The code is the truth: when you change a value a table tracks, the table follows.',
    ...parts
  ].join('\n\n')
}

/** The format a chat writes a table in, and how to link a cell to the code. */
export const TABLE_FORMAT = `Save it with the \`save_table\` tool:
- \`name\`, and \`id\` (a short slug; reuse an existing table's id to replace that table)
- \`description\`: one sentence on what it holds
- \`columns\`: [{ "key": "mana", "label": "Mana usage", "type": "number" | "text" | "enum" | "bool", "note": "what it means, e.g. per second, negative heals" }]
  For an enum, list \`values\`, and \`colors\` as { "fire": "#f97316" } when colours help (elements, rarities).
- \`rows\`: [{ "id": "fireball", "cells": { "name": "Fireball", "mana": 20, ... }, "file": "path/to/Fireball.java", "links": { "mana": { "file": "path/to/Fireball.java", "line": 42, "before": "MANA_COST = ", "after": ";" } } }]

Link every cell whose value is written in the code: \`file\` (from the project root), \`line\` (1-based),
and the exact text right before and right after the value on that line, so the value can be found
again and rewritten. Only link a value that appears as one literal (a number, a string, true/false);
a value computed at runtime gets no link and a \`note\` on its column saying how it is computed.
\`save_table\` checks every link against the file and tells you which did not match: fix them and
save again. Read only the files you need.`

/** What `/table ...` in a chat sends: the request, the format, and the tables that already exist. */
export function tableCommandPrompt(request: string, existing: Table[]): string {
  return [
    '# Make or change a table',
    'The user typed `/table`. Build the table they describe from the project\'s code, and save it.',
    '',
    '## Request',
    request.trim() || '(nothing more: ask what the table should hold)',
    '',
    '## How',
    TABLE_FORMAT,
    existing.length ? `\n## Tables that already exist\n${existing.map((t) => `- \`${t.id}\`: ${t.name} (${t.rows.length} rows; ${t.columns.map((c) => c.label).join(', ')})`).join('\n')}\nIf the request is about one of them, change that one (same id; \`read_table\` reads it) instead of making a new one.` : '',
    '',
    'When it is saved, answer in one or two sentences: what the table holds and anything you could not find or link.'
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n')
}

/** Asks a chat to change a table the way the user describes. */
export function changeTablePrompt(t: Table, request: string): string {
  return [
    `# Change the table "${t.name}"`,
    '',
    '## Request',
    request.trim(),
    '',
    `The table now (\`${tablePath(t.id)}\`, id \`${t.id}\`):`,
    '```json',
    JSON.stringify({ id: t.id, name: t.name, description: t.description, columns: t.columns, rows: t.rows }),
    '```',
    '',
    TABLE_FORMAT,
    '',
    `Keep the id \`${t.id}\`, and keep every row, link and value the request does not touch.`
  ].join('\n')
}

/** Asks a chat to build the ideas the user added to a table, with their values, and link them back. */
export function implementPrompt(t: Table, rowIds: string[]): string {
  const rows = t.rows.filter((r) => rowIds.includes(r.id))
  const done = t.rows.filter((r) => !r.idea && (r.file || r.links)).slice(0, 3)
  return [
    `# Implement ${rows.length === 1 ? `"${cellText(rows[0].cells[t.columns[0].key])}"` : `${rows.length} new rows`} from the table "${t.name}"`,
    '',
    `The user added ${rows.length === 1 ? 'this row' : 'these rows'} to the table as new ideas, with the values to use:`,
    '',
    `| ${t.columns.map((c) => esc(c.label)).join(' | ')} |\n|${t.columns.map(() => '---').join('|')}|\n${rows.map((r) => `| ${t.columns.map((c) => esc(cellText(r.cells[c.key]))).join(' | ')} |`).join('\n')}`,
    '',
    t.columns.some((c) => c.note) ? `What the columns mean: ${t.columns.filter((c) => c.note).map((c) => `${c.label}: ${c.note}`).join('; ')}` : '',
    done.length ? `Build ${rows.length === 1 ? 'it' : 'them'} the way the existing rows are built - for example ${done.map((r) => `\`${r.file ?? Object.values(r.links ?? {})[0]?.file}\``).join(', ')}.` : 'Build them the way the project builds things of this kind.',
    `Use exactly these values. When ${rows.length === 1 ? 'it builds' : 'they build'}, link the new code back: read the table with \`read_table\` (id \`${t.id}\`) and save it with \`save_table\`, the same rows with \`idea\` removed and \`file\` and \`links\` filled in, everything else unchanged.`,
    '',
    TABLE_FORMAT
  ]
    .filter(Boolean)
    .join('\n')
}
