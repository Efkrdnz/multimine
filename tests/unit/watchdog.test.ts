import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { describeTool, shortCommand } from '@shared/activity'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'
import { DEFAULT_WATCHDOG, exactSignature, launchSignature, verdictFor, Watchdog } from '../../src/main/chat/watchdog'

const bash = (command: string) => ['Bash', { command }] as const
const T0 = 1_000_000

describe('watchdog rules', () => {
  it('sees one launch whatever its flags and shell', () => {
    expect(launchSignature('./gradlew runClient -PquickPlay="New World" -PautoScreenshot=120')).toBe('gradlew runClient')
    expect(launchSignature('cd mod && .\\gradlew.bat runClient -PautoExit')).toBe('gradlew runClient')
    expect(launchSignature('npx vite dev --port 5173')).toBe('vite dev')
    expect(exactSignature('Bash', { command: 'ls   -la' })).toBe('Bash:ls -la')
    expect(shortCommand('cd "my mod" && ./gradlew build')).toBe('gradlew build')
    expect(describeTool('Bash', { command: './gradlew runClient' })).toEqual({ verb: 'Running', brief: 'gradlew runClient' })
    expect(describeTool('Edit', { file_path: 'C:\\mod\\src\\Ability.java' })).toEqual({ verb: 'Editing', brief: 'Ability.java' })
  })

  it('trips on the third launch with nothing changed, and forgives on continue', () => {
    const wd = new Watchdog(DEFAULT_WATCHDOG, T0)
    expect(wd.check(...bash('./gradlew runClient -PautoScreenshot=100'), T0 + 1)).toBeNull()
    expect(wd.check('Read', { file_path: 'a.java' }, T0 + 2)).toBeNull()
    expect(wd.check(...bash('./gradlew runClient -PautoScreenshot=200'), T0 + 3)).toBeNull()
    const trip = wd.check(...bash('./gradlew runClient -PautoScreenshot=300'), T0 + 4)!
    expect(trip).toMatchObject({ kind: 'launch', key: 'launch:gradlew runClient' })
    expect(trip.title).toContain('third time with no new edits')
    wd.forgive(trip)
    expect(wd.check(...bash('./gradlew runClient'), T0 + 5)).toBeNull()
  })

  it('lets a fix-and-relaunch cycle run, but not forever', () => {
    const wd = new Watchdog(DEFAULT_WATCHDOG, T0)
    const trips = []
    for (let i = 0; i < 6; i++) {
      trips.push(wd.check('Edit', { file_path: 'Ability.java', old_string: `${i}`, new_string: `${i + 1}` }, T0 + i * 10))
      trips.push(wd.check(...bash(`./gradlew runClient -PautoScreenshot=${i}`), T0 + i * 10 + 1))
    }
    // an edit before each launch: fine five times, the sixth is one too many
    expect(trips.filter(Boolean)).toHaveLength(1)
    expect(trips.at(-1)!.title).toBe('wants to launch `gradlew runClient` for the sixth time')
  })

  it('trips on an exact repeat, a cycle and the time budget, but not on polling', () => {
    const wd = new Watchdog(DEFAULT_WATCHDOG, T0)
    for (let i = 0; i < 10; i++) expect(wd.check('BashOutput', { bash_id: '1' }, T0 + i)).toBeNull()
    for (let i = 0; i < 4; i++) expect(wd.check(...bash('cat run/logs/latest.log'), T0 + i)).toBeNull()
    expect(wd.check(...bash('cat run/logs/latest.log'), T0 + 5)).toMatchObject({ kind: 'repeat' })

    const cyc = new Watchdog(DEFAULT_WATCHDOG, T0)
    const steps = [bash('ls run/saves'), ['Read', { file_path: 'x' }] as const, bash('grep error log')]
    const got = []
    for (let r = 0; r < 3; r++) for (const s of steps) got.push(cyc.check(s[0], s[1], T0))
    expect(got.slice(0, -1).every((t) => t === null)).toBe(true)
    expect(got.at(-1)).toMatchObject({ kind: 'cycle' })
    expect(got.at(-1)!.title).toContain('same 3 steps')

    const slow = new Watchdog(DEFAULT_WATCHDOG, T0, 20)
    expect(slow.check(...bash('ls'), T0 + 19 * 60_000)).toBeNull()
    const over = slow.check(...bash('ls -a'), T0 + 21 * 60_000)!
    expect(over).toMatchObject({ kind: 'budget' })
    slow.forgive(over)
    expect(slow.check(...bash('ls -b'), T0 + 30 * 60_000)).toBeNull()
    expect(slow.check(...bash('ls -c'), T0 + 37 * 60_000)).toMatchObject({ kind: 'budget' })
    expect(new Watchdog({ ...DEFAULT_WATCHDOG, enabled: false }, T0, 0).check(...bash('ls'), T0 + 1e9)).toBeNull()
  })

  it('turns the user\'s answer into what the agent is told', () => {
    expect(verdictFor({ approved: true })).toEqual({ ok: true })
    expect(verdictFor({ approved: false, note: 'create the world first' })).toMatchObject({ ok: false, reason: expect.stringContaining('create the world first') })
    expect(verdictFor({ approved: false })).toMatchObject({ ok: false, stop: true })
    expect(verdictFor({ approved: false, note: 'The session was switched.', status: 'auto' })).toMatchObject({ stop: true })
  })
})

