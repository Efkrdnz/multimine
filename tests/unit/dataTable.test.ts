import { describe, expect, it } from 'vitest'
import { addRow, askBrief, coerce, describeDiff, diff, inferType, isDataFile, KEY_COLUMN, parseTable, removeRows, serialize, setCell, splitCsv, stats, validate, type Table } from '@shared/data/table'

const table = (path: string, text: string): Table => {
  const r = parseTable(path, text)
  if (!r.ok) throw new Error(r.reason)
  return r.table
}

const ITEMS = `[
  {
    "id": 1,
    "name": "Iron Sword",
    "damage": 6,
    "speed": 1.6,
    "rarity": "common",
    "tags": ["melee", "metal"],
    "stackable": false
  },
  {
    "id": 2,
    "name": "Mana Staff",
    "damage": 3,
    "speed": 1.1,
    "rarity": "rare",
    "tags": ["magic"],
    "stackable": false
  },
  {
    "id": 3,
    "name": "Apple",
    "damage": 0,
    "speed": 4,
    "rarity": "common",
    "tags": [],
    "stackable": true
  },
  {
    "id": 4,
    "name": "Dragon Bow",
    "damage": 9,
    "speed": 0.8,
    "rarity": "common",
    "tags": ["ranged"],
    "stackable": false
  }
]
`

