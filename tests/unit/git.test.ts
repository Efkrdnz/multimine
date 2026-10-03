import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Git, githubRepo, parseStatus } from '../../src/main/git/git'

it('parses the porcelain branch line and file letters', () => {
  const s = parseStatus('## main...origin/main [ahead 2, behind 1]\nM  src/a.ts\n M src/b.ts\n?? new.txt\nR  old.ts -> new.ts\n')
  expect(s.branch).toBe('main')
  expect(s.upstream).toBe('origin/main')
  expect([s.ahead, s.behind]).toEqual([2, 1])
  expect(s.files.map((f) => [f.path, f.staged, f.untracked])).toEqual([
    ['src/a.ts', true, false],
    ['src/b.ts', false, false],
    ['new.txt', false, true],
    ['new.ts', true, false]
  ])
  expect(s.files[3].from).toBe('old.ts')
  expect(parseStatus('## No commits yet on feature/x\n').branch).toBe('feature/x')
})

it('reads owner/repo from https and ssh GitHub remotes only', () => {
  expect(githubRepo('https://github.com/Efkrdnz/multimine.git')).toBe('Efkrdnz/multimine')
  expect(githubRepo('git@github.com:Efkrdnz/magical-mod.git')).toBe('Efkrdnz/magical-mod')
  expect(githubRepo('https://gitlab.com/a/b.git')).toBeNull()
})

it('stages, commits, branches and logs a real repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-git-'))
  const git = new Git(dir)
  expect((await git.status()).isRepo).toBe(false)
  await git.init()
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'hello\n')
  let st = await git.status()
  expect(st.files[0]).toMatchObject({ path: 'a.txt', untracked: true })
  expect(await git.diff('a.txt', false, true)).toContain('+hello')
  await git.stage(['a.txt'])
  await git.unstage(['a.txt'])
  expect((await git.status()).files[0].staged).toBe(false)
  await git.stage(['a.txt'])
  await git.commit('first')
  await git.checkout('feature', true)
  expect((await git.branches()).current).toBe('feature')
  st = await git.status()
  expect(st.files).toHaveLength(0)
  expect((await git.log())[0].subject).toBe('first')
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
