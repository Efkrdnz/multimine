import { describe, expect, it } from 'vitest'
import { addColumn, addRow, emptyTable, enumColor, parseTable, removeColumn, setCell, type Table } from '@shared/tables/model'
import { formatLiteral, locate, parseLiteral, patch, planChanges, readFromCode } from '@shared/tables/links'
import { contextSection, implementPrompt, tableCommandPrompt, tableMarkdown } from '@shared/tables/prompt'

const FIREBALL = `package mod.spells;

public class Fireball extends Spell {
    public static final int MANA_COST = 20;
    public static final float COOLDOWN = 2.5f;
    private static final String ELEMENT = "fire";
    public static final double DAMAGE = 8; // per hit
}
`

const spells = (): Table =>
  parseTable({
    id: 'spells',
    name: 'Spells',
    columns: [
      { key: 'name', label: 'Spell', type: 'text' },
      { key: 'mana', label: 'Mana usage', type: 'number' },
      { key: 'cooldown', label: 'Cooldown', type: 'number', note: 'seconds' },
      { key: 'element', label: 'Element', type: 'enum', values: ['fire', 'ice'], colors: { fire: '#f97316', ice: 'blue' } },
      { key: 'damage', label: 'Base damage', type: 'number', note: 'negative heals' }
    ],
    rows: [
      {
        id: 'fireball',
        file: 'src/Fireball.java',
        cells: { name: 'Fireball', mana: 20, cooldown: 2.5, element: 'fire', damage: 8 },
        links: {
          mana: { file: 'src/Fireball.java', line: 4, before: 'MANA_COST = ', after: ';' },
          cooldown: { file: 'src/Fireball.java', line: 5, before: 'COOLDOWN = ', after: ';' },
          element: { file: 'src/Fireball.java', line: 6, before: 'ELEMENT = ', after: ';' },
          damage: { file: 'src/Fireball.java', line: 7, before: 'DAMAGE = ', after: ';' }
        }
      },
      { id: 'mend', idea: true, cells: { name: 'Mend', mana: 15, cooldown: 4, element: 'light', damage: -6 } }
    ]
  }).table

