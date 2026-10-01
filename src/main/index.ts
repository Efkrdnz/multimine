import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { API_METHODS } from '@shared/api'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from './app'

// Tests and portable installs can point the user-data folder elsewhere.
if (process.env.MULTIMINE_USER_DATA) app.setPath('userData', resolve(process.env.MULTIMINE_USER_DATA))

protocol.registerSchemesAsPrivileged([{ scheme: 'mm', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } }])

let win: BrowserWindow | null = null

function emit(e: MainEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('mm:event', e)
}

const cipher = {
  encrypt: (plain: string) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : `plain:${Buffer.from(plain).toString('base64')}`),
  decrypt: (blob: string) =>
    blob.startsWith('plain:') ? Buffer.from(blob.slice(6), 'base64').toString() : safeStorage.decryptString(Buffer.from(blob, 'base64'))
}

const mm = new MultimineApp({
  userDataDir: app.getPath('userData'),
  cipher,
  emit,
  mockDelayMs: process.env.MULTIMINE_MOCK_DELAY ? Number(process.env.MULTIMINE_MOCK_DELAY) : undefined,
  forceMockMastermind: process.env.MULTIMINE_FORCE_MOCK === '1'
})

function argProject(): string | null {
  const i = process.argv.indexOf('--project')
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : null
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#05060f',
    title: 'Multimine',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  await mm.start()

  // mm://media/<absolute path, url-encoded> serves media files the gallery shows
  protocol.handle('mm', (req) => {
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const root = mm.project?.paths.media
    if (!root || !resolve(path).startsWith(resolve(root))) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })

  const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
    pickProject: async () => {
      const r = await dialog.showOpenDialog(win!, { title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : r.filePaths[0]
    },
    openPath: async (p: string) => {
      await shell.openPath(p)
    },
    mediaUrl: async (p: string) => `mm://media/${encodeURIComponent(p)}`
  }
  for (const m of API_METHODS) {
    ipcMain.handle(`mm:${m}`, async (_e, ...args) => {
      const fn = handlers[m] ?? (mm as any)[m]
      if (typeof fn !== 'function') throw new Error(`Unknown method ${m}`)
      return fn.apply(handlers[m] ? null : mm, args)
    })
  }

  createWindow()
  const dir = argProject()
  if (dir) win!.webContents.once('did-finish-load', () => void mm.openProject(dir).catch((e) => emit({ type: 'toast', level: 'error', text: String(e) })))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void mm.shutdown()
})
