/** ZeroMux 品牌 logo —— Keith Haring 风格「黄底黑 Z」。内联 SVG，延续
 *  BrandIcons.tsx 的做法（不引外部依赖）。size 控制边长（px）。 */
interface HaringLogoProps {
  size?: number
  className?: string
}

export default function HaringLogo({ size = 24, className }: HaringLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" className={className} xmlns="http://www.w3.org/2000/svg">
      <title>ZeroMux</title>
      <rect x="7" y="7" width="106" height="106" rx="22" fill="#f7b500" stroke="#111" strokeWidth="8" />
      <path d="M76 30 H46 L42 47 H62 L40 90 H72 L76 73 H58 L80 30 Z" fill="#111" stroke="#111" strokeWidth="4" strokeLinejoin="round" />
      <g stroke="#111" strokeWidth="5" strokeLinecap="round">
        <line x1="26" y1="24" x2="17" y2="14" />
        <line x1="94" y1="24" x2="103" y2="14" />
        <line x1="26" y1="96" x2="17" y2="106" />
        <line x1="94" y1="96" x2="103" y2="106" />
      </g>
    </svg>
  )
}
