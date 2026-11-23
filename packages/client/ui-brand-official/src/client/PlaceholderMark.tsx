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
        d="M15.9 8.1A5.5 5.5 0 1 0 15.9 15.9"
        stroke="var(--dsw-alias-label-primary-inverted)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
