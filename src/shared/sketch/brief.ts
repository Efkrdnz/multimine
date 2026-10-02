import { slug, summary, type Sketch } from './model'
import { PRESETS } from './presets'

export const SKETCH_ROOT = '.multimine/sketches'

export const sketchDir = (name: string): string => `${SKETCH_ROOT}/${slug(name)}`

interface Member {
  id: string
  name: string
  role: string
}

/** The agent a sketch goes to: an existing UI Creator, by role first and then by name. */
export function uiCreator(team: readonly Member[]): Member | undefined {
  return team.find((a) => a.role === 'ui-creator') ?? team.find((a) => /ui[\s-]*creator/i.test(a.name))
}

/**
 * The message Mastermind receives for a sketch. It carries the paths, a compact outline so the
 * request can be judged without opening the files, and the UI Creator's three steps: build it
 * exactly, capture the real thing, show it.
 */
export function sketchBrief(sk: Sketch, team: readonly Member[], note: string): string {
  const p = PRESETS[sk.preset]
  const dir = sketchDir(sk.name)
  const creator = uiCreator(team)
  return [
    `UI sketch "${sk.name}" from the UI Sketcher - ${p.label}, ${sk.canvas.w}x${sk.canvas.h} ${p.units}.`,
    note.trim() ? `\nFrom the user: ${note.trim()}\n` : '',
    'Files:',
    `- ${dir}/sketch.json - the source of truth: tree[] with exact positions (relative to each parent) and sizes, text, anchors, states and notes`,
    `- ${dir}/sketch.png - the wireframe`,
    `- ${dir}/mockup.png - a styled preview of the intent (procedural, not the real look)`,
    '',
    'Outline:',
    summary(sk),
    '',
    creator
      ? `Please delegate this to ${creator.name} (\`${creator.id}\`).`
      : 'There is no UI Creator yet: create one with `create_agent` (role `ui-creator`), then delegate this to it.',
    'Its task, in this order:',
    `1. Implement the GUI from ${dir}/sketch.json exactly, following how the project already builds screens of this kind${p.style === 'minecraft' ? ' (units are GUI pixels; a slot is 18)' : ''}.`,
    '2. Run the project\'s own way of seeing it (multimine.md and the context map say how; for a Minecraft mod, a dev-client launch with an automatic screenshot) and `show_media` the real screenshot.',
    '3. Report the files changed, the capture command and the screenshot path, and anything it could not do as drawn.'
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** A revision: a marked-up screenshot and what to change, sent straight to whoever builds the UI. */
export function revisionBrief(sk: Sketch, imagePath: string, notes: string): string {
  const dir = sketchDir(sk.name)
  return [
    `Revision for the UI sketch "${sk.name}" (${dir}/sketch.json).`,
    `Marked-up screenshot: ${imagePath} - the red marks point at what to change.`,
    notes.trim() ? `\nWhat to change:\n${notes.trim()}\n` : '',
    'Change only what is marked, take a new screenshot the same way, `show_media` it and report.'
  ]
    .filter((l) => l !== '')
    .join('\n')
}
