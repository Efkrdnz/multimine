// electron-vite finds Electron through node_modules/electron/path.txt, which only Electron's own
// install.js writes. Electron 44 no longer runs install.js on `npm install` (it downloads lazily
// when its own path getter is first used, which electron-vite never calls), so a fresh checkout
// fails with "Electron uninstall". This runs the download once, before dev/start/e2e.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const dir = dirname(require.resolve('electron/package.json'))
const pathFile = join(dir, 'path.txt')
const exe = existsSync(pathFile) ? join(dir, 'dist', readFileSync(pathFile, 'utf8').trim()) : null

if (exe && existsSync(exe)) process.exit(0)

console.log('Downloading Electron (first run only)...')
const r = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit' })
if (r.status !== 0 || !existsSync(pathFile)) {
  console.error(
    '\nCould not download Electron. If you are behind a proxy or firewall, set HTTPS_PROXY, or point\n' +
      'ELECTRON_MIRROR at a mirror (e.g. https://npmmirror.com/mirrors/electron/), then run npm run dev again.'
  )
  process.exit(r.status || 1)
}
