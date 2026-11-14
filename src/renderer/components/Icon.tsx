import type { SVGProps } from 'react'

export type IconName =
  | 'home'
  | 'plan'
  | 'write'
  | 'review'
  | 'memory'
  | 'settings'
  | 'lock'
  | 'arrow'
  | 'more'
  | 'palette'

const PATHS: Record<IconName, string> = {
  home: 'M3 9.5 10 3l7 6.5V17h-5v-4H8v4H3z',
  plan: 'M3 4h5v5H3zM12 4h5v5h-5zM3 11h5v5H3zM12 11h5v5h-5z',
  write: 'M4 16.5 5 13l8.5-8.5 2 2L7 15zM13 4.5l2-2 2 2-2 2z',
  review: 'M3 4h14v12H3zM6 8l2 2 4-4',
  memory: 'M4 5h12v4H4zM4 11h12v4H4z',
  settings:
    'M10 6.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8ZM10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4',
  lock: 'M5 9h10v7H5zM7 9V7a3 3 0 0 1 6 0v2',
  arrow: 'M4 10h11M11 6l4 4-4 4',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  palette: 'M10 3a7 7 0 1 0 0 14h1.2a1.8 1.8 0 0 0 0-3.6h-.6a1.3 1.3 0 0 1 0-2.6H14A3 3 0 0 0 17 7.9 5 5 0 0 0 10 3Z'
}

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