describe('data tables', () => {
  it('writes an untouched file back byte for byte, in every shape', () => {
    const keyed = '{\n    "10": {\n        "hp": 5\n    },\n    "2": {\n        "hp": 7\n    }\n}'
    const wrapped = '{\r\n\t"version": 3,\r\n\t"enemies": [\r\n\t\t{\r\n\t\t\t"name": "Slime",\r\n\t\t\t"hp": 8\r\n\t\t}\r\n\t]\r\n}\r\n'
    const csv = 'id,name,note\r\n1,"Iron, Sword","said ""hi"""\r\n2,Apple,"two\r\nlines"\r\n'
    const tsv = 'id\tname\n1\tSlime\n'
    for (const [path, text] of [['items.json', ITEMS], ['mobs.json', keyed], ['enemies.json', wrapped], ['items.csv', csv], ['mobs.tsv', tsv]]) expect(serialize(table(path, text)), path).toBe(text)
    // integer-like keys keep their order (JSON.stringify would put "2" first)
    expect(table('mobs.json', keyed).rows.map((r) => r.key)).toEqual(['10', '2'])
  })

  it('reads the shapes it can and says why it cannot read the rest', () => {
    expect(table('enemies.json', '{"version":3,"enemies":[{"name":"Slime"}]}').shape).toMatchObject({ kind: 'wrapped', prop: 'enemies' })
    expect(parseTable('x.json', '{"a":1}')).toMatchObject({ ok: false, reason: 'Not a table of records' })
    expect(parseTable('x.json', '[1,2]')).toMatchObject({ ok: false })
    expect(parseTable('x.json', '{oops')).toMatchObject({ ok: false })
    expect(parseTable('x.json', '{"a":[{"x":1}],"b":[{"y":2}]}')).toMatchObject({ ok: false, reason: expect.stringContaining('several tables') })
    expect(parseTable('x.csv', 'a,a\n1,2')).toMatchObject({ ok: false })
    expect(splitCsv('a,"b\nc",d\ne', ',').map((r) => r.fields)).toEqual([['a', 'b\nc', 'd'], ['e']])
    expect(isDataFile('items.json')).toBe(true)
    expect(isDataFile('package.json')).toBe(false)
    expect(isDataFile('tsconfig.node.json')).toBe(false)
    expect(isDataFile('loot.csv')).toBe(true)
    expect(isDataFile('notes.md')).toBe(false)
  })

  it('knows each column type', () => {
    const t = table('items.json', ITEMS)
    expect(Object.fromEntries(t.columns.map((c) => [c.name, c.type]))).toEqual({ id: 'int', name: 'string', damage: 'int', speed: 'number', rarity: 'enum', tags: 'json', stackable: 'bool' })
    expect(t.columns.find((c) => c.name === 'rarity')!.values).toEqual(['common', 'rare'])
    expect(inferType(['1', '2', ''], true).type).toBe('int')
    expect(inferType(['1.5', '2'], true).type).toBe('number')
    expect(inferType(['true', 'false'], true).type).toBe('bool')
    expect(inferType([], false).type).toBe('string')
    expect(table('m.json', '{"a":{"x":1}}').columns[0].name).toBe(KEY_COLUMN)
  })

  it('edits a cell and changes only that line', () => {
    const t = table('items.json', ITEMS)
    const dmg = t.columns.find((c) => c.name === 'damage')!
    const next = setCell(t, t.rows[1].rid, 'damage', coerce(t, dmg, '4'))
    const before = ITEMS.split('\n')
    const after = serialize(next).split('\n')
    expect(after.filter((l, i) => l !== before[i])).toEqual(['    "damage": 4,'])
    expect(() => coerce(t, dmg, '4.5')).toThrow('whole numbers')
    expect(coerce(t, t.columns.find((c) => c.name === 'stackable')!, true)).toBe(true)
    expect(() => coerce(t, t.columns.find((c) => c.name === 'tags')!, '[oops')).toThrow('not valid JSON')
    // CSV stays text, and an edited row is re-quoted while the rest keep their bytes
    const c = table('items.csv', 'id,name\n1,"Iron Sword"\n2,Apple\n')
    const c2 = setCell(c, c.rows[1].rid, 'name', 'Green, Apple')
    expect(serialize(c2)).toBe('id,name\n1,"Iron Sword"\n2,"Green, Apple"\n')
  })

  it('keeps everything around the rows when rows are added, removed or renamed', () => {
    const wrapped = '{\r\n\t"version": 3,\r\n\t"enemies": [\r\n\t\t{\r\n\t\t\t"name": "Slime",\r\n\t\t\t"tags": ["goo"]\r\n\t\t}\r\n\t]\r\n}\r\n'
    const w = table('enemies.json', wrapped)
    const w2 = setCell(addRow(w, w.rows[0].rid, true).table, w.rows[0].rid, 'name', 'Big Slime')
    expect(serialize(w2)).toBe(
      '{\r\n\t"version": 3,\r\n\t"enemies": [\r\n\t\t{\r\n\t\t\t"name": "Big Slime",\r\n\t\t\t"tags": ["goo"]\r\n\t\t},\r\n\t\t{\r\n\t\t\t"name": "Slime",\r\n\t\t\t"tags": ["goo"]\r\n\t\t}\r\n\t]\r\n}\r\n'
    )
    expect(serialize(removeRows(w, new Set([w.rows[0].rid])))).toBe('{\r\n\t"version": 3,\r\n\t"enemies": []\r\n}\r\n')
    const k = table('mobs.json', '{\n  "10": { "hp": 5 },\n  "2": { "hp": 7 }\n}\n')
    expect(serialize(setCell(k, k.rows[0].rid, KEY_COLUMN, 'boss'))).toBe('{\n  "boss": { "hp": 5 },\n  "2": { "hp": 7 }\n}\n')
  })

  it('adds and removes rows, giving a copy an id of its own', () => {
    const t = table('items.json', ITEMS)
    const { table: t2, rid } = addRow(t, t.rows[0].rid, true)
    const copy = t2.rows.find((r) => r.rid === rid)!
    expect(t2.rows.indexOf(copy)).toBe(1)
    expect(copy.value).toMatchObject({ id: 5, name: 'Iron Sword' })
    expect(validate(t2)).toEqual([])
    const k = table('m.json', '{"slime":{"hp":5}}')
    expect(addRow(k, k.rows[0].rid, true).table.rows[1].key).toBe('slime_copy')
    expect(addRow(k).table.rows[1]).toMatchObject({ key: 'new', value: { hp: 0 } })
    expect(removeRows(t2, new Set([rid])).rows).toHaveLength(4)
  })

  it('flags values that do not fit and ids used twice', () => {
    let t = table('items.json', ITEMS)
    t = setCell(t, t.rows[1].rid, 'id', 1)
    t = setCell(t, t.rows[2].rid, 'damage', 'lots')
    const problems = validate(t)
    expect(problems.map((p) => p.message)).toEqual(['damage should be a whole number', 'The id 1 is used twice'])
  })

  it('summarises a change for an agent or a commit message', () => {
    const t = table('items.json', ITEMS)
    let t2 = setCell(t, t.rows[3].rid, 'damage', 7)
    t2 = removeRows(addRow(t2, undefined, false).table, new Set([t.rows[2].rid]))
    const d = diff(t, t2)
    expect(d.cells).toEqual([{ row: '4', col: 'damage', from: 9, to: 7 }])
    expect(d.removed).toEqual(['3'])
    expect(d.added).toHaveLength(1)
    expect(describeDiff(d)).toContain('- 4.damage: 9 -> 7')
    expect(stats(t, 'damage')).toEqual({ min: 0, max: 9, mean: 4.5, n: 4 })
    expect(stats(t, 'name')).toBeNull()
    const brief = askBrief(t, [t.rows[3]], 'Dragon Bow is overpowered; bring it in line with the Iron Sword.')
    expect(brief).toContain('`items.json` (4 rows; columns id:int, name:string, damage:int, speed:number, rarity:enum(common|rare)')
    expect(brief).toContain('"name":"Dragon Bow"')
    expect(brief).toContain('Edit `items.json` directly')
  })
})
