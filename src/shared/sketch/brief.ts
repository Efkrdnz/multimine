import { slug, summary, type Sketch } from './model'
import { TARGETS } from './targets'

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
  const t = TARGETS[sk.target]
  const dir = sketchDir(sk.name)
  const creator = uiCreator(team)
  return [
    `UI sketch "${sk.name}" from the UI Sketcher - ${t.label}, designed at ${sk.canvas.w}x${sk.canvas.h} ${t.units}, to hold at ${t.screens.map((s) => `${s.w}x${s.h}`).join(', ')}.`,
    note.trim() ? `\nFrom the user: ${note.trim()}\n` : '',
    'Files:',
    `- ${dir}/sketch.json - the source of truth: tree[] with exact positions (relative to each parent), sizes, anchors and stretch, text, states and notes`,
    `- ${dir}/sketch.png - the wireframe`,
    `- ${dir}/mockup.png - a styled preview of the intent (a stand-in look, not the project's art)`,
    '',
    'Outline:',
    summary(sk),
    '',
    creator
      ? `Please delegate this to ${creator.name} (\`${creator.id}\`).`
      : 'There is no UI Creator yet: create one with `create_agent` (role `ui-creator`), then delegate this to it.',
    `Its task, in this order (if multimine.md or the context map say how this project builds or captures UI, that wins over these defaults):`,
    `1. Build it for ${t.engine}:`,
    ...t.build.map((l) => `   - ${l}`),
    '2. Look at the real thing:',
    ...t.capture.map((l) => `   - ${l}`),
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
