import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { bundledClaude } from '../../src/main/providers/claudeCli'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

it('points Claude chats at the binary unpacked next to app.asar in an installed app', () => {
  const resources = mkdtempSync(join(tmpdir(), 'mm-res-'))
  dirs.push(resources)
  expect(bundledClaude(resources)).toBeUndefined() // nothing unpacked: let the SDK look itself
  const kind = process.platform === 'linux' ? `linux-${process.arch}` : `${process.platform}-${process.arch}`
  const dir = join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${kind}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
  writeFileSync(file, '')
  expect(bundledClaude(resources)).toBe(file)
  expect(bundledClaude(undefined)).toBeUndefined() // running from source
})

it('the Windows installer adds Start Menu and desktop shortcuts and ships the native parts unpacked', () => {
  const build = JSON.parse(readFileSync('package.json', 'utf8')).build
  expect(build.nsis).toMatchObject({ oneClick: false, createDesktopShortcut: 'always', createStartMenuShortcut: true, shortcutName: 'Multimine' })
  expect(build.win.target.map((t: { target: string }) => t.target)).toEqual(['nsis', 'portable'])
  expect(build.asarUnpack).toEqual(expect.arrayContaining(['node_modules/@anthropic-ai/**', 'node_modules/node-pty/**']))
  expect(build.win.icon).toBe('build/icon.ico')
})
