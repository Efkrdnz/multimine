import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTable, tableJson, type Table } from '@shared/tables/model'
import { locate, sameValue } from '@shared/tables/links'
import { insideProject } from '../chat/workspace'
import { writeAtomic } from './fsx'

/** What checking a table's links against the code found. */
export interface LinkReport {
  links: number
  verified: number
  /** `row.column: why`, for each link that did not match. */
  broken: string[]
}

/** The project's tables, in `.multimine/tables/`. */
export class TableStore {
  constructor(private readonly projectDir: string) {}

  private get dir(): string {
    return join(this.projectDir, '.multimine', 'tables')
  }

  async list(): Promise<Table[]> {
    let files: string[] = []
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort()
    } catch {
      return []
    }
    const out: Table[] = []
    for (const f of files) {
      try {
        out.push(parseTable(JSON.parse(await readFile(join(this.dir, f), 'utf8')), f.slice(0, -5)).table)
      } catch {
        // a file that is not a table (or not JSON) is skipped, not fatal
      }
    }
    return out
  }

  async get(id: string): Promise<Table | null> {
    return (await this.list()).find((t) => t.id === id) ?? null
  }

  async save(t: Table): Promise<void> {
    await writeAtomic(join(this.dir, `${t.id}.json`), tableJson({ ...t, updated: Date.now() }))
  }

  /**
   * Checks every link against its file. A link that matches keeps its line up to date and the cell
   * takes the code's value (the code is the truth); one that does not is dropped and reported.
   */
  async verify(t: Table): Promise<{ table: Table; report: LinkReport }> {
    const texts = new Map<string, string | null>()
    const read = async (file: string) => {
      if (!texts.has(file)) {
        try {
          texts.set(file, await readFile(insideProject(this.projectDir, file), 'utf8'))
        } catch {
          texts.set(file, null)
        }
      }
      return texts.get(file)!
    }
    const report: LinkReport = { links: 0, verified: 0, broken: [] }
    const rows = []
    for (const row of t.rows) {
      if (!row.links) {
        rows.push(row)
        continue
      }
      const links: NonNullable<typeof row.links> = {}
      const cells = { ...row.cells }
      for (const [key, link] of Object.entries(row.links)) {
        report.links++
        const text = await read(link.file)
        const found = text === null ? null : locate(text, link)
        if (!found) {
          report.broken.push(`${row.id}.${key}: ${text === null ? `no file ${link.file}` : `"${link.before}...${link.after}" is not in ${link.file}`}`)
          continue
        }
        report.verified++
        links[key] = { ...link, line: found.line }
        if (!sameValue(cells[key], found.value)) cells[key] = found.value
      }
      rows.push({ ...row, cells, links: Object.keys(links).length ? links : undefined })
    }
    return { table: { ...t, rows }, report }
  }
}
