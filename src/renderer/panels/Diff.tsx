/** A unified diff, coloured by line. */
export function Diff({ text, tall = false }: { text: string; tall?: boolean }) {
  return (
    <pre className={`scroll-thin ${tall ? 'max-h-[70vh]' : 'max-h-[42vh]'} overflow-auto rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] leading-[1.45] select-text`}>
      {text.split('\n').map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith('+') && !l.startsWith('+++')
              ? 'bg-emerald-500/10 text-emerald-200'
              : l.startsWith('-') && !l.startsWith('---')
                ? 'bg-red-500/10 text-red-200'
                : l.startsWith('@@')
                  ? 'text-cyan-300'
                  : 'text-slate-300'
          }
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}
