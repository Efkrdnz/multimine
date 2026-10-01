import { join } from 'node:path'

/** Every path Multimine writes inside a project. */
export function projectPaths(dir: string) {
  const root = join(dir, '.multimine')
  return {
    dir,
    root,
    multimineMd: join(dir, 'multimine.md'),
    agents: join(root, 'agents'),
    agent: (id: string) => join(root, 'agents', `${id}.md`),
    context: join(root, 'context'),
    media: join(root, 'media'),
    sessions: join(root, 'sessions'),
    session: (id: string) => join(root, 'sessions', id),
    layout: join(root, 'layout.json')
  }
}
export type ProjectPaths = ReturnType<typeof projectPaths>
