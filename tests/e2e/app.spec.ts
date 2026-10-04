import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const shots = resolve(process.env.MULTIMINE_SHOTS ?? 'test-results/shots')
mkdirSync(shots, { recursive: true })
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) })

type Chat = { id: string; name: string; provider: string; model: string; autoApprove: boolean; planMode: boolean; mcp: string[] }

test('Multimine runs end to end on the mock provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-e2e-'))
  const project = join(root, 'my-mod')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# My Minecraft mod\n')
  // enough for the UI Sketcher to know a NeoForge mod when it sees one
  writeFileSync(join(project, 'build.gradle'), "plugins { id 'net.neoforged.moddev' version '2.0.0' }\n")
  writeFileSync(join(project, 'gradle.properties'), 'mod_id=manamod\n')
  mkdirSync(join(project, 'data'))
  const items = [
    { id: 1, name: 'Iron Sword', damage: 6, speed: 1.6, rarity: 'common', tags: ['melee', 'metal'], stackable: false },
    { id: 2, name: 'Mana Staff', damage: 3, speed: 1.1, rarity: 'rare', tags: ['magic'], stackable: false },
    { id: 3, name: 'Apple', damage: 0, speed: 4, rarity: 'common', tags: [], stackable: true },
    { id: 4, name: 'Dragon Bow', damage: 12, speed: 0.8, rarity: 'epic', tags: ['ranged'], stackable: false },
    { id: 5, name: 'Rune Dagger', damage: 4, speed: 2.4, rarity: 'rare', tags: ['melee', 'magic'], stackable: false }
  ]
  // the layout a formatter leaves: objects broken over lines, short arrays kept on one
  const itemsText = JSON.stringify(items, null, 2).replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s+/).join(', ')}]`) + '\n'
  writeFileSync(join(project, 'data', 'items.json'), itemsText)
  // two spells, for the Tables tool to link to
  const spellDir = join(project, 'src', 'main', 'java', 'com', 'mana', 'spells')
  mkdirSync(spellDir, { recursive: true })
  const spellFile = (cls: string, mana: number, cooldown: string, element: string, damage: number) =>
    `package com.mana.spells;\n\npublic class ${cls} extends Spell {\n    public static final int MANA_COST = ${mana};\n    public static final float COOLDOWN = ${cooldown};\n    public static final String ELEMENT = "${element}";\n    public static final int BASE_DAMAGE = ${damage};\n}\n`
  writeFileSync(join(spellDir, 'Fireball.java'), spellFile('Fireball', 20, '2.5f', 'fire', 8))
  writeFileSync(join(spellDir, 'Mend.java'), spellFile('Mend', 15, '4.0f', 'light', -6))
  mkdirSync(join(root, 'user'))
  const app = await electron.launch({
    args: [resolve('out/main/index.js'), '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--project', project],
    env: { ...process.env, MULTIMINE_USER_DATA: join(root, 'user'), MULTIMINE_FORCE_MOCK: '1', MULTIMINE_MOCK_DELAY: '25' }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1480, height: 900 })
  page.on('dialog', (d) => void d.accept())
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 20_000 })

  const chats = () => page.evaluate(async () => (await (globalThis as any).mm.api.init()).project.agents as Chat[])
  // everything said in any chat, as it is on disk
  const chatText = () => {
    const dir = join(project, '.multimine', 'chats')
    return readdirSync(dir).map((d) => (existsSync(join(dir, d, 'messages.jsonl')) ? readFileSync(join(dir, d, 'messages.jsonl'), 'utf8') : '')).join('\n')
  }
  const panel = page.locator('[data-chat-panel]')
  const input = panel.getByTestId('chat-input')
  const say = async (text: string) => {
    await input.fill(text)
    await input.press('Enter')
  }

  // a first chat is there on the defaults, and takes its name from the first message
  const [first] = await chats()
  expect(first.name).toBe('New chat')
  await say('Hello, plan some stronger magic attacks.')
  await expect(panel).toContainText('no AI attached', { timeout: 15_000 })
  await expect(page.getByTestId('chat-name')).toHaveText('Hello, plan some stronger magic attacks.', { timeout: 10_000 })
  await expect(page.getByTestId(`chat-row-${first.id}`)).toContainText('Hello, plan some stronger magic attacks.')
  await page.waitForTimeout(400)
  await shot(page, '01-chat')

  // a question is answered right in the chat
  await say('/tool ask_user {"questions":[{"question":"Which element should the new attack use?","header":"Element","options":[{"label":"Void","description":"Reality-tearing damage"},{"label":"Fire"},{"label":"Lightning"}]}]}')
  await expect(panel.getByTestId('inline-prompts')).toContainText('Which element', { timeout: 15_000 })
  await expect(page.getByTestId(`chat-row-${first.id}`)).toContainText('1')
  await page.waitForTimeout(300)
  await shot(page, '02-question')
  await panel.getByTestId('inline-prompts').getByRole('button', { name: /^Void/ }).click()
  await panel.getByTestId('inbox-submit').click()
  await expect(panel.getByTestId('inline-prompts')).toHaveCount(0, { timeout: 15_000 })
  // tool output folds into the reply's work line; the answer the model got is on disk
  await expect.poll(chatText, { timeout: 10_000 }).toContain('-> Void')

  // a Supervised chat asks before anything that leaves the machine; so does every chat for a push
  await say('/tool request_permission {"action":"git push origin main"}')
  await expect(panel.getByTestId('inline-prompts')).toContainText('git push origin main', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await shot(page, '03-permission')
  await panel.getByTestId('inbox-approve').click()
  await expect(panel.getByTestId('inline-prompts')).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(chatText, { timeout: 10_000 }).toContain('ALLOWED')

  // the composer sets the chat's access and effort, saved to the chat
  const chatFile = (id: string) => JSON.parse(readFileSync(join(project, '.multimine', 'chats', id, 'chat.json'), 'utf8')) as Chat
  await panel.getByTestId('composer-access').selectOption('full')
  await expect.poll(() => chatFile(first.id).autoApprove, { timeout: 10_000 }).toBe(true)
  await panel.getByTestId('composer-access').selectOption('supervised')
  await expect.poll(() => chatFile(first.id).autoApprove, { timeout: 10_000 }).toBe(false)

  // Quick runs one message on the light tier of the chat's provider (or at least at a lower effort)
  await page.evaluate(async () => {
    const api = (globalThis as any).mm.api
    const { settings } = await api.init()
    await api.updateSettings({ economy: { ...settings.economy, tiers: { ...settings.economy.tiers, mock: { light: 'mock-small' } } } })
  })
  await panel.getByTestId('chat-quick').click()
  await expect(input).toHaveAttribute('placeholder', /Quick: this message runs on/)
  await say('Rename the field manaCost to cost')
  await expect(panel.getByTestId('chat-quick')).not.toHaveClass(/amber/)
  await expect(panel).toContainText('Rename the field manaCost to cost')

  // the repository panel
  await page.getByTestId('git').click()
  await page.getByRole('button', { name: 'Initialise git here' }).click()
  await expect(page.getByTestId('git-stage-all')).toBeVisible({ timeout: 10_000 })
  await page.getByText('README.md').first().click()
  await page.waitForTimeout(500)
  await shot(page, '04-git')
  await page.getByTestId('git').click()

  // the code window: find a file, edit and save it, a terminal, and a Claude Code terminal
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
  await page.getByTestId('term-new').click()
  await expect(page.getByTestId('terminal-shell')).toBeVisible()
  await page.waitForTimeout(800)
  await page.getByTestId('terminal-shell').click()
  await page.keyboard.type('echo multimine-$((6*7))')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('terminal-shell')).toContainText('multimine-42', { timeout: 10_000 })
  await page.evaluate(() => (globalThis as any).mm.api.updateSettings({ claudePath: 'echo' }))
  await page.getByRole('button', { name: 'Claude Code' }).click()
  await expect(page.getByTestId('terminal-claude')).toContainText('echo', { timeout: 10_000 })
  expect(await chats()).toHaveLength(1) // a terminal is not a chat
  await page.waitForTimeout(600)
  await shot(page, '05-code-window')
  await page.getByTestId('code').click()

  await page.getByTestId('instructions').click()
  await expect(page.getByTestId('instructions-text')).toHaveValue(/multimine\.md/)
  await page.waitForTimeout(300)
  await shot(page, '06-instructions')
  await page.getByTestId('instructions').click()

  // a plugin: installed off, asks for consent, then runs walled off and talks to the chat on screen
  await page.evaluate((dir) => (globalThis as any).mm.api.pluginInstall(dir), resolve('examples/plugins/hello'))
  await page.getByTestId('manage-tools').click()
  await expect(page.getByTestId('manage-plugins')).toContainText('Hello')
  await page.waitForTimeout(300)
  await shot(page, '07-manage-tools')
  await page.keyboard.press('Escape')
  await page.getByTestId('tool-hello').click()
  await expect(page.getByTestId('consent')).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '08-consent')
  await page.getByTestId('consent-allow').click()
  const frame = page.frameLocator('[data-testid="plugin-frame-hello"]')
  await expect(frame.locator('#chats')).toContainText('Hello, plan some stronger', { timeout: 10_000 })
  // a new plugin frame runs in its own process and takes input once the compositor has placed it,
  // which under software rendering can be a couple of seconds after its page has loaded
  await expect(async () => {
    await frame.locator('#send').click()
    await expect(frame.locator('#out')).toHaveText(`Sent to chat ${first.id}.`, { timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  await expect.poll(chatText, { timeout: 10_000 }).toContain('tool:Hello')
  await page.waitForTimeout(300)
  await shot(page, '09-hello-plugin')
  // revoked, the same call is refused inside the plugin
  await page.evaluate(() => (globalThis as any).mm.api.pluginRevoke('hello', 'agents:message'))
  await frame.locator('#send').click()
  await expect(frame.locator('#out')).toContainText('agents:message')
  await page.getByTestId('toolwin-hello').getByTitle('Close').click()

  // the UI Sketcher: a Minecraft GUI drawn on the starter container, sent to a new chat, then marked up
  await page.getByTestId('tool-ui-sketcher').click()
  await expect(page.getByTestId('sketcher')).toBeVisible()
  await page.getByTestId('sk-name').fill('Mana Furnace')
  await page.getByTestId('sk-layers').getByText('Container', { exact: true }).click()
  const wb = (await page.getByTestId('sketch-selection').first().boundingBox())!
  const at = (fx: number, fy: number) => [wb.x + wb.width * fx, wb.y + wb.height * fy] as const
  await page.getByTestId('sk-tool-button').click()
  await page.mouse.move(...at(0.56, 0.12))
  await page.mouse.down()
  await page.mouse.move(...at(0.75, 0.2), { steps: 4 })
  await page.mouse.move(...at(0.92, 0.25), { steps: 4 })
  await page.mouse.up()
  await page.getByTestId('sk-prop-text').fill('Smelt')
  await page.getByTestId('sk-tool-slot').click()
  await page.mouse.click(...at(0.2, 0.2))
  await page.getByTestId('sk-tool-progress').click()
  await page.mouse.click(...at(0.36, 0.23))
  await page.getByTestId('sk-prop-notes').fill('Fills as mana is smelted.')
  await page.waitForTimeout(300)
  await shot(page, '10-sketcher')
  await page.getByTestId('sk-look-styled').click()
  await page.mouse.click(...at(0.5, 0.33))
  await page.waitForTimeout(300)
  await shot(page, '11-sketcher-minecraft')
  await page.getByTestId('sk-tab-mockup').click()
  await expect(page.getByAltText('Mockup')).toBeVisible()
  await expect(page.getByTestId('sk-size')).toHaveCount(4)
  await page.waitForTimeout(300)
  await shot(page, '12-sketch-mockup')
  await page.getByTestId('sk-tab-design').click()
  await page.getByTestId('sk-send').click()
  await expect(page.getByTestId('sk-send-to')).toHaveValue('new')
  await page.getByTestId('sk-send-note').fill('Opens from the mana furnace block.')
  await page.waitForTimeout(200)
  await shot(page, '13-sketch-send')
  await page.getByTestId('sk-send-go').click()
  const sketchDir = join(project, '.multimine', 'sketches', 'mana-furnace')
  await expect.poll(() => existsSync(join(sketchDir, 'mockup.png')), { timeout: 10_000 }).toBe(true)
  const saved = JSON.parse(readFileSync(join(sketchDir, 'sketch.json'), 'utf8'))
  expect(JSON.stringify(saved.tree)).toContain('"text":"Smelt"')
  expect(JSON.stringify(saved.tree)).toContain('Player inventory')
  await expect.poll(async () => (await chats()).map((c) => c.name), { timeout: 10_000 }).toContain('UI Sketcher: Build the UI sketch "Mana Furnace"')
  expect(chatText()).toContain('Opens from the mana furnace block.')
  const sketchChat = (await chats()).find((c) => c.name.startsWith('UI Sketcher'))!
  // the mockup went to the gallery; mark it up and send it back to the chat that built it
  await page.getByTestId('sk-tab-revisions').click()
  await page.getByTestId('sk-shot').first().click()
  await expect(page.getByTestId('sk-revision-to')).toHaveValue(sketchChat.id)
  const mk = (await page.getByTestId('sk-markup-svg').boundingBox())!
  await page.mouse.move(mk.x + mk.width * 0.55, mk.y + mk.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(mk.x + mk.width * 0.75, mk.y + mk.height * 0.35, { steps: 5 })
  await page.mouse.up()
  await page.getByTestId('sk-revision-notes').fill('Make the Smelt button narrower.')
  await page.waitForTimeout(300)
  await shot(page, '14-sketch-revision')
  await page.getByTestId('sk-revision-send').click()
  await expect.poll(() => existsSync(join(sketchDir, 'revision-1.png')), { timeout: 10_000 }).toBe(true)
  await expect.poll(chatText, { timeout: 10_000 }).toContain('Make the Smelt button narrower.')
  expect((await chats()).filter((c) => c.name.startsWith('UI Sketcher'))).toHaveLength(1)

  // a Godot HUD: game elements anchored where they are drawn, previewed on every screen
  await page.getByTestId('sk-tab-design').click()
  await page.getByTestId('sk-new').click()
  await page.getByTestId('sk-preset-godot').click()
  await page.getByTestId('sk-name').fill('Combat HUD')
  const cv = (await page.getByTestId('sketch-canvas').boundingBox())!
  const z = Math.min((cv.width - 48) / 1920, (cv.height - 48) / 1080)
  const hud = (ux: number, uy: number) => [cv.x + (cv.width - 1920 * z) / 2 + ux * z, cv.y + (cv.height - 1080 * z) / 2 + uy * z] as const
  await page.getByTestId('sk-tool-bar').click()
  await page.mouse.move(...hud(48, 992))
  await page.mouse.down()
  await page.mouse.move(...hud(240, 1010), { steps: 4 })
  await page.mouse.move(...hud(424, 1024), { steps: 4 })
  await page.mouse.up()
  await page.getByTestId('sk-prop-name').fill('Health')
  for (const [i, key] of ['Q', 'E', 'R'].entries()) {
    await page.getByTestId('sk-tool-ability').click()
    await page.mouse.click(...hud(832 + i * 96, 960))
    await page.getByTestId('sk-prop-text').fill(key)
  }
  await page.getByTestId('sk-tool-minimap').click()
  await page.mouse.click(...hud(1640, 48))
  await page.getByTestId('sk-tool-crosshair').click()
  await page.mouse.click(...hud(936, 516))
  await page.getByTestId('sk-look-styled').click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await shot(page, '15-godot-hud')
  await page.getByTestId('sk-tab-mockup').click()
  await expect(page.getByTestId('sk-size')).toHaveCount(6)
  await page.getByTestId('sk-size').nth(3).click()
  await page.waitForTimeout(400)
  await shot(page, '16-godot-sizes')
  await page.getByTestId('toolwin-ui-sketcher').getByTitle('Close').click()

  // the Asset Board: requests go to one chat, started with the generators on; the result lands in the
  // gallery as asset:<id>, becomes a candidate, and approving it puts a 16x16 PNG where the mod keeps item textures
  await page.getByTestId('tool-asset-board').click()
  await expect(page.getByTestId('asset-board')).toBeVisible()
  for (const [name, kind] of [['Mana Shard', 'sprite'], ['Rune Bricks', 'texture'], ['Spell Cast', 'sound']] as const) {
    await page.getByTestId('ab-new-name').fill(name)
    await page.getByTestId('ab-new-kind').selectOption(kind)
    await page.getByTestId('ab-add').click()
  }
  await page.getByTestId('ab-card-mana-shard').click()
  await expect(page.getByTestId('ab-path')).toHaveValue('src/main/resources/assets/manamod/textures/item/mana_shard.png')
  await page.getByTestId('ab-notes').fill('A glowing blue crystal shard, held as an item.')
  await page.getByTestId('ab-request').click()
  await expect(page.getByTestId('ab-col-in-progress')).toContainText('Mana Shard')
  await expect.poll(async () => (await chats()).map((c) => c.name), { timeout: 10_000 }).toContain('Asset Board: Make the asset "Mana Shard"')
  const assetChat = (await chats()).find((c) => c.name.startsWith('Asset Board'))!
  // the second request goes to the same chat
  await expect(page.getByTestId('ab-send-to')).toHaveValue(assetChat.id)
  await page.getByTestId('ab-card-rune-bricks').click()
  await page.getByTestId('ab-request').click()
  await expect.poll(chatText, { timeout: 10_000 }).toContain('Make the asset \\"Rune Bricks\\"')
  expect((await chats()).filter((c) => c.name.startsWith('Asset Board'))).toHaveLength(1)
  await page.getByTestId('ab-card-mana-shard').click()
  // stand in for the chat making it: a 64x64 crystal shown in the gallery with the board's title
  await page.evaluate(async () => {
    const c = (globalThis as any).document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')
    g.fillStyle = '#1e3a8a'
    g.beginPath()
    g.moveTo(32, 4); g.lineTo(52, 30); g.lineTo(32, 60); g.lineTo(12, 30); g.closePath(); g.fill()
    g.fillStyle = '#60a5fa'
    g.beginPath()
    g.moveTo(32, 10); g.lineTo(44, 30); g.lineTo(32, 50); g.closePath(); g.fill()
    await (globalThis as any).mm.api.pluginCall('ui-sketcher', 'media.show', [c.toDataURL('image/png'), 'asset:mana-shard glowing crystal'])
  })
  await expect(page.getByTestId('ab-col-review')).toContainText('Mana Shard', { timeout: 10_000 })
  await expect(page.getByTestId('ab-candidate')).toHaveCount(1)
  await page.getByTestId('ab-style').click()
  await page.getByTestId('ab-style-text').fill('16x16 pixel art in the vanilla palette, dark outlines')
  await page.waitForTimeout(500)
  await shot(page, '17-asset-board')
  await page.getByTestId('ab-approve').click()
  const shard = join(project, 'src', 'main', 'resources', 'assets', 'manamod', 'textures', 'item', 'mana_shard.png')
  await expect.poll(() => existsSync(shard), { timeout: 10_000 }).toBe(true)
  expect([readFileSync(shard).readUInt32BE(16), readFileSync(shard).readUInt32BE(20)]).toEqual([16, 16])
  await expect(page.getByTestId('ab-col-done')).toContainText('Mana Shard')
  await page.getByTestId('toolwin-asset-board').getByTitle('Close', { exact: true }).click()

  // Data Tables: a JSON item list as a spreadsheet; a save changes exactly the edited lines; the chat on screen is asked
  await page.getByTestId(`chat-row-${first.id}`).click()
  await page.getByTestId('tool-data-tables').click()
  await expect(page.getByTestId('data-tables')).toBeVisible()
  await page.getByTestId('dt-file-data/items.json').click()
  await expect(page.getByTestId('dt-row')).toHaveCount(5)
  await expect(page.getByTestId('dt-stats-damage')).toContainText('0..12')
  await page.getByTestId('dt-row').nth(3).getByTestId('dt-cell-damage').click()
  await page.getByTestId('dt-editor').fill('8')
  await page.keyboard.press('Enter')
  await page.getByTestId('dt-row').nth(3).getByTestId('dt-cell-rarity').click()
  await page.getByTestId('dt-editor').selectOption('rare')
  await page.getByTestId('dt-chart-toggle').click()
  await page.getByTestId('dt-row').nth(3).locator('input[type=checkbox]').first().check()
  await page.getByTestId('dt-ask-toggle').click()
  await expect(page.getByTestId('dt-ask-to')).toHaveValue(first.id)
  await page.getByTestId('dt-ask-text').fill('Is the Dragon Bow still too strong next to the Iron Sword?')
  await page.waitForTimeout(300)
  await shot(page, '18-data-tables')
  await page.getByTestId('dt-save').click()
  await expect.poll(() => readFileSync(join(project, 'data', 'items.json'), 'utf8'), { timeout: 10_000 }).toContain('"damage": 8')
  const before = itemsText.split('\n')
  const after = readFileSync(join(project, 'data', 'items.json'), 'utf8').split('\n')
  expect(after.length).toBe(before.length)
  expect(after.filter((l, i) => l !== before[i])).toEqual(['    "damage": 8,', '    "rarity": "rare",'])
  await page.getByTestId('dt-ask-send').click()
  await expect.poll(() => readFileSync(join(project, '.multimine', 'chats', first.id, 'messages.jsonl'), 'utf8'), { timeout: 10_000 }).toContain('Is the Dragon Bow still too strong')
  await page.getByTestId('toolwin-data-tables').getByTitle('Close', { exact: true }).click()

  // Logic Board: a mechanic as boxes in plain words, built by a new chat, each box linked to its code
  await page.getByTestId('tool-logic-board').click()
  await expect(page.getByTestId('logic-board')).toBeVisible()
  await page.getByTestId('lb-example').click()
  await expect(page.getByTestId('lb-node-E1')).toBeVisible()
  await page.getByTestId('lb-node-A4').getByText('A4', { exact: true }).click()
  await page.getByTestId('lb-ready-Play sound').click()
  await expect(page.getByTestId('lb-node-A6')).toBeVisible()
  await page.getByTestId('lb-text-A6').fill('a deep boom where it exploded')
  await page.getByTestId('lb-tab-spec').click()
  await expect(page.getByTestId('lb-spec')).toContainText('[C2] IF sneaking: the caster is sneaking')
  await expect(page.getByTestId('lb-spec')).toContainText('[A6] DO Play sound: a deep boom where it exploded')
  await page.getByTestId('logic-board').getByTitle('Fit the board in view').click()
  await page.waitForTimeout(400)
  await shot(page, '19-logic-board')
  const boardDir = join(project, '.multimine', 'boards', 'sneak-shot')
  await expect(page.getByTestId('lb-to')).toHaveValue('new')
  await page.getByTestId('lb-plan-first').check()
  await page.getByTestId('lb-build').click()
  await expect.poll(async () => (await chats()).map((c) => c.name), { timeout: 10_000 }).toContain('Logic Board: Build "Sneak Shot"')
  expect(chatText()).toContain("The board is the user's approved design")
  await expect(page.getByTestId('lb-status')).toContainText('Built - no changes')
  const boardChat = (await chats()).find((c) => c.name === 'Logic Board: Build "Sneak Shot"')!
  await expect(page.getByTestId('lb-to')).toHaveValue(boardChat.id)
  // the builder writes the code map; each box then links to its code
  mkdirSync(join(project, 'src', 'skills'), { recursive: true })
  writeFileSync(join(project, 'src', 'skills', 'SneakShot.java'), 'class SneakShot {\n' + '  // ...\n'.repeat(60) + '}\n')
  writeFileSync(join(boardDir, 'map.json'), JSON.stringify({ E1: [{ file: 'src/skills/SneakShot.java', line: 12 }], A3: [{ file: 'src/skills/SneakShot.java', line: 30, note: 'shoot' }], A4: 'src/skills/SneakShot.java:44' }))
  await page.getByTestId('lb-refresh').click()
  await expect(page.getByTestId('lb-code-A3')).toContainText('SneakShot.java:30')
  // an edit after the build: marked, and Update sends only it, to the chat that built it
  await page.getByTestId('lb-text-A4').fill('explode on the spot: radius 5, deals {damage}, no block damage')
  await page.getByTestId('lb-tab-palette').click()
  await expect(page.getByTestId('lb-build')).toContainText('Update (1)')
  await page.getByTestId('lb-build').click()
  await expect.poll(() => readFileSync(join(project, '.multimine', 'chats', boardChat.id, 'messages.jsonl'), 'utf8'), { timeout: 10_000 }).toContain('Update the mechanic')
  await page.getByTestId('lb-code-A3').click()
  await expect(page.getByTestId('ide')).toBeVisible()
  await expect(page.getByTestId('ide').getByTitle('src/skills/SneakShot.java')).toBeVisible()
  await page.waitForTimeout(600)
  await shot(page, '20-logic-board-code-link')
  await page.getByTestId('code').click()
  await page.getByTestId('tool-logic-board').click()
  await page.getByTestId('toolwin-logic-board').getByTitle('Close', { exact: true }).click()

  // Tables: `/table` in a chat builds a table linked to the code; editing a value there rewrites the class
  await page.getByTestId(`chat-row-${first.id}`).click()
  await input.fill('/')
  await expect(panel.getByTestId('slash-menu')).toContainText('/table')
  await input.press('Tab')
  await expect(input).toHaveValue('/table ')
  const link = (cls: string, line: number, before: string) => ({ file: `src/main/java/com/mana/spells/${cls}.java`, line, before, after: ';' })
  const spellTable = {
    id: 'spells',
    name: 'Spells',
    description: 'Every spell in the mod, read from its class.',
    columns: [
      { key: 'name', label: 'Spell', type: 'text' },
      { key: 'mana', label: 'Mana usage', type: 'number' },
      { key: 'cooldown', label: 'Cooldown', type: 'number', note: 'seconds' },
      { key: 'element', label: 'Element', type: 'enum', values: ['fire', 'light'], colors: { fire: '#d95926', light: '#c98500' } },
      { key: 'damage', label: 'Base damage', type: 'number', note: 'negative heals' }
    ],
    rows: (['Fireball', 'Mend'] as const).map((cls) => ({
      id: cls.toLowerCase(),
      file: `src/main/java/com/mana/spells/${cls}.java`,
      cells: { name: cls },
      links: { mana: link(cls, 4, 'MANA_COST = '), cooldown: link(cls, 5, 'COOLDOWN = '), element: link(cls, 6, 'ELEMENT = '), damage: link(cls, 7, 'BASE_DAMAGE = ') }
    }))
  }
  // the mock stands in for a model: a `/tool` line in the request calls that tool for real
  await say(`/table /tool save_table ${JSON.stringify(spellTable)}`)
  const card = panel.getByTestId('table-card')
  await expect(card).toContainText('Spells', { timeout: 15_000 })
  await expect(card).toContainText('8 of 8 linked to code')
  await expect(card).toContainText('-6')
  await page.waitForTimeout(300)
  await shot(page, '21c-table-card')
  await card.getByTestId('table-card-open').click()
  await expect(page.getByTestId('tables')).toBeVisible()
  await expect(page.getByTestId('tb-link-summary')).toContainText('8 values linked to code')
  // a linked value edited here waits for review, then goes into the class and is read back
  await page.getByTestId('tb-cell-fireball-mana').click()
  await page.getByTestId('tb-cell-input').fill('25')
  await page.getByTestId('tb-cell-input').press('Enter')
  await expect(page.getByTestId('tb-pending')).toContainText('1 value changed here')
  await page.getByTestId('tb-review').click()
  await expect(page.getByTestId('tb-change')).toHaveCount(1)
  await expect(page.getByTestId('tb-change')).toContainText('+ public static final int MANA_COST = 25;')
  await page.waitForTimeout(300)
  await shot(page, '21d-table-review')
  await page.getByTestId('tb-apply').click()
  await expect.poll(() => readFileSync(join(spellDir, 'Fireball.java'), 'utf8'), { timeout: 10_000 }).toContain('MANA_COST = 25;')
  expect(readFileSync(join(spellDir, 'Fireball.java'), 'utf8')).toContain('COOLDOWN = 2.5f;')
  await expect(page.getByTestId('tb-pending')).toHaveCount(0)
  // the code is the truth: a change made there shows up in the table
  writeFileSync(join(spellDir, 'Mend.java'), readFileSync(join(spellDir, 'Mend.java'), 'utf8').replace('COOLDOWN = 4.0f', 'COOLDOWN = 3.5f'))
  await page.getByTestId('tb-refresh').click()
  await expect(page.getByTestId('tb-cell-mend-cooldown')).toHaveText('3.5')
  // a row of the user's own: an idea, with reference values
  await page.getByTestId('tb-add-row').click()
  await page.getByTestId('tb-cell-input').fill('Arcane Bolt')
  await page.getByTestId('tb-cell-input').press('Enter')
  await page.getByTestId('tb-cell-new-idea-mana').click()
  await page.getByTestId('tb-cell-input').fill('12')
  await page.getByTestId('tb-cell-input').press('Enter')
  await page.getByTestId('tb-cell-new-idea-damage').click()
  await page.getByTestId('tb-cell-input').fill('10')
  await page.getByTestId('tb-cell-input').press('Enter')
  await expect(page.getByTestId('tb-pending')).toHaveCount(0)
  // a new column, and the table given to every chat as context
  await page.getByTestId('tb-add-col').click()
  await page.getByTestId('tb-col-label').fill('Cast time')
  await page.getByTestId('tb-col-add').click()
  await expect(page.getByTestId('tb-col-cast_time')).toBeVisible()
  await page.getByTestId('tb-context').check()
  const tableFile = () => JSON.parse(readFileSync(join(project, '.multimine', 'tables', 'spells.json'), 'utf8'))
  await expect.poll(() => tableFile().context, { timeout: 10_000 }).toBe(true)
  await expect.poll(() => tableFile().rows.find((r: any) => r.id === 'new-idea')?.cells, { timeout: 10_000 }).toMatchObject({ name: 'Arcane Bolt', mana: 12, damage: 10 })
  await page.waitForTimeout(300)
  await shot(page, '21e-tables')
  // charts on demand: a line across the spells, a pie by element
  await page.getByTestId('tb-chart-toggle').click()
  await expect(page.getByTestId('tb-line-chart')).toBeVisible()
  await page.getByTestId('tb-line-chart').hover({ position: { x: 60, y: 100 } })
  await expect(page.getByTestId('tb-chart-tip')).toContainText('Fireball')
  await page.waitForTimeout(200)
  await shot(page, '21f-table-line')
  await page.getByTestId('tb-chart-pie').click()
  await page.getByTestId('tb-pie-by').selectOption('element')
  await page.getByTestId('tb-pie-sum').selectOption('mana')
  await expect(page.getByTestId('tb-pie-chart')).toContainText('fire')
  await page.waitForTimeout(200)
  await shot(page, '21g-table-pie')
  // the idea goes to a chat to build, with its values
  await page.getByTestId('tb-row-new-idea').hover()
  await page.getByTestId('tb-implement-new-idea').click()
  await page.getByTestId('tb-implement-to-new-idea').selectOption(first.id)
  await page.getByTestId('tb-implement-go-new-idea').click()
  await expect.poll(() => readFileSync(join(project, '.multimine', 'chats', first.id, 'messages.jsonl'), 'utf8'), { timeout: 10_000 }).toContain('Implement \\"Arcane Bolt\\" from the table \\"Spells\\"')
  await page.getByTestId('toolwin-tables').getByTitle('Close', { exact: true }).click()

  // a new chat; what it is doing, live; and the loop guard pausing it when it relaunches the "game" again and again
  await page.getByTestId('new-chat').click()
  await expect.poll(async () => (await chats()).length, { timeout: 10_000 }).toBe(5)
  const fresh = (await chats())[0]
  await expect(panel.getByTestId('empty-chat')).toBeVisible()
  // a fresh chat picks who it talks to from the composer: ChatGPT here, then back to the offline stand-in
  await panel.getByTestId('composer-provider').click()
  await expect(page.getByTestId('provider-menu')).toContainText('ChatGPT')
  await page.waitForTimeout(400)
  await shot(page, '21-provider-menu')
  await page.getByTestId('provider-codex-cli').click()
  await expect.poll(() => chatFile(fresh.id).provider, { timeout: 10_000 }).toBe('codex-cli')
  await expect(panel.getByTestId('composer-model')).toHaveValue('gpt-5.6-sol')
  await panel.getByTestId('composer-provider').click()
  await page.getByTestId('provider-mock').click()
  await expect.poll(() => chatFile(fresh.id).provider, { timeout: 10_000 }).toBe('mock')
  await panel.getByTestId('composer-access').selectOption('full')
  await say('/tool run_command {"command":"sleep 5"}')
  // once the conversation has started it keeps its provider
  await expect(panel.getByTestId('composer-provider')).toHaveAttribute('data-locked', '')
  const tester = (await chats())[0]
  expect(tester.id).toBe(fresh.id)
  const line = page.getByTestId(`activity-${tester.id}`)
  await expect(line).toContainText('Running', { timeout: 10_000 })
  await expect(line).toContainText('sleep 5')
  await expect(line.getByTestId('activity-clock')).toHaveText(/^0:0[2-5]$/, { timeout: 5_000 })
  await expect(page.getByTestId(`chat-row-${tester.id}`)).toContainText('sleep 5')
  await shot(page, '21b-activity-line')
  await expect(line).toHaveCount(0, { timeout: 15_000 })
  const launch = '/tool run_command {"command":"echo ./gradlew runClient -PquickPlay=New_World"}'
  await say([launch, launch, launch, launch].join('\n'))
  const prompts = panel.getByTestId('inline-prompts')
  await expect(prompts).toContainText('third time with no new edits', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await shot(page, '22-loop-guard')
  await prompts.getByTestId('prompt-tell-input').fill('The world "New World" does not exist. Stop launching and report.')
  await prompts.getByTestId('prompt-tell').click()
  // the mock does not listen, so it launches a fourth time: this time, let it continue
  await expect(prompts).toContainText('fourth time', { timeout: 15_000 })
  await prompts.getByTestId('prompt-continue').click()
  await expect(prompts).toHaveCount(0, { timeout: 10_000 })
  await expect(panel.getByTestId('work-block')).toHaveCount(2, { timeout: 15_000 })
  for (const b of await panel.getByTestId('work-block').all()) await b.locator('button').first().click()
  await expect(panel.getByTestId('tool-card')).toHaveCount(5, { timeout: 15_000 })
  // a reply in order: thinking, work, more thinking, the answer; once done the work folds behind one line
  await say(
    [
      '/think The ability registry should be next to the other skills. Let me look.',
      '/tool run_command {"command":"echo src/skills/Registry.java"}',
      '/tool run_command {"command":"echo registered 12 skills"}',
      '/think Found it: Fireball is registered there, so the new one goes beside it.',
      '/say Found the registry in `src/skills/Registry.java`. The new ability goes next to Fireball; here is the plan.'
    ].join('\n')
  )
  await expect(panel.getByTestId('worked-for').last()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(300)
  await shot(page, '23-timeline-folded')
  await panel.getByTestId('worked-for').last().click()
  await panel.getByTestId('thinking-block').last().click()
  await page.waitForTimeout(300)
  await shot(page, '24-timeline-open')
  await expect(panel.getByTestId('context-meter')).toContainText('Context')
  // a fresh start: the messages stay, the agent starts clean
  await page.getByTestId('fresh-start').click()
  await expect(panel.getByTestId('fresh-line')).toBeVisible()

  // rename the chat in the header
  await page.getByTestId('chat-name').click()
  await page.getByTestId('chat-name-input').fill('Loop guard demo')
  await page.getByTestId('chat-name-input').press('Enter')
  await expect.poll(() => chatFile(tester.id).name, { timeout: 10_000 }).toBe('Loop guard demo')

  // chat settings: a fallback chain and MCP servers, beyond what the composer holds
  await page.getByTestId('chat-settings').click()
  await page.getByTestId('agent-fallback-add').click()
  await page.getByTestId('agent-fallback-add').click()
  await page.getByTestId('agent-fallback').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot(page, '25-chat-settings')
  await page.getByTestId('agent-save').click()
  await expect(page.getByTestId('agent-save')).toHaveCount(0)

  // settings: new-chat defaults and desktop notifications
  await page.getByTestId('settings').click()
  await expect(page.getByTestId('chat-defaults')).toBeVisible()
  await page.waitForTimeout(500)
  await shot(page, '26-settings')
  await page.getByTestId('notification-settings').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('notify-enabled')).toBeChecked()
  await page.getByTestId('notify-test').click()
  await expect(page.getByTestId('notify-test-result')).toBeVisible()
  await page.keyboard.press('Escape')
  // a clicked notification brings up the chat it was about
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('mm:event', { type: 'reveal', agentId: id }), first.id)
  await expect(page.locator(`[data-chat-panel="${first.id}"]`)).toBeVisible()

  // which chat spent what
  await page.getByTestId('usage').click()
  await expect(page.getByTestId('usage-breakdown')).toContainText('Usage by chat')
  await expect(page.getByTestId('usage-breakdown')).toContainText('Loop guard demo')
  await page.waitForTimeout(300)
  await shot(page, '27-usage-breakdown')
  await page.getByTestId('usage').click()

  // the Claude plan's usage windows, as Claude Code reports them during a turn
  await app.evaluate(({ BrowserWindow }) => {
    const now = Date.now()
    BrowserWindow.getAllWindows()[0].webContents.send('mm:event', {
      type: 'plan-limits',
      windows: [
        { window: 'five_hour', label: '5-hour', used: 0.86, resetsAt: now + 2 * 3600_000, status: 'near', at: now },
        { window: 'seven_day', label: 'Weekly', used: 0.41, resetsAt: now + 4 * 86_400_000, status: 'ok', at: now }
      ]
    })
  })
  await expect(page.getByTestId('plan-five_hour')).toContainText('86%')
  await expect(page.getByTestId('plan-seven_day')).toContainText('41%')
  await page.waitForTimeout(300)
  await shot(page, '28-overview')

  // delete a chat from the sidebar: its folder goes
  await page.getByTestId(`chat-row-${tester.id}`).hover()
  await page.getByTestId(`chat-row-delete-${tester.id}`).click()
  await expect(page.getByTestId(`chat-row-${tester.id}`)).toHaveCount(0)
  expect(existsSync(join(project, '.multimine', 'chats', tester.id))).toBe(false)

  expect(existsSync(join(project, '.multimine', 'agents'))).toBe(false)
  expect(existsSync(join(project, 'multimine.md'))).toBe(true)
  await app.close()
})
