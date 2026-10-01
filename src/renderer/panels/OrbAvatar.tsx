import type { AgentStatus } from '@shared/types'

/** The scene's orb as a small SVG, for chat headers, tabs and the editor preview. */
export function OrbAvatar({ color, size = 28, status = 'idle', brain = false }: { color: string; size?: number; status?: AgentStatus; brain?: boolean }) {
  const id = `g${color.replace('#', '')}${brain ? 'b' : ''}`
  const ring = { idle: 'transparent', thinking: '#a78bfa', working: '#34d399', waiting: '#fbbf24', error: '#f87171' }[status]
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="shrink-0" style={{ filter: `drop-shadow(0 0 ${size / 5}px ${brain ? '#c026d3' : color}aa)` }}>
      <defs>
        <radialGradient id={id} cx="38%" cy="34%" r="70%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="30%" stopColor={brain ? '#e879f9' : color} />
          <stop offset="100%" stopColor="#0b0820" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="44" fill={`url(#${id})`} />
      {brain ? (
        <g fill="none" stroke="#fdf4ff" strokeWidth="4" strokeLinecap="round" opacity="0.85">
          <path d="M50 20 Q46 50 50 78" />
          <path d="M28 36 q8 -6 14 2 q6 8 0 14" />
          <path d="M72 36 q-8 -6 -14 2 q-6 8 0 14" />
          <path d="M26 58 q10 4 16 -4" />
          <path d="M74 58 q-10 4 -16 -4" />
        </g>
      ) : (
        <g>
          {status === 'error' ? (
            <g stroke="#1a1033" strokeWidth="5" strokeLinecap="round" fill="none">
              <path d="M30 40 L40 46 L30 52" />
              <path d="M70 40 L60 46 L70 52" />
            </g>
          ) : (
            <>
              <ellipse cx="36" cy="47" rx="7" ry={status === 'waiting' ? 11 : 9} fill="#1a1033" />
              <ellipse cx="64" cy="47" rx="7" ry={status === 'waiting' ? 11 : 9} fill="#1a1033" />
              <circle cx="34" cy="42" r="2.8" fill="#fff" />
              <circle cx="62" cy="42" r="2.8" fill="#fff" />
            </>
          )}
          <ellipse cx="25" cy="60" rx="6" ry="3" fill="#ff6b9d" opacity="0.45" />
          <ellipse cx="75" cy="60" rx="6" ry="3" fill="#ff6b9d" opacity="0.45" />
          <path d="M44 62 Q50 68 56 62" stroke="#1a1033" strokeWidth="3.5" fill="none" strokeLinecap="round" />
        </g>
      )}
      <circle cx="50" cy="50" r="47" fill="none" stroke={ring} strokeWidth="4" strokeDasharray={status === 'thinking' || status === 'working' ? '40 20' : undefined} />
    </svg>
  )
}
