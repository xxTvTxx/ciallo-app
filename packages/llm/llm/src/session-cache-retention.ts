/**
 * Per-Session prompt-cache lifetime choices. A choice is request metadata, not
 * model-visible content, so it lives in a storage-domain sidecar instead of the
 * Session log. Without a storage domain the choices last for this process.
 *
 * @module @deepseek-ai/dsh-llm/session-cache-retention
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain as StorageDomain } from '@deepseek-ai/dsh-storage-domain'
import type { LlmCacheRetention } from './types.ts'

/** Durable domain holding one choice per Session id. */
export const sessionCacheRetentionDomain = defineDomain({
  name: 'llm_session_cache_retention',
  version: 1,
  tables: {},
  global: {
    schema: z.object({ sessions: z.record(z.string(), z.enum(['short', 'long'])) }),
    initial: { sessions: {} },
  },
})

type Domain = StorageDomain<typeof sessionCacheRetentionDomain>

/** Synchronous reads over the per-Session choices; writes are durable before they resolve. */
export class SessionCacheRetentions {
  private readonly memory = new Map<string, LlmCacheRetention>()
  private domain: Domain | undefined
  private ready: Promise<void> = Promise.resolve()

  /**
   * Load stored choices whenever a storage domain is mounted, and release the domain with it.
   * @param ctx - owning Service context.
   */
  constructor(ctx: Context) {
    ctx.inject(['storageDomain'], (child) => {
      let opened: Domain | undefined
      this.ready = child.storageDomain.open(sessionCacheRetentionDomain).then((domain) => {
        opened = domain
        // The domain schema validated each stored value when the domain opened.
        for (const [sessionId, retention] of Object.entries(domain.global.get().sessions)) {
          this.memory.set(sessionId, retention as LlmCacheRetention)
        }
        this.domain = domain
      }, (error: unknown) => {
        child.logger.warn(`llm: Session cache lifetimes are not durable: ${String(error)}`)
      })
      child.effect(() => async () => {
        await this.ready
        if (this.domain === opened) this.domain = undefined
        await opened?.close()
      })
    })
  }

  /**
   * Read one Session's choice.
   * @param sessionId - Session id.
   * @returns the chosen lifetime, or undefined when the Session follows its route default.
   */
  get(sessionId: string): LlmCacheRetention | undefined {
    return this.memory.get(sessionId)
  }

  /**
   * Record or clear one Session's choice.
   * @param sessionId - Session id.
   * @param retention - lifetime to use, or undefined to follow the route default again.
   */
  async set(sessionId: string, retention: LlmCacheRetention | undefined): Promise<void> {
    await this.ready
    const next = new Map(this.memory)
    if (retention === undefined) next.delete(sessionId)
    else next.set(sessionId, retention)
    await this.domain?.global.set({ sessions: Object.fromEntries(next) })
    if (retention === undefined) this.memory.delete(sessionId)
    else this.memory.set(sessionId, retention)
  }
}
