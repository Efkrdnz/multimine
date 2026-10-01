import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, type Api, type Bridge } from '@shared/api'
import type { MainEvent } from '@shared/types'

const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`mm:${m}`, ...args)])) as unknown as Api

const bridge: Bridge = {
  api,
  onEvent(cb) {
    const listener = (_: unknown, e: MainEvent) => cb(e)
    ipcRenderer.on('mm:event', listener)
    return () => ipcRenderer.removeListener('mm:event', listener)
  }
}

contextBridge.exposeInMainWorld('mm', bridge)
