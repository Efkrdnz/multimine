import { slug, summary, type Sketch } from './model'
import { TARGETS } from './targets'

export const SKETCH_ROOT = '.multimine/sketches'

export const sketchDir = (name: string): string => `${SKETCH_ROOT}/${slug(name)}`

/**
 * The message a chat receives for a sketch: the paths, a compact outline so the request can be
 * judged without opening the files, how to build for its engine, and the three steps - build it
 * exactly, look at the real thing, say what was done. Any chat can do it from this alone.
 */
export function sketchBrief(sk: Sketch, note: string): string {
  const t = TARGETS[sk.target]
  const dir = sketchDir(sk.name)
  return [
    `# Build the UI sketch "${sk.name}"`,
    `${t.label}, designed at ${sk.canvas.w}x${sk.canvas.h} ${t.units}, to hold at ${t.screens.map((s) => `${s.w}x${s.h}`).join(', ')}.`,
    note.trim() ? `\nFrom the user: ${note.trim()}\n` : '',
    'Files:',
    `- ${dir}/sketch.json - the source of truth: tree[] with exact positions (relative to each parent), sizes, anchors and stretch, text, states and notes`,
    `- ${dir}/sketch.png - the wireframe`,
    `- ${dir}/mockup.png - a styled preview of the intent (a stand-in look, not the project's art)`,
    '',
    'Outline:',
    summary(sk),
    '',
    'How to build it:',
    "- Before writing anything, read how the project already builds screens of this kind and match it: the same base classes, layout helpers, assets, localisation and naming.",
    "- Every element has an `anchor` (the point of its parent it keeps its distance to) and may `stretch` on x or y. Map them to the engine's own anchors so the layout holds on every screen listed above.",
    '- Implement the whole sketch, including the notes and the listed states (hover, pressed, disabled).',
    'In this order (if multimine.md says how this project builds or captures UI, that wins over these defaults):',
    `1. Build it for ${t.engine}:`,
    ...t.build.map((l) => `   - ${l}`),
    '2. Look at the real thing, once per change, and `show_media` the screenshot so it lands in the gallery next to the sketch:',
    ...t.capture.map((l) => `   - ${l}`),
    "   If you cannot take a screenshot (a missing world or save, no binary, no display), do not retry: say exactly why and what the user should run.",
    '3. Finish with the files you changed, the capture command, the screenshot path, and anything you could not do as drawn and why.'
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** A revision: a marked-up screenshot and what to change, sent to the chat that built the UI (or any other). */
export function revisionBrief(sk: Sketch, imagePath: string, notes: string): string {
  const dir = sketchDir(sk.name)
  return [
    `# Revise the UI sketch "${sk.name}"`,
    `The sketch: ${dir}/sketch.json.`,
    `Marked-up screenshot: ${imagePath} - the red marks point at what to change.`,
    notes.trim() ? `\nWhat to change:\n${notes.trim()}\n` : '',
    'Change only what is marked, take a new screenshot the same way, `show_media` it and report.'
  ]
    .filter((l) => l !== '')
    .join('\n')
}
