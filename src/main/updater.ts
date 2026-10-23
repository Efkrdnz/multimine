import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { MainEvent, UpdateState } from '@shared/types'

const { autoUpdater } = electronUpdater

/** How often an open Multimine looks for a new version (it also looks at start). */
const EVERY_MS = 3 * 3600_000

/**
 * Multimine updating itself from the repository's GitHub releases: a new build is downloaded in
 * the background and installed on the next restart (the user can restart at once from the window).
 * Only an installed app updates; running from source, there is nothing to replace.
 */
export class Updater {
  state: UpdateState
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly emit: (e: MainEvent) => void) {
    // an installed Windows app or a Linux AppImage; not a Mac build, a folder build or a run from source
    const supported = app.isPackaged && process.platform !== 'darwin' && autoUpdater.isUpdaterActive()
    this.state = { status: supported ? 'idle' : 'unsupported', current: app.getVersion() }
    if (!supported) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: undefined }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'none', checkedAt: Date.now() }))
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0, checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, percent: 100 }))
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: friendly(e?.message ?? String(e)), checkedAt: Date.now() }))
  }

  private set(patch: Partial<UpdateState>): void {
    // once a version is downloaded, a later check finding nothing newer does not hide it
    if (this.state.status === 'ready' && (patch.status === 'none' || patch.status === 'checking')) return
    this.state = { ...this.state, ...patch }
    this.emit({ type: 'update', state: this.state })
  }

  /** Looks now, and every few hours from here on. */
  start(): void {
    if (this.state.status === 'unsupported' || this.timer) return
    setTimeout(() => void this.check(), 8000)
    this.timer = setInterval(() => void this.check(), EVERY_MS)
  }

  async check(): Promise<UpdateState> {
    if (this.state.status === 'unsupported' || this.state.status === 'downloading') return this.state
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      this.set({ status: 'error', error: friendly((e as Error).message), checkedAt: Date.now() })
    }
    return this.state
  }

  /** Quits, installs the downloaded version and opens it again. */
  install(): void {
    if (this.state.status !== 'ready') throw new Error('No update is ready to install yet.')
    // silent: the installer runs without asking again; then Multimine starts on the new version
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  }
}

function friendly(message: string): string {
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(message)) return 'Could not reach GitHub to look for updates.'
  if (/404|No published versions|Cannot find latest/i.test(message)) return 'No published version yet.'
  return message.split('\n')[0].slice(0, 200)
}
