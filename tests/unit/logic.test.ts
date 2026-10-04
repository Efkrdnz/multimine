import { describe, expect, it } from 'vitest'
import { addNode, connect, copyFragment, duplicate, newBoard, parseBoard, parseCodeMap, pasteFragment, removeNodes, setCases, updateNode, validate, valuesIn, type Board } from '@shared/logic/model'
import { spec } from '@shared/logic/spec'
import { boardDiff, changeCount, changeSpec, changedIds } from '@shared/logic/diff'
import { buildTask, updateTask } from '@shared/logic/brief'

/** Adds boxes and links in one go; fails the test on a refused link. */
function build(name: string, boxes: [kind: Parameters<typeof addNode>[1], title: string, text: string, y?: number][], links: [number, string, number][]): Board {
  let b = newBoard(name, 'minecraft')
  boxes.forEach(([kind, title, text, y], i) => (b = addNode(b, kind, i * 260, y ?? i * 10, title, text).board))
  for (const [from, port, to] of links) {
    const r = connect(b, b.nodes[from].id, port, b.nodes[to].id)
    if (!r.board) throw new Error(r.error)
    b = r.board
  }
  return b
}

const sneakShot = () =>
  build(
    'Sneak Shot',
    [
      ['event', 'On cast', 'the player presses the skill key'],
      ['condition', 'If sneaking', 'the caster is sneaking'],
      ['action', 'Spawn projectile', 'spawn a projectile and shoot it where they look, deals {damage}', 0],
      ['action', 'Explode', 'explode on the spot: radius 3, {damage} damage', 100],
      ['value', 'damage', '6 + 2 per tier']
    ],
    [
      [0, 'then', 1],
      [1, 'true', 2],
      [1, 'false', 3]
    ]
  )