describe('tables', () => {
  it('reads what a chat writes, repairing what cannot be trusted', () => {
    const { table, problems } = parseTable({
      name: 'Spells!',
      columns: [{ label: 'Spell' }, { label: 'Mana', type: 'number' }, { label: 'Mana', type: 'number' }, { type: 'nonsense' }],
      rows: [
        { Spell: 'Fireball', Mana: '1_000' },
        { cells: { spell: 'Fireball' }, links: { mana: { file: '../etc/passwd', before: 'x' } } }
      ]
    })
    expect(table.id).toBe('spells')
    expect(table.columns.map((c) => c.key)).toEqual(['spell', 'mana', 'mana_2'])
    expect(table.rows.map((r) => r.id)).toEqual(['fireball', 'fireball-2'])
    expect(table.rows[0].cells.mana).toBe(1000)
    expect(table.rows[1].links).toBeUndefined()
    expect(problems[0]).toContain('fireball-2.mana')
    expect(spells().columns[3].colors).toEqual({ fire: '#f97316' })
    // a value that is not one of an enum's yet becomes one
    expect(spells().columns[3].values).toEqual(['fire', 'ice', 'light'])
    expect(enumColor(spells().columns[3], 'fire')).toBe('#f97316')
  })

  it('adds and removes rows and columns, and new rows are ideas', () => {
    let t = emptyTable('Spells')
    t = addColumn(t, 'Mana usage', 'number').table
    const r = addRow(t, { name: 'Frost Nova', mana_usage: 30 })
    t = setCell(r.table, r.id, 'mana_usage', 35)
    expect(t.rows[0]).toMatchObject({ id: 'frost-nova', idea: true, cells: { name: 'Frost Nova', mana_usage: 35 } })
    expect(addRow(t, { name: 'Frost Nova' }).id).toBe('frost-nova-2')
    expect(removeColumn(t, 'mana_usage').rows[0].cells).toEqual({ name: 'Frost Nova' })
  })

  it('reads literals as values, and writes values the way the literal was written', () => {
    expect(parseLiteral('20')).toBe(20)
    expect(parseLiteral(' 2.5f')).toBe(2.5)
    expect(parseLiteral('1_000L')).toBe(1000)
    expect(parseLiteral('"fire"')).toBe('fire')
    expect(parseLiteral('true')).toBe(true)
    expect(parseLiteral('BASE * 2')).toBe('BASE * 2')
    expect(formatLiteral('20', 25)).toBe('25')
    expect(formatLiteral('2.5f', 3)).toBe('3.0f')
    expect(formatLiteral('8', 9.5)).toBe('9.5')
    expect(formatLiteral('"fire"', 'ice "cold"')).toBe('"ice \\"cold\\""')
    expect(formatLiteral('20L', 30)).toBe('30L')
  })

  it('finds a linked value where it is, follows it when the code moves, and says when it is gone', () => {
    const link = { file: 'src/Fireball.java', line: 4, before: 'MANA_COST = ', after: ';' }
    expect(locate(FIREBALL, link)).toMatchObject({ line: 4, raw: '20', value: 20 })
    const moved = `// a new header\n// and another\n${FIREBALL}`
    expect(locate(moved, link)?.line).toBe(6)
    expect(locate(FIREBALL.replace('MANA_COST', 'MANA'), link)).toBeNull()
    // nothing after it: the value runs to the end of the line, the comment aside
    expect(locate('mana: 12 # per cast\n', { file: 'a.yml', line: 1, before: 'mana: ', after: '' })?.value).toBe(12)
  })

  it('rewrites only the value, keeping the line and the file as they were', () => {
    const p = patch(FIREBALL.replace(/\n/g, '\r\n'), { file: 'f', line: 5, before: 'COOLDOWN = ', after: ';' }, 3)!
    expect(p.from).toBe('    public static final float COOLDOWN = 2.5f;')
    expect(p.to).toBe('    public static final float COOLDOWN = 3.0f;')
    expect(p.text).toBe(FIREBALL.replace(/\n/g, '\r\n').replace('2.5f', '3.0f'))
  })

  it('plans the edits as a diff per cell, and reads the table back from the code', () => {
    let t = spells()
    t = setCell(t, 'fireball', 'mana', 25)
    t = setCell(t, 'fireball', 'element', 'ice')
    const plan = planChanges(t, [{ rowId: 'fireball', key: 'mana' }, { rowId: 'fireball', key: 'element' }, { rowId: 'mend', key: 'mana' }], { 'src/Fireball.java': FIREBALL })
    expect(plan.changes.map((c) => [c.label, c.line, c.to.trim()])).toEqual([
      ['Fireball · Mana usage', 4, 'public static final int MANA_COST = 25;'],
      ['Fireball · Element', 6, 'private static final String ELEMENT = "ice";']
    ])
    expect(plan.missing).toEqual([{ rowId: 'mend', key: 'mana' }])
    // the code is the truth: someone changed the damage there, and the cooldown moved down a line
    const code = plan.texts['src/Fireball.java'].replace('DAMAGE = 8', 'DAMAGE = 11').replace('    public static final float', '\n    public static final float')
    const back = readFromCode(spells(), { 'src/Fireball.java': code }, new Set(['fireball.mana']))
    expect(back.table.rows[0].cells).toMatchObject({ mana: 20, damage: 11, element: 'ice' })
    expect(back.changed.sort()).toEqual(['fireball.damage', 'fireball.element'])
    expect(back.states).toMatchObject({ 'fireball.mana': 'ok', 'fireball.cooldown': 'moved' })
    expect(back.table.rows[0].links!.cooldown.line).toBe(6)
  })

  it('gives a chat the context tables in a few lines, and only those switched on', () => {
    const t = spells()
    expect(contextSection([t])).toBe('')
    const md = contextSection([{ ...t, context: true }])
    expect(md).toContain('## Project tables')
    expect(md).toContain('| Spell | Mana usage | Cooldown | Element | Base damage |')
    expect(md).toContain('| Mend (idea) | 15 | 4 | light | -6 |')
    expect(md).toContain('Cooldown: seconds; Base damage: negative heals')
    expect(md).toContain('Code: src/Fireball.java')
    const big = { ...t, rows: Array.from({ length: 500 }, (_, i) => ({ ...t.rows[0], id: `s${i}` })) }
    expect(tableMarkdown(big).length).toBeLessThan(6600)
    expect(tableMarkdown(big)).toMatch(/\(\d+ more rows in the file\)/)
  })

  it('asks for a table with the request on a line of its own, and builds an idea with its values', () => {
    const p = tableCommandPrompt('every spell, with mana and cooldown', [spells()])
    expect(p).toContain('## Request\nevery spell, with mana and cooldown')
    expect(p).toContain('`save_table`')
    expect(p).toContain('- `spells`: Spells (2 rows')
    const impl = implementPrompt(spells(), ['mend'])
    expect(impl).toContain('# Implement "Mend" from the table "Spells"')
    expect(impl).toContain('| Mend | 15 | 4 | light | -6 |')
    expect(impl).toContain('`src/Fireball.java`')
    expect(impl).toContain('`read_table` (id `spells`)')
  })
})
