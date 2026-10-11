import { Cpu, FlaskConical } from 'lucide-react'
import type { ProviderKind } from '@shared/types'

/**
 * Provider logos as single paths on a 24x24 grid, from LobeHub's icon set (MIT,
 * github.com/lobehub/lobe-icons). The marks themselves belong to their companies and are shown
 * only to say which service a chat uses.
 */
const PATHS = {
  claude: ["M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"],
  anthropic: ["M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"],
  openai: ["M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"],
  gemini: ["M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"],
  xai: ["M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"],
  groq: ["M12.036 2c-3.853-.035-7 3-7.036 6.781-.035 3.782 3.055 6.872 6.908 6.907h2.42v-2.566h-2.292c-2.407.028-4.38-1.866-4.408-4.23-.029-2.362 1.901-4.298 4.308-4.326h.1c2.407 0 4.358 1.915 4.365 4.278v6.305c0 2.342-1.944 4.25-4.323 4.279a4.375 4.375 0 01-3.033-1.252l-1.851 1.818A7 7 0 0012.029 22h.092c3.803-.056 6.858-3.083 6.879-6.816v-6.5C18.907 4.963 15.817 2 12.036 2z"],
  openrouter: ["M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z"],
}

type Mark = keyof typeof PATHS

/** Each provider's mark, the colour it is drawn in, and the tint of its tile. */
const LOOK: Record<ProviderKind, { mark?: Mark; color: string; tint: string }> = {
  'claude-cli': { mark: 'claude', color: '#d97757', tint: '#d97757' },
  anthropic: { mark: 'anthropic', color: '#f0e6dc', tint: '#d97757' },
  'codex-cli': { mark: 'openai', color: '#f4f4f5', tint: '#10a37f' },
  openai: { mark: 'openai', color: '#f4f4f5', tint: '#10a37f' },
  google: { mark: 'gemini', color: 'url(#mm-gemini)', tint: '#4f8dff' },
  groq: { mark: 'groq', color: '#f55036', tint: '#f55036' },
  xai: { mark: 'xai', color: '#f4f4f5', tint: '#a1a1aa' },
  openrouter: { mark: 'openrouter', color: '#9a9dff', tint: '#6467f2' },
  compatible: { color: '#67e8f9', tint: '#22d3ee' },
  mock: { color: '#a5b4fc', tint: '#7c9cff' }
}

/** A provider's logo alone, in its colour (or `color`). */
export function ProviderLogo({ p, size = 14, color }: { p: ProviderKind; size?: number; color?: string }) {
  const look = LOOK[p]
  if (!look.mark) {
    const Icon = p === 'mock' ? FlaskConical : Cpu
    return <Icon size={size} color={color ?? look.color} strokeWidth={2} className="shrink-0" />
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0" aria-hidden>
      {look.mark === 'gemini' && (
        <defs>
          <linearGradient id="mm-gemini" x1="4" y1="20" x2="20" y2="4" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#1fa2ff" />
            <stop offset="0.55" stopColor="#6b7cff" />
            <stop offset="1" stopColor="#c86dd7" />
          </linearGradient>
        </defs>
      )}
      {PATHS[look.mark].map((d, i) => (
        <path key={i} d={d} fill={color ?? look.color} fillRule="evenodd" />
      ))}
    </svg>
  )
}

/**
 * A provider's logo on a small tile tinted in its colour: in the composer, the provider menu, the
 * new-chat cards and the corner of a chat's avatar.
 */
export function ProviderMark({ p, size = 22, className = '' }: { p: ProviderKind; size?: number; className?: string }) {
  const { tint } = LOOK[p]
  return (
    <span
      className={`provider-mark inline-flex shrink-0 items-center justify-center ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: `linear-gradient(145deg, color-mix(in srgb, ${tint} 30%, #0b0d1f), color-mix(in srgb, ${tint} 12%, #07081a))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 40%, transparent), 0 2px 10px -4px ${tint}`
      }}
      data-provider={p}
    >
      <ProviderLogo p={p} size={Math.round(size * 0.6)} />
    </span>
  )
}

/** The colour a provider's tile is tinted in. */
export const providerTint = (p: ProviderKind): string => LOOK[p].tint
