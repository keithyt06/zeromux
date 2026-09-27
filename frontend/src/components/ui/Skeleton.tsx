export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="加载中" className="space-y-2 p-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 rounded-[var(--r-sm)] bg-[var(--surface-3)] motion-safe:animate-pulse" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  )
}
