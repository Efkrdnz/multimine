import { join } from 'node:path'
import { newId } from '@shared/ids'
import { bookJson, EMPTY_BOOK, parseBook, sameIdea, type Idea, type IdeaBook, IDEAS_PATH } from '@shared/ideas'
import { readJson, writeAtomic } from './fsx'

/**
 * The project's Idea Book on disk. The Idea Book tool writes the same file through the plugin API;
 * every change here reads it fresh first, so neither overwrites the other.
 */
export class IdeaStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(projectDir: string) {
    this.file = join(projectDir, IDEAS_PATH)
  }

  async read(): Promise<IdeaBook> {
    return parseBook(await readJson<unknown>(this.file, EMPTY_BOOK))
  }

  /** Whether chats are told to save their side ideas here. */
  async sideIdeas(): Promise<boolean> {
    return (await this.read()).sideIdeas
  }

  private change<T>(fn: (b: IdeaBook) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const book = await this.read()
      const out = fn(book)
      await writeAtomic(this.file, bookJson(book))
      return out
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  /** A chat's ideas, filed for the user to review; ones already in the book are skipped. */
  propose(items: { title: string; details?: string; tags?: string[] }[], from: string, chatId?: string): Promise<{ saved: Idea[]; skipped: string[] }> {
    return this.change((book) => {
      const saved: Idea[] = []
      const skipped: string[] = []
      for (const it of items) {
        const title = String(it.title ?? '').trim().slice(0, 200)
        if (!title) continue
        if ([...book.ideas, ...saved].some((i) => sameIdea(i.title, title))) {
          skipped.push(title)
          continue
        }
        const details = String(it.details ?? '').trim().slice(0, 4000)
        const tags = (it.tags ?? []).map((t) => String(t).trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 6)
        saved.push({ id: newId('idea'), title, ...(details ? { details } : {}), ...(tags.length ? { tags } : {}), status: 'proposed', from, ...(chatId ? { chatId } : {}), created: Date.now() })
      }
      book.ideas.push(...saved)
      return { saved, skipped }
    })
  }
}
