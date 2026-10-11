import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { Runner, suggestCommand } from '../../src/main/run/runner'

let dir: string
let events: MainEvent[]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-run-'))
  events = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

it('suggests the command that starts each kind of project', async () => {
  const at = async (files: Record<string, string>) => {
    const d = await mkdtemp(join(dir, 'p-'))
    for (const [n, t] of Object.entries(files)) await writeFile(join(d, n), t)
    return [await suggestCommand(d, 'linux'), await suggestCommand(d, 'win32')]
  }
  expect(await at({ 'build.gradle': "plugins { id 'fabric-loom' }", gradlew: '' })).toEqual(['./gradlew runClient', 'gradlew.bat runClient'])
  expect(await at({ 'project.godot': '' })).toEqual(['godot --path .', 'godot --path .'])
  expect(await at({ 'package.json': '{"scripts":{"dev":"vite"}}' })).toEqual(['npm run dev', 'npm run dev'])
  expect(await at({ 'Cargo.toml': '' })).toEqual(['cargo run', 'cargo run'])
  expect(await at({ 'notes.txt': '' })).toEqual([null, null])
})

it('streams a run, finds the crash, points it at the project file and says so', async () => {
  const src = join(dir, 'src', 'main', 'java', 'com', 'mana', 'spells')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'Fireball.java'), 'package com.mana.spells;\n\npublic class Fireball {\n  void cast() {\n    target.hurt(5);\n  }\n}\n')
  await writeFile(
    join(dir, 'game.js'),
    [
      "console.log('[12:00:00] [main/INFO]: Loading 12 spells')",
      "console.error('[12:00:01] [Render thread/ERROR]: Exception ticking spell')",
      "console.error('java.lang.NullPointerException: Cannot invoke \"Entity.hurt(int)\" because \"this.target\" is null')",
      "console.error('\\tat com.mana.spells.Fireball.cast(Fireball.java:5)')",
      "console.error('\\tat net.minecraft.client.Minecraft.tick(Minecraft.java:1800)')",
      'setTimeout(() => process.exit(3), 50)'
    ].join('\n')
  )
  const runner = new Runner(dir, (e) => events.push(e))
  await runner.start('node game.js')
  await until(() => runner.state.status === 'exited')
  expect(runner.state).toMatchObject({ status: 'exited', code: 3, command: 'node game.js' })
  expect(runner.output()).toContain('[12:00:00] [main/INFO]: Loading 12 spells')
  const [p] = runner.state.problems
  expect(runner.state.problems).toHaveLength(1)
  // the process died after printing it: that error is what crashed it
  expect(p).toMatchObject({ kind: 'java', fatal: true })
  expect(p.places?.[0]).toMatchObject({ path: 'src/main/java/com/mana/spells/Fireball.java', line: 5 })
  expect(p.places?.[0].snippet).toContain('> 5 |     target.hurt(5);')
  expect(events.some((e) => e.type === 'toast' && e.text.startsWith('The game crashed: java.lang.NullPointerException'))).toBe(true)
  expect(events.filter((e) => e.type === 'run-output' && e.reset)).toHaveLength(1)
})

it('a run that fails without a trace keeps its last lines; one that succeeds has no problems', async () => {
  const runner = new Runner(dir, (e) => events.push(e))
  await runner.start('node -e "console.log(\'BUILD FAILED in 2s\'); process.exit(1)"')
  await until(() => runner.state.status === 'exited')
  expect(runner.state.problems).toMatchObject([{ kind: 'exit', title: 'Exited with code 1', trace: ['BUILD FAILED in 2s'] }])
  await runner.start('node -e "console.log(\'ok\')"')
  await until(() => runner.state.status === 'exited')
  expect(runner.state).toMatchObject({ code: 0, problems: [] })
})

it.skipIf(process.platform === 'win32')('Stop ends the run and everything it started', async () => {
  await writeFile(join(dir, 'parent.js'), "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('child ' + c.pid); setInterval(() => {}, 1000)")
  const runner = new Runner(dir, (e) => events.push(e))
  await runner.start('node parent.js')
  await until(() => runner.output().some((l) => l.startsWith('child ')))
  const pid = Number(runner.output().find((l) => l.startsWith('child '))!.split(' ')[1])
  await runner.stop()
  expect(runner.state).toMatchObject({ status: 'exited', stopped: true, problems: [] })
  await until(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 6000)
})
