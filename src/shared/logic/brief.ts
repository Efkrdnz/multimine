import { boardFolder, type Board } from './model'
import { spec } from './spec'
import { TARGETS } from './targets'

export const BOARD_ROOT = '.multimine/boards'

export const boardDir = (b: Board): string => `${BOARD_ROOT}/${boardFolder(b)}`

interface Member {
  id: string
  name: string
  role: string
}

/** Who builds a board when it goes through Mastermind: the Implementer, by role and then by name. */
export function implementer(team: readonly Member[]): Member | undefined {
  return team.find((a) => a.role === 'implementer') ?? team.find((a) => /implement/i.test(a.name))
}

const RULES = (dir: string) => [
  'Rules:',
  '- Each box is one step, run in the order of the arrows. Build exactly what each box says, and nothing it does not: no extra effects, numbers or behaviour.',
  '- {name} means the value of that name under Values. Keep each value as one named constant (or config entry), not repeated literals.',
  '- Where a box leaves a detail open, follow the project\'s conventions, and list the assumption under that box\'s id in your report.',
  '- Notes from the designer are context, not steps.',
  `- Once it builds and works, write \`${dir}/map.json\`: for every box id (not notes), where it is implemented - {"A3": [{"file": "path/from/project/root", "line": 42, "note": "what is there"}]}. Lines are 1-based. The board shows these as links on each box.`,
  '- Report: the files changed, how you verified it, and your assumptions by box id.'
]

/** What the builder is asked to do for a first build. */
export function buildTask(board: Board, note = ''): string {
  const dir = boardDir(board)
  return [
    `Build the mechanic on the Logic Board "${board.name}". ${TARGETS[board.target].build}`,
    note.trim() ? `\nFrom the user: ${note.trim()}\n` : '',
    `The design (also in \`${dir}/spec.md\`; the boxes and links are in \`${dir}/board.json\`):`,
    '',
    '```',
    spec(board),
    '```',
    '',
    ...RULES(dir)
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n')
}

/** What the builder is asked to do when a built board has changed: the changes only. */
export function updateTask(board: Board, changes: string, note = ''): string {
  const dir = boardDir(board)
  return [
    `Update the mechanic on the Logic Board "${board.name}". It was built before; \`${dir}/map.json\` says where each box lives. ${TARGETS[board.target].build}`,
    note.trim() ? `\nFrom the user: ${note.trim()}\n` : '',
    'Change only this - everything else on the board stays as it is built:',
    '',
    '```',
    changes,
    '```',
    '',
    `The whole board, for reference: \`${dir}/spec.md\`.`,
    '',
    ...RULES(dir).map((l) => (l.startsWith('- Once it builds') ? `- Once it builds and works, update \`${dir}/map.json\` for the boxes you added, changed or moved in the code, and drop the removed ones.` : l))
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n')
}

/**
 * The message for Mastermind: the board is the user's approved design, so it routes the task to
 * the Implementer as it is instead of planning it again. The approval id is appended by the app.
 */
export function viaMastermind(task: string, board: Board, team: readonly Member[]): string {
  const who = implementer(team)
  return [
    `Logic Board "${board.name}" from the user: a ${TARGETS[board.target].label} mechanic, designed box by box.`,
    '',
    'This board is the user\'s approved design - they drew it and pressed Build. Do not plan or redesign the mechanic, and do not run the Planner or the council.',
    who
      ? `Delegate the task below to ${who.name} (\`${who.id}\`) as it is, with the approval_id at the end of this message, and pass its report back to the user.`
      : 'There is no Implementer yet: create one with `create_agent` (role `implementer`), then delegate the task below to it as it is, with the approval_id at the end of this message.',
    '',
    '---',
    '',
    task
  ].join('\n')
}
