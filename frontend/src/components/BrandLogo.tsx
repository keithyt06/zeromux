/** ZeroMux brand logo — lobehub-style geometric mark: yellow squircle tile with
 *  three multiplexed streams converging into a Z diagonal. Inline SVG, no external
 *  deps. size controls the edge length (px). */
interface BrandLogoProps {
  size?: number
  className?: string
}

export function BrandLogo({ size = 24, className }: BrandLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" className={className} xmlns="http://www.w3.org/2000/svg">
      <title>ZeroMux</title>
      <rect x="16" y="16" width="224" height="224" rx="56" fill="#f7b500" />
      <g stroke="#11161d" strokeWidth="14" strokeLinecap="round" fill="none">
        <path d="M64 96 H150" />
        <path d="M64 128 H150" />
        <path d="M64 160 H150" />
      </g>
      <path d="M150 84 H196 L92 172 H188" fill="none" stroke="#11161d" strokeWidth="20" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
