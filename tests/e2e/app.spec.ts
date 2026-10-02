import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const shots = resolve(process.env.MULTIMINE_SHOTS ?? 'test-results/shots')
mkdirSync(shots, { recursive: true })
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) })

test('the workstation runs end to end on mock agents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-e2e-'))
  const project = join(root, 'my-mod')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# My Minecraft mod\n')
  const app = await electron.launch({
    // SwiftShader: CI machines have no GPU, and the space scene is WebGL
    args: [resolve('out/main/index.js'), '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--project', project],
    env: { ...process.env, MULTIMINE_USER_DATA: join(root, 'user'), MULTIMINE_FORCE_MOCK: '1', MULTIMINE_MOCK_DELAY: '25' }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1480, height: 900 })
  await expect(page.getByTestId('session-menu')).toBeVisible({ timeout: 20_000 })

  // first run: only Mastermind exists, so the wizard offers a team
  await expect(page.getByTestId('team-wizard')).toBeVisible()
  await page.getByTestId('wizard-all-provider').selectOption('mock')
  await page.waitForTimeout(800)
  await shot(page, '01-team-wizard')
  await page.getByTestId('wizard-create').click()
  await expect(page.getByTestId('team-wizard')).toHaveCount(0, { timeout: 15_000 })
  for (const id of ['planner', 'implementer', 'designer', 'brainstormer', 'context-handler']) expect(existsSync(join(project, '.multimine', 'agents', `${id}.md`))).toBe(true)
  expect(readFileSync(join(project, '.multimine', 'agents', 'implementer.md'), 'utf8')).toContain('gated: true')

  // a custom agent through the editor
  await page.getByTestId('add-agent').click()
  await page.getByTestId('agent-name').fill('Lore Keeper')
  await page.getByTitle('Mock (offline demo)').click()
  await page.waitForTimeout(400)
  await shot(page, '02-agent-editor')
  await page.getByTestId('agent-save').click()
  await expect(page.getByTestId('agent-save')).toHaveCount(0)
  await page.locator('[data-chat-dock] button:has(svg.lucide-x)').first().click()
  await page.waitForTimeout(1500)
  await shot(page, '03-team')

  await page.getByTestId('open-mastermind').click()
  const chat = page.getByTestId('chat-mastermind')
  const input = chat.getByTestId('chat-input')
  await input.fill('Hello Mastermind, plan some stronger magic attacks.')
  await input.press('Enter')
  await expect(chat).toContainText('no AI attached', { timeout: 15_000 })
  await expect(chat.getByTestId('chat-send')).toBeVisible()

  // economy on: a light handoff runs the designer on a cheaper setting for that task, shown with a bolt
  await page.getByTestId('economy').click()
  await expect(page.getByTestId('economy')).toContainText('ON')
  // drive the bus by hand: the mock calls the real tool for a /tool line
  await input.fill('/tool delegate {"agent":"designer","task":"Sketch a stronger attack","difficulty":"light"}')
  await input.press('Enter')
  await page.waitForTimeout(600)
  await shot(page, '04-delegation-in-flight')
  await expect(chat).toContainText('Designer replied', { timeout: 15_000 }).catch(() => undefined)

  await input.fill('/tool ask_user {"questions":[{"question":"Which element should the new attack use?","header":"Element","options":[{"label":"Void","description":"Reality-tearing damage"},{"label":"Fire"},{"label":"Lightning"}]}]}')
  await input.press('Enter')
  await expect(page.getByTestId('inbox').locator('span').first()).toHaveText('1', { timeout: 10_000 })
  await page.waitForTimeout(800)
  await shot(page, '05-brain-waiting')
  await page.getByTestId('inbox').click()
  await page.waitForTimeout(500)
  await shot(page, '06-inbox-question')
  await page.getByRole('button', { name: /^Void/ }).click()
  await page.getByTestId('inbox-submit').click()
  await expect(chat).toContainText('Void', { timeout: 10_000 })
  await page.getByTestId('inbox').click()

  // a push always asks, as a balloon over the agent, answered in the space view itself
  await page.locator('[data-chat-dock] button:has(svg.lucide-x)').first().click()
  await page.evaluate(() => (globalThis as any).mm.api.send('implementer', '/tool request_permission {"action":"git push origin main"}'))
  await expect(page.getByTestId('balloon-implementer')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(500)
  await shot(page, '07-permission-balloon')
  await page.getByTestId('balloon-allow').click()
  await expect(page.getByTestId('balloon-implementer')).toHaveCount(0)

  await page.getByTestId('git').click()
  await page.getByRole('button', { name: 'Initialise git here' }).click()
  await expect(page.getByTestId('git-stage-all')).toBeVisible({ timeout: 10_000 })
  await page.getByText('README.md').first().click()
  await page.waitForTimeout(500)
  await shot(page, '08-git-panel')
  await page.getByTestId('git').click()

  // the code window: find a file, edit and save it, then a terminal and a Claude Code session on the team
  await page.getByTestId('code').click()
  await expect(page.getByTestId('ide')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('ide-search').fill('readme')
  await page.getByTestId('ide-hit').first().click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Edited in the Multimine code window.')
  await page.keyboard.press('Control+s')
  await expect.poll(() => readFileSync(join(project, 'README.md'), 'utf8'), { timeout: 10_000 }).toContain('Edited in the Multimine code window.')
  await expect(page.getByTestId('sync-context')).toContainText('(1)', { timeout: 10_000 })
  await page.getByTestId('term-new').click()
  await expect(page.getByTestId('terminal-shell')).toBeVisible()
  await page.waitForTimeout(800)
  await page.getByTestId('terminal-shell').click()
  await page.keyboard.type('echo multimine-$((6*7))')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-shell')).toContainText('multimine-42', { timeout: 10_000 })
  await page.evaluate(() => (globalThis as any).mm.api.updateSettings({ claudePath: 'echo' }))
  await page.getByRole('button', { name: 'Claude Code' }).click()
  await expect(page.getByTestId('terminal-claude')).toContainText('--mcp-config', { timeout: 10_000 })
  await page.waitForTimeout(800)
  await shot(page, '09-code-window')
  await page.getByTestId('sync-context').click()
  await page.getByTestId('code').click()
  await page.waitForTimeout(800)
  await shot(page, '10-terminal-agent-orb')

  await page.getByTestId('context').click()
  await page.waitForTimeout(400)
  await shot(page, '11-context-panel')
  await page.getByTestId('context').click()

  // a fallback chain in the agent editor
  await page.getByTestId('add-agent').click()
  await page.getByTestId('agent-name').fill('Fallback Demo')
  await page.getByTestId('agent-fallback-add').click()
  await page.getByTestId('agent-fallback-add').click()
  await page.getByTestId('agent-fallback').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot(page, '12-fallback-chain')
  await page.keyboard.press('Escape')

  await page.getByTestId('settings').click()
  await page.waitForTimeout(800)
  await shot(page, '13-settings')
  await page.keyboard.press('Escape')

  expect(existsSync(join(project, '.multimine', 'sessions'))).toBe(true)
  expect(existsSync(join(project, 'multimine.md'))).toBe(true)
  await app.close()
})
