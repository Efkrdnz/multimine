import { isAbsolute, normalize } from 'node:path'
import { PLUGIN_API_VERSION, PLUGIN_PERMISSIONS, type PluginManifest, type PluginPermission } from '@shared/types'

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] }

const HEX = /^#[0-9a-f]{6}$/i

/** A path inside the plugin folder: relative, and never climbing out of it. */
function safeRelative(p: unknown): p is string {
  if (typeof p !== 'string' || !p || isAbsolute(p)) return false
  const n = normalize(p).replace(/\\/g, '/')
  return !n.startsWith('../') && n !== '..'
}

/**
 * Reads a plugin.json. Everything is checked rather than trusted: a manifest is what a stranger's
 * plugin says about itself, and the permissions it lists are what the user is asked to grant.
 */
export function validateManifest(raw: unknown): ManifestResult {
  const errors: string[] = []
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(m.id)) errors.push('id must be 2-40 lowercase letters, digits or dashes')
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) errors.push('name is required (at most 40 characters)')
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) errors.push('version must look like 1.0.0')
  if (typeof m.api !== 'number' || !Number.isInteger(m.api) || m.api < 1) errors.push('api must be a whole number (this app speaks 1)')
  else if (m.api > PLUGIN_API_VERSION) errors.push(`this plugin needs plugin API ${m.api}; this version of Multimine speaks ${PLUGIN_API_VERSION}. Update Multimine.`)
  if (m.entry !== undefined && !safeRelative(m.entry)) errors.push('entry must be a file inside the plugin folder')
  if (m.entry === undefined) errors.push('entry (the page to show) is required')
  const perms: PluginPermission[] = []
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    if ((PLUGIN_PERMISSIONS as readonly string[]).includes(p)) {
      if (!perms.includes(p)) perms.push(p)
    } else errors.push(`unknown permission "${p}"`)
  }
  let icon: PluginManifest['icon'] = { glyph: 'Puzzle', gradient: ['#818cf8', '#c084fc'] }
  if (m.icon && typeof m.icon === 'object') {
    if (typeof m.icon.file === 'string') {
      if (safeRelative(m.icon.file)) icon = { file: m.icon.file }
      else errors.push('icon.file must be inside the plugin folder')
    } else if (typeof m.icon.glyph === 'string') {
      const g = Array.isArray(m.icon.gradient) && m.icon.gradient.length === 2 && m.icon.gradient.every((c: unknown) => typeof c === 'string' && HEX.test(c)) ? m.icon.gradient : ['#818cf8', '#c084fc']
      icon = { glyph: m.icon.glyph.slice(0, 40), gradient: g as [string, string] }
    }
  }
  const w = m.window ?? {}
  const window = {
    width: Math.max(360, Math.min(2400, Number(w.width) || 900)),
    height: Math.max(260, Math.min(1600, Number(w.height) || 640))
  }
  let mcp: PluginManifest['mcp']
  if (m.mcp !== undefined) {
    if (typeof m.mcp?.command !== 'string' || !m.mcp.command) errors.push('mcp.command is required when mcp is given')
    else
      mcp = {
        command: m.mcp.command,
        args: Array.isArray(m.mcp.args) ? m.mcp.args.filter((a: unknown): a is string => typeof a === 'string') : [],
        env: m.mcp.env && typeof m.mcp.env === 'object' ? Object.fromEntries(Object.entries(m.mcp.env).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}
      }
  }
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    manifest: {
      id: m.id,
      name: m.name.trim(),
      version: m.version,
      api: m.api,
      description: typeof m.description === 'string' ? m.description.slice(0, 400) : '',
      icon,
      entry: m.entry,
      window,
      permissions: perms,
      mcp
    }
  }
}

export { PERMISSION_TEXT } from '@shared/pluginText'