describe('watchdog in a turn', () => {
  let dir: string
  let app: MultimineApp
  let events: MainEvent[]
  let looper: string

  // the looper launches the "game" four times; the reply comes after
  const script: MockScript = (req) => {
    if (req.agent.name === 'Looper') return [...[1, 2, 3, 4].map((n) => ({ tool: { name: 'run_command', args: { command: `echo ./gradlew runClient -PautoScreenshot=${n}` } } })), { text: 'done' }]
    // a Claude-style sub-agent: its steps arrive tagged with the call that started it
    if (req.agent.name === 'Nester')
      return [
        { event: { type: 'tool-start', id: 'task1', name: 'Task', input: { description: 'Find the ability registry' } } },
        { event: { type: 'tool-start', id: 's1', name: 'Grep', input: { pattern: 'registerAbility' }, parent: 'task1' } },
        { event: { type: 'tool-end', id: 's1', output: 'src/Abilities.java', parent: 'task1' } },
        { event: { type: 'progress', id: 'task1', note: 'Reading the registry' } },
        { event: { type: 'tool-start', id: 's2', name: 'Read', input: { file_path: 'src/Abilities.java' }, parent: 'task1' } },
        { event: { type: 'tool-end', id: 's2', output: 'class Abilities {}', parent: 'task1' } },
        { event: { type: 'tool-end', id: 'task1', output: 'It is in src/Abilities.java' } },
        { text: 'found it' }
      ]
    return [{ text: 'ok' }]
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-wd-'))
    events = []
    app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, skipDetect: true })
    await app.start()
    await app.openProject(join(dir, 'proj'))
    looper = (await app.createChat({ name: 'Looper', autoApprove: true })).id
  })

  afterEach(async () => {
    await app.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  const answer = async (fn: (id: string) => Promise<void>) => {
    for (let i = 0; i < 500; i++) {
      const item = app.engine!.inbox.pending().find((x) => x.watchdog)
      if (item) return fn(item.id)
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('the watchdog never asked')
  }

  it('pauses a relaunch loop and hands the chat the user\'s instruction', async () => {
    const turn = app.engine!.send(looper, 'test the ability')
    await answer((id) => app.decide(id, false, 'The world "New World" does not exist. Stop launching and report.'))
    await answer((id) => app.decide(id, true))
    const res = await turn
    expect(res.error).toBeUndefined()
    const tools = app.engine!.chats[looper].at(-1)!.tools!
    expect(tools.map((t) => t.status)).toEqual(['done', 'done', 'error', 'done'])
    expect(tools[2].output).toContain('does not exist. Stop launching and report.')
    expect(tools[3].output).toContain('runClient -PautoScreenshot=4')
    expect(tools.every((t) => t.startedAt && t.endedAt)).toBe(true)
    const items = app.engine!.inbox.items.filter((x) => x.watchdog)
    expect(items).toHaveLength(2)
    // the live activity line: what it is doing, on what, since when; and waiting while paused
    const st = events.filter((e): e is Extract<MainEvent, { type: 'status' }> => e.type === 'status' && e.agentId === looper)
    expect(st.some((e) => e.activity === 'Running' && e.detail === 'echo ./gradlew runClient -PautoScreenshot=1' && typeof e.since === 'number')).toBe(true)
    expect(st.some((e) => e.status === 'waiting' && e.activity === 'Paused by the loop guard')).toBe(true)
    expect(st.at(-1)).toMatchObject({ status: 'idle', activity: undefined })
    expect(items[0].title).toContain('third time with no new edits')
  })

  it('nests a sub-agent\'s steps under the call that started it, with timings', async () => {
    const nester = (await app.createChat({ name: 'Nester' })).id
    await app.engine!.send(nester, 'find it')
    const tools = app.engine!.chats[nester].at(-1)!.tools!
    expect(tools.map((t) => t.name)).toEqual(['Task'])
    expect(tools[0]).toMatchObject({ status: 'done', childCount: 2, progress: 'Reading the registry' })
    expect(tools[0].children!.map((c) => [c.name, c.status])).toEqual([
      ['Grep', 'done'],
      ['Read', 'done']
    ])
    expect(tools[0].children!.every((c) => c.startedAt && c.endedAt)).toBe(true)
  })

  it('stops the turn when the user says stop, and says why', async () => {
    const turn = app.engine!.send(looper, 'test the ability')
    await answer((id) => app.decide(id, false))
    const res = await turn
    // the stand-in launch is `echo ./gradlew runClient ...` (harmless on every OS)
    expect(res.error).toBe('Stopped by the user: Looper wants to launch `echo ./gradlew` for the third time with no new edits.')
    expect(app.engine!.chats[looper].at(-1)!.tools!.length).toBe(3)
  })
})
