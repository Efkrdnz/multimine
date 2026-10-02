import { icons, Puzzle } from 'lucide-react'
import type { PluginInfo } from '@shared/types'

/** An app icon: a rounded square in the plugin's gradient with its glyph, or its own image. */
export function PluginIcon({ plugin, size = 58 }: { plugin: PluginInfo; size?: number }) {
  const icon = plugin.manifest.icon
  const radius = size * 0.26
  if ('file' in icon)
    return <img src={`mmplugin://${plugin.manifest.id}/${icon.file}`} width={size} height={size} style={{ borderRadius: radius }} className="object-cover shadow-[0_8px_22px_-6px_rgba(0,0,0,0.7)]" draggable={false} />
  const Glyph = (icons as Record<string, typeof Puzzle>)[icon.glyph] ?? Puzzle
  return (
    <div
      className="relative flex items-center justify-center overflow-hidden shadow-[0_8px_22px_-6px_rgba(0,0,0,0.75)]"
      style={{ width: size, height: size, borderRadius: radius, background: `linear-gradient(145deg, ${icon.gradient[0]}, ${icon.gradient[1]})` }}
    >
      {/* the glassy top highlight every home-screen icon has */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.32), rgba(255,255,255,0))' }} />
      <Glyph size={size * 0.5} color="white" strokeWidth={2.1} />
    </div>
  )
}
