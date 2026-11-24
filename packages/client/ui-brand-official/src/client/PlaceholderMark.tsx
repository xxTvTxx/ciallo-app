import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Render the temporary distribution mark: an ink tile carrying an open ring.
 * Both brand-mark slots use it until the final artwork replaces it.
 * @param props - requested square edge and optional host class.
 * @returns the decorative mark svg.
 */
export function PlaceholderMark({ size, className }: SidebarBrandMarkOwnerProps & Partial<Pick<HeroBrandMarkOwnerProps, 'className'>>) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="7" fill="currentColor" />
      <path
        d="M14.7 8.4a5.2 5.2 0 1 0 0 8.2"
        stroke="var(--dsw-alias-label-primary-inverted)"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <path
        d="M16.7 4.6Q17.3 6.7 19.4 7.3Q17.3 7.9 16.7 10.0Q16.1 7.9 14.0 7.3Q16.1 6.7 16.7 4.6Z"
        fill="var(--dsw-alias-label-primary-inverted)"
      />
    </svg>
  )
}
