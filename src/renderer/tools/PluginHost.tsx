import { useLayoutEffect, useRef, useState } from 'react'
import type { PluginInfo } from '@shared/types'
import { api } from '../state/store'

type Handler = (data: any, reply: (body: { result?: unknown; error?: string }) => void) => void

/**
 * One listener for the whole app, installed before any plugin page exists. Each frame is given a
 * random token in its URL and the SDK stamps it on every call, so a call is routed by what it
 * carries rather than by comparing window objects (which a sandboxed, navigating frame does not keep
 * stable). A page's first calls can go out before its host has attached; they wait here by token.
 * A token only routes: what a plugin may do is decided in the main process from its id.
 */
const handlers = new Map<string, Handler>()
const early = new Map<string, { source: MessageEventSource; data: any }[]>()

function replier(source: MessageEventSource, id: unknown) {
  return (body: { result?: unknown; error?: string }) => (source as Window).postMessage({ mm: 1, reply: id, ...body }, '*')
}

window.addEventListener('message', (e) => {
  const d = e.data
  if (!e.source || !d || d.mm !== 1 || typeof d.method !== 'string' || typeof d.host !== 'string') return
  const h = handlers.get(d.host)
  if (h) return h(d, replier(e.source, d.id))
  const queue = early.get(d.host) ?? []
  if (queue.length < 100 && early.size < 50) early.set(d.host, [...queue, { source: e.source, data: d }])
})

function register(token: string, h: Handler): () => void {
  handlers.set(token, h)
  for (const { source, data } of early.get(token) ?? []) h(data, replier(source, data.id))
  early.delete(token)
  return () => {
    handlers.delete(token)
    early.delete(token)
  }
}

function newToken(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * A web plugin's page, in a sandboxed frame with no access to the app. The only way in or out is
 * postMessage: each call is routed by its frame's token and passed to the main process,
 * which checks the plugin's permissions before doing anything.
 */
export function PluginHost({ plugin, onTitle, onClose }: { plugin: PluginInfo; onTitle: (t: string) => void; onClose: () => void }) {
  const [token] = useState(newToken)
  const id = plugin.manifest.id
  const title = useRef(onTitle)
  const close = useRef(onClose)
  title.current = onTitle
  close.current = onClose

  useLayoutEffect(
    () =>
      register(token, async (d, reply) => {
        if (d.method === 'ui.setTitle') return (title.current(String(d.args?.[0] ?? '').slice(0, 80)), reply({ result: true }))
        if (d.method === 'ui.close') return (close.current(), reply({ result: true }))
        try {
          reply({ result: await api().pluginCall(id, d.method, Array.isArray(d.args) ? d.args : []) })
        } catch (err) {
          reply({ error: String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
        }
      }),
    [token, id]
  )

  return (
    <iframe
      title={plugin.manifest.name}
      src={`mmplugin://${id}/${plugin.manifest.entry ?? 'index.html'}?mmhost=${token}`}
      sandbox="allow-scripts allow-downloads"
      className="h-full w-full border-0 bg-transparent"
      data-testid={`plugin-frame-${id}`}
    />
  )
}
