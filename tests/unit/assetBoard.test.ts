import { describe, expect, it } from 'vitest'
import {
  addAsset,
  approve,
  boardJson,
  canMove,
  emptyBoard,
  matchCandidates,
  modIdFrom,
  parseBoard,
  pixelSize,
  removeAsset,
  requestBrief,
  revisionBrief,
  setStatus,
  suggestPath,
  updateAsset
} from '@shared/assets/board'

describe('asset board', () => {
  it('puts each kind where its engine expects it', () => {
    expect(suggestPath('godot', 'sprite', 'Fire Slime')).toBe('assets/sprites/fire_slime.png')
    expect(suggestPath('unity', 'sound', 'Sword Hit')).toBe('Assets/Audio/SFX/sword_hit.ogg')
    expect(suggestPath('unreal', 'model', 'Old Crate')).toBe('SourceArt/Models/old_crate.glb')
    expect(suggestPath('minecraft', 'sprite', 'Mana Shard', 'magical')).toBe('src/main/resources/assets/magical/textures/item/mana_shard.png')
    expect(suggestPath('minecraft', 'texture', 'Rune Bricks', 'magical')).toBe('src/main/resources/assets/magical/textures/block/rune_bricks.png')
    expect(suggestPath('web', 'icon', 'Logo')).toBe('public/assets/icons/logo.png')
    expect(suggestPath(null, 'music', 'Title Theme')).toBe('assets/audio/music/title_theme.ogg')
    expect(modIdFrom('mod_name=Magic\nmod_id=magical\n')).toBe('magical')
    expect(modIdFrom('version=1')).toBeNull()
  })

  it('adds assets with unique ids and a spec fitting the target', () => {
    let b = addAsset(emptyBoard(), 'Mana Shard', 'sprite', 'minecraft', 'magical', 1).board
    const second = addAsset(b, 'Mana shard', 'icon', 'godot', undefined, 2)
    b = second.board
    expect(b.assets.map((a) => a.id)).toEqual(['mana-shard', 'mana-shard-2'])
    expect(b.assets[0].spec.size).toBe('16x16')
    expect(b.assets[1].spec.size).toBe('64x64')
    expect(pixelSize(b.assets[0].spec)).toEqual({ w: 16, h: 16 })
    expect(pixelSize({ size: '5k triangles', format: '', notes: '' })).toBeNull()
    b = updateAsset(b, 'mana-shard', { spec: { notes: 'a glowing blue crystal' } as never })
    expect(b.assets[0].spec).toMatchObject({ size: '16x16', notes: 'a glowing blue crystal' })
    expect(removeAsset(b, 'mana-shard-2').assets).toHaveLength(1)
  })

  it('moves through the pipeline and remembers how', () => {
    let b = addAsset(emptyBoard(), 'Crate', 'model', 'godot', undefined, 1).board
    expect(canMove('wanted', 'approved')).toBe(false)
    expect(() => setStatus(b, 'crate', 'approved')).toThrow(/cannot become approved/)
    b = setStatus(b, 'crate', 'requested', undefined, 2)
    // nothing yet with its title, and other titles are ignored
    expect(matchCandidates(b, [{ id: 'm0', path: '/p/x.png', kind: 'image', ts: 1, title: 'just a picture' }]).arrived).toEqual([])
    const media = [
      { id: 'm1', path: '/p/.multimine/media/m1.glb', kind: 'model', ts: 3, title: 'asset:crate wooden, iron bands' },
      { id: 'm2', path: '/p/.multimine/media/m2.glb', kind: 'model', ts: 4, title: 'ASSET:crate broken variant' }
    ]
    const got = matchCandidates(b, media, 5)
    b = got.board
    expect(got.arrived).toEqual(['crate'])
    expect(b.assets[0].status).toBe('review')
    expect(b.assets[0].candidates.map((c) => c.mediaId)).toEqual(['m1', 'm2'])
    // seen once only
    expect(matchCandidates(b, media).arrived).toEqual([])
    b = setStatus(b, 'crate', 'rejected', 'more worn', 6)
    b = setStatus(b, 'crate', 'requested', undefined, 7)
    b = matchCandidates(b, [...media, { id: 'm3', path: '/p/m3.glb', kind: 'model', ts: 8, title: 'asset:crate worn' }], 9).board
    expect(() => approve(b, 'crate', 'nope')).toThrow()
    b = approve(b, 'crate', 'm3', 10)
    expect(b.assets[0]).toMatchObject({ status: 'approved', chosen: 'm3' })
    expect(b.assets[0].history.map((h) => h.status)).toEqual(['wanted', 'requested', 'review', 'rejected', 'requested', 'review', 'approved'])
    expect(b.assets[0].history[3].note).toBe('more worn')
  })

  it('round-trips through its file and repairs a hand-edited one', () => {
    let b = addAsset(emptyBoard(), 'Hit', 'sound', 'unity').board
    b = { ...b, style: { text: 'cosy pixel art', palette: ['#ffcc00', 'red'] } }
    const back = parseBoard(JSON.parse(boardJson(b)))
    expect(back.assets).toEqual(b.assets)
    expect(back.style.palette).toEqual(['#ffcc00'])
    const repaired = parseBoard({ assets: [{ id: 'ok', kind: 'nonsense', targetPath: '../../etc/passwd' }, { id: 'ok' }, { id: '../bad' }, null] })
    expect(repaired.assets).toHaveLength(1)
    expect(repaired.assets[0].kind).toBe('sprite')
    expect(repaired.assets[0].targetPath).not.toContain('..')
    expect(parseBoard('nonsense').assets).toEqual([])
  })

  it('briefs a chat with the spec, the style, how to generate it and the title rule', () => {
    let b = addAsset(emptyBoard(), 'Mana Shard', 'sprite', 'minecraft', 'magical').board
    b = updateAsset(b, 'mana-shard', { spec: { notes: 'a glowing blue crystal' } as never })
    b = { ...b, style: { text: 'vanilla-like, 16 colours', palette: ['#3b82f6'] } }
    const brief = requestBrief(b.assets[0], b, 'Minecraft')
    expect(brief).toContain('a sprite for a Minecraft project')
    expect(brief).toContain('Size: 16x16')
    expect(brief).toContain('What it is: a glowing blue crystal')
    expect(brief).toContain('Style guide: vanilla-like, 16 colours')
    expect(brief).toContain('`asset:mana-shard <short description>`')
    expect(brief).toContain('src/main/resources/assets/magical/textures/item/mana_shard.png')
    expect(brief).not.toMatch(/\n\n\n/)
    expect(revisionBrief(b.assets[0], 'brighter')).toContain('What to change: brighter')
    expect(brief.split('\n')[0]).toBe('# Make the asset "Mana Shard"')
    expect(brief).toContain('poll its status')
    expect(brief).not.toMatch(/Asset Creator|Mastermind|report`/)
  })
})