describe('logic board model', () => {
  it('gives each box a short stable id and refuses links that mean nothing', () => {
    const b = sneakShot()
    expect(b.nodes.map((n) => n.id)).toEqual(['E1', 'C2', 'A3', 'A4', 'V5'])
    expect(connect(b, 'A3', 'then', 'E1').error).toMatch(/nothing leads into it/)
    expect(connect(b, 'A3', 'then', 'V5').error).toMatch(/refer to a value as \{name\}/)
    expect(connect(b, 'A3', 'then', 'A3').error).toMatch(/itself/)
    expect(connect(b, 'C2', 'then', 'A3').error).toMatch(/no "then" output/)
    expect(connect(b, 'C2', 'true', 'A3').error).toMatch(/already linked/)
    // a deleted box's id never comes back
    const r = addNode(removeNodes(b, ['A4']), 'action', 0, 0)
    expect(r.id).toBe('A6')
    expect(r.board.links.some((l) => l.to === 'A4')).toBe(false)
  })

  it('renames a condition\'s branches and drops the links of a branch that is gone', () => {
    const b = setCases(sneakShot(), 'C2', ['sneaking', 'sprinting', 'otherwise'])
    expect(b.nodes[1].cases).toEqual(['sneaking', 'sprinting', 'otherwise'])
    expect(b.links.filter((l) => l.from === 'C2')).toEqual([])
    expect(setCases(b, 'C2', ['true', 'false']).nodes[1].cases).toBeUndefined()
  })

  it('copies and pastes boxes with the links among them under new ids', () => {
    const b = sneakShot()
    const d = duplicate(b, ['C2', 'A3'])
    expect(d.ids).toEqual(['C6', 'A7'])
    expect(d.board.links).toContainEqual({ from: 'C6', port: 'true', to: 'A7' })
    expect(d.board.links.some((l) => l.from === 'C6' && l.to === 'A4')).toBe(false)
    const p = pasteFragment(newBoard('x'), copyFragment(b, ['V5']), 0, 0)
    expect(p.board.nodes[0]).toMatchObject({ id: 'V1', title: 'damage' })
  })

  it('finds {values} however they are written', () => {
    expect(valuesIn('deal {damage} then {Damage} and { fire radius }')).toEqual(['damage', 'fire_radius'])
  })

  it('names everything that would leave the agent guessing', () => {
    expect(validate(sneakShot())).toEqual([])
    let b = newBoard('x')
    expect(validate(b)).toEqual([{ level: 'error', text: 'Add an Event box: nothing starts this mechanic.' }])
    b = sneakShot()
    b = addNode(b, 'action', 0, 0, '', '').board // A6: empty and loose
    b = addNode(b, 'value', 0, 0, 'Damage', '3').board // V7: same name
    b = addNode(b, 'value', 0, 0, 'range', '').board // V8: unused and undefined
    b = updateNode(b, 'A3', { text: 'shoot it, {speed} blocks a tick' })
    const issues = validate(b).map((i) => `${i.nodeId}: ${i.text}`)
    expect(issues).toEqual([
      'V7: Another value is already called {damage}.',
      'A3: {speed} is not a value on this board.',
      'A6: Say what this box does.',
      'A6: Nothing leads here: link it from an event or another box.',
      'V8: Say what this value is.',
      'V8: No box uses {range}.'
    ])
  })

  it('refuses a loop that never waits, and accepts one that does', () => {
    let b = build('loop', [['event', 'Tick', ''], ['action', 'Hit', 'x'], ['action', 'Again', 'y']], [[0, 'then', 1], [1, 'then', 2], [2, 'then', 1]])
    expect(validate(b).map((i) => `${i.nodeId}: ${i.text}`)).toEqual(['A2: This loops forever in one moment: put a Wait or a Repeat in the loop.'])
    b = build('loop', [['event', 'Tick', ''], ['action', 'Hit', 'x'], ['wait', 'Wait', '10 ticks']], [[0, 'then', 1], [1, 'then', 2], [2, 'then', 1]])
    expect(validate(b)).toEqual([])
  })

  it('reads a board back, repairing what cannot be trusted', () => {
    const b = sneakShot()
    expect(parseBoard(JSON.stringify(b))).toEqual(b)
    const bad = { ...b, target: 'nope', nextId: 1, nodes: [...b.nodes, { id: 'X9', kind: 'spell' }], links: [...b.links, { from: 'A3', port: 'then', to: 'E1' }, { from: 'C2', port: 'maybe', to: 'A3' }] }
    const r = parseBoard(JSON.stringify(bad))!
    expect(r.target).toBe('generic')
    expect(r.nodes).toHaveLength(5)
    expect(r.links).toEqual(b.links)
    expect(r.nextId).toBe(6)
    expect(parseBoard('{')).toBeNull()
  })

  it('reads the code map an agent writes, in either spelling', () => {
    expect(parseCodeMap('{"A3":[{"file":"src/Shot.java","line":42,"note":"shoot"}],"A4":"src/Shot.java:60","E1":[{"nofile":1}]}')).toEqual({
      A3: [{ file: 'src/Shot.java', line: 42, note: 'shoot' }],
      A4: [{ file: 'src/Shot.java', line: 60 }]
    })
    expect(parseCodeMap('nonsense')).toEqual({})
  })
})

describe('the outline the agent reads', () => {
  it('says the sneak shot exactly', () => {
    expect(spec(sneakShot())).toBe(
      [
        'Board "Sneak Shot" - Minecraft mod, time in ticks',
        '',
        'Values (boxes refer to them as {name})',
        '  [V5] damage = 6 + 2 per tier',
        '',
        '[E1] WHEN On cast: the player presses the skill key',
        '  [C2] IF sneaking: the caster is sneaking',
        '    true:',
        '      [A3] DO Spawn projectile: spawn a projectile and shoot it where they look, deals {damage}',
        '    false:',
        '      [A4] DO explode on the spot: radius 3, {damage} damage'
      ].join('\n')
    )
  })

  it('follows a sequence at one depth, writes a shared step once, and names a loop', () => {
    const b = build(
      'Pulse',
      [
        ['event', 'On cast', ''],
        ['condition', '', 'mana is full', 10],
        ['action', '', 'big blast', 20],
        ['action', '', 'small blast', 30],
        ['action', '', 'play a sound', 40],
        ['wait', '', '20 ticks', 50],
        ['action', '', 'pulse', 60],
        ['note', '', 'should feel heavy', 70]
      ],
      [
        [0, 'then', 1],
        [1, 'true', 2],
        [1, 'false', 3],
        [2, 'then', 4],
        [3, 'then', 4],
        [4, 'then', 5],
        [5, 'then', 6],
        [6, 'then', 5]
      ]
    )
    expect(spec(b).split('\n').slice(2)).toEqual([
      '[E1] WHEN On cast',
      '  [C2] IF mana is full',
      '    true:',
      '      [A3] DO big blast',
      '      [A5] DO play a sound',
      '      [W6] WAIT 20 ticks',
      '      [A7] DO pulse',
      '      -> back to [W6]',
      '    false:',
      '      [A4] DO small blast',
      '      -> continue at [A5]',
      '',
      'Notes from the designer',
      '  [N8] should feel heavy'
    ])
  })

  it('lists steps that fan out in order, and boxes no event reaches', () => {
    const b = build(
      'Fan',
      [
        ['event', 'On hit', ''],
        ['action', '', 'second', 50],
        ['action', '', 'first', 10],
        ['repeat', '', 'every 5 ticks, 3 times', 60],
        ['action', '', 'stray', 70]
      ],
      [
        [0, 'then', 1],
        [0, 'then', 2]
      ]
    )
    expect(spec(b).split('\n').slice(2)).toEqual([
      '[E1] WHEN On hit',
      '  then each of these, in this order:',
      '    [A3] DO first',
      '    [A2] DO second',
      '',
      'Not linked to any event (not to be built yet)',
      '  [R4] REPEAT every 5 ticks, 3 times',
      '  [A5] DO stray'
    ])
  })
})

