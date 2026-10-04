import { join } from 'node:path'

/** Every path Multimine writes inside a project. */
export function projectPaths(dir: string) {
  const root = join(dir, '.multimine')
  return {
    dir,
    root,
    multimineMd: join(dir, 'multimine.md'),
    chats: join(root, 'chats'),
    chat: (id: string) => join(root, 'chats', id),
    media: join(root, 'media'),
    mediaIndex: join(root, 'media', 'index.json')
  }
}
export type ProjectPaths = ReturnType<typeof projectPaths>
