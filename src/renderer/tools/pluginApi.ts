import { useCallback } from 'react'
import { api } from '../state/store'

export type PluginCall = <T>(method: string, ...args: unknown[]) => Promise<T>

/**
 * The plugin API as a built-in tool sees it: the same permission-checked calls a third-party plugin's
 * `window.multimine` makes, and nothing more.
 */
export function usePluginApi(id: string): PluginCall {
  return useCallback(<T,>(method: string, ...args: unknown[]) => api().pluginCall(id, method, args) as Promise<T>, [id])
}

/** An IPC error as a sentence: without Electron's "Error invoking remote method" wrapper. */
export const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