describe('changes since a build', () => {
  it('counts and says only what changed; moving a box is not a change', () => {
    const built = sneakShot()
    let now = updateNode(built, 'A4', { text: 'explode on the spot: radius 5, {damage} damage', x: 999 })
    now = updateNode(now, 'E1', { x: 50 })
    const r = addNode(now, 'action', 0, 300, 'Play sound', 'a deep boom')
    now = connect(r.board, 'A4', 'then', r.id).board!
    now = removeNodes(now, ['A3'])
    const d = boardDiff(built, now)
    // the removed link went with A3 and the new one came with A6
    expect(changeCount(d)).toBe(3)
    // C2 is marked too: its true branch lost where it led
    expect([...changedIds(d)].sort()).toEqual(['A4', 'A6', 'C2'])
    expect(changeSpec(d, built, now)).toBe(
      [
        'Added:',
        '  [A6] DO Play sound: a deep boom   (after [A4])',
        'Changed:',
        '  [A4] DO explode on the spot: radius 5, {damage} damage',
        '      was: explode on the spot: radius 3, {damage} damage',
        'Removed (take this behaviour out):',
        '  [A3] DO Spawn projectile: spawn a projectile and shoot it where they look, deals {damage}',
        'Now linked: [A4] -> [A6]',
        'No longer linked: [C2] true -> [A3]'
      ].join('\n')
    )
    expect(changeCount(boardDiff(built, moveAll(built)))).toBe(0)
  })
})

const moveAll = (b: Board): Board => ({ ...b, nodes: b.nodes.map((n) => ({ ...n, x: n.x + 40, y: n.y + 40 })) })

describe('the messages a build sends', () => {
  it('asks for the board exactly, the assumptions by id, and the code map', () => {
    const task = buildTask(sneakShot(), 'make it purple')
    expect(task).toContain('Build the mechanic on the Logic Board "Sneak Shot". A Minecraft mod')
    expect(task).toContain('From the user: make it purple')
    expect(task).toContain('[C2] IF sneaking: the caster is sneaking')
    expect(task).toContain('write `.multimine/boards/sneak-shot/map.json`')
    expect(task).toContain('list the assumption under that box\'s id')
    expect(task).not.toMatch(/\n\n\n/)
  })

  it('tells the chat the design is approved, so it builds instead of planning', () => {
    const task = buildTask(sneakShot())
    expect(task).toContain("The board is the user's approved design")
    expect(task).toContain('Do not plan or redesign the mechanic')
    expect(task).not.toMatch(/Mastermind|delegate|approval_id|Implementer/)
  })

  it('sends only the changes for an update', () => {
    const task = updateTask(sneakShot(), 'Changed:\n  [A4] DO bigger', '')
    expect(task).toContain('Change only this')
    expect(task).toContain('[A4] DO bigger')
    expect(task).toContain('update `.multimine/boards/sneak-shot/map.json` for the boxes you added, changed or moved')
  })
})
