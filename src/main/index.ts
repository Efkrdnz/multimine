import { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol, safeStorage, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { API_METHODS } from '@shared/api'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from './app'
import { Notifier, type Note } from './notify'
import { servePlugin } from './plugins/protocol'

// Tests and portable installs can point the user-data folder elsewhere.
if (process.env.MULTIMINE_USER_DATA) app.setPath('userData', resolve(process.env.MULTIMINE_USER_DATA))

protocol.registerSchemesAsPrivileged([
  { scheme: 'mm', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } },
  // plugin pages: a standard, secure scheme so they behave like web pages, but never bypassing their CSP
  { scheme: 'mmplugin', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
])

let win: BrowserWindow | null = null
// held so a click still lands after the toast has gone to Action Center
const live = new Set<Notification>()

function emit(e: MainEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('mm:event', e)
  notifier.handle(e)
}

/** A desktop notification; clicking it brings the window forward on what it was about. */
function showNote(n: Note): boolean {
  if (!Notification.isSupported()) return false
  const note = new Notification({ title: n.title, body: n.body })
  live.add(note)
  note.on('click', () => {
    live.delete(note)
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    emit({ type: 'reveal', itemId: n.itemId, agentId: n.agentId })
  })
  note.on('close', () => live.delete(note))
  note.show()
  // the taskbar button flashes until the window is focused
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
  return true
}

const notifier = new Notifier({
  show: (n) => void showNote(n),
  isFocused: () => !!win && !win.isDestroyed() && win.isFocused() && !win.isMinimized(),
  settings: () => mm.config.settings.notifications,
  agentName: (id) => mm.project?.get(id)?.name ?? id
})

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
  win.on('focus', () => win?.flashFrame(false))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Windows shows toasts only for an app with a user model id; a dev run uses the electron binary's path
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.efkrdnz.multimine' : process.execPath)

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

  protocol.handle('mmplugin', (req) => servePlugin(req.url, (id) => mm.plugins.find(id, mm.project?.dir)))

  const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
    pluginPickAndInstall: async () => {
      const r = await dialog.showOpenDialog(win!, { title: 'Choose a plugin folder (it holds plugin.json)', properties: ['openDirectory'] })
      return r.canceled ? null : mm.pluginInstall(r.filePaths[0])
    },
    pickProject: async () => {
      const r = await dialog.showOpenDialog(win!, { title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : r.filePaths[0]
    },
    openPath: async (p: string) => {
      await shell.openPath(p)
    },
    mediaUrl: async (p: string) => `mm://media/${encodeURIComponent(p)}`,
    testNotification: async () => showNote({ title: 'Multimine notifications are on', body: 'You will see this when an agent has a question, needs a permission or is paused.' }),
    // hand a file to the user's real IDE; fall back to whatever the system opens it with
    ideOpenExternal: async (rel: string, which: 'idea' | 'code' | 'system') => {
      const root = mm.project?.dir
      if (!root) return
      const full = resolve(root, rel)
      if (!full.startsWith(resolve(root))) return
      if (which !== 'system') {
        const ok = await new Promise<boolean>((done) => {
          const child = spawn(which, [full], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
          child.on('error', () => done(false))
          child.on('spawn', () => done(true))
          child.unref()
        })
        if (ok) return
        emit({ type: 'toast', level: 'error', text: `Could not start \`${which}\`. Add it to PATH (IntelliJ: Tools > Create Command-line Launcher; VS Code: "Shell Command: Install 'code'").` })
      }
      await shell.openPath(full)
    }
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
