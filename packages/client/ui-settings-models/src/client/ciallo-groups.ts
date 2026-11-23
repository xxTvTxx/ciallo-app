/**
 * CialloAPI groups. The gateway binds every API key to exactly one group, so the
 * Models page stores one llm-pi-ai route per key: `cialloapi` for the first
 * group, then `cialloapi-2`, `cialloapi-3`, and so on. A group's kind is read
 * from the model ids its key lists and decides the protocol the route speaks.
 */

import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CIALLO_API } from './ciallo-api.ts'
import { modelDrafts } from './DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { adoptCandidate } from './ModelListEditor.tsx'
import type { ModelsKey } from './locales.ts'

/** Route ids llm-pi-ai treats as CialloAPI groups; the same expression the adapter matches. */
const CIALLO_ROUTE = /^cialloapi(?:-[2-9]|-[1-9][0-9]+)?$/

/** The protocol each llm-pi-ai Claude group speaks; cache and session-affinity controls apply only to it. */
export const CLAUDE_PROTOCOL = 'anthropic-messages'

/** Model the Claude group prefers as the default when its key lists it. */
const PREFERRED_CLAUDE_MODEL = 'claude-opus-5-5'

/** Model-id prefixes of OpenAI's own families. */
const OPENAI_FAMILY = /^(?:gpt|o\d|codex|chatgpt)/

/** What a group's key serves, as its model ids show. */
export type CialloGroupKind = 'claude' | 'openai' | 'gemini' | 'mixed'

/** Copy key naming each kind; the default group name. */
export const CIALLO_KIND_KEYS: Readonly<Record<CialloGroupKind, ModelsKey>> = {
  claude: 'cialloKindClaude',
  openai: 'cialloKindOpenAi',
  gemini: 'cialloKindGemini',
  mixed: 'cialloKindMixed',
}

const KIND_PROTOCOLS: Readonly<Record<CialloGroupKind, string>> = {
  claude: CLAUDE_PROTOCOL,
  gemini: 'google-generative-ai',
  openai: 'openai-responses',
  mixed: 'openai-responses',
}

/** Separator between the gateway name and a group name in a route's display name. */
const NAME_SEPARATOR = ' · '

/**
 * Whether a route id names a CialloAPI group.
 * @param provider - route id.
 * @returns true for `cialloapi` and `cialloapi-<n>` with n of 2 or more.
 */
export function isCialloRoute(provider: string): boolean {
  return CIALLO_ROUTE.test(provider)
}

/** A group route's ordinal: 1 for `cialloapi`, n for `cialloapi-<n>`. */
function ordinal(route: string): number {
  return route === CIALLO_API.provider ? 1 : Number(route.slice(CIALLO_API.provider.length + 1))
}

/**
 * Order group routes by their ordinal rather than as strings, so `cialloapi-10` follows `cialloapi-9`.
 * @param left - one group route.
 * @param right - another group route.
 * @returns a negative, zero, or positive comparison.
 */
export function compareCialloRoutes(left: string, right: string): number {
  return ordinal(left) - ordinal(right)
}

/**
 * The route id a new group takes: the smallest free ordinal.
 * @param taken - route ids already in use.
 * @returns `cialloapi` when free, else the first free `cialloapi-<n>`.
 */
export function nextCialloRoute(taken: readonly string[]): string {
  if (!taken.includes(CIALLO_API.provider)) return CIALLO_API.provider
  let next = 2
  while (taken.includes(`${CIALLO_API.provider}-${String(next)}`)) next += 1
  return `${CIALLO_API.provider}-${String(next)}`
}

/**
 * Recognize a group from the model ids its key lists. Claude and Gemini need
 * all or most ids; anything else is OpenAI when every id belongs to an OpenAI
 * family, or mixed.
 * @param ids - listed model ids.
 * @returns the group kind.
 */
export function classifyCialloModels(ids: readonly string[]): CialloGroupKind {
  const lower = ids.map(id => id.toLowerCase())
  const most = (prefix: string): boolean => lower.filter(id => id.startsWith(prefix)).length * 2 > lower.length
  if (most('claude')) return 'claude'
  if (most('gemini')) return 'gemini'
  return lower.length > 0 && lower.every(id => OPENAI_FAMILY.test(id)) ? 'openai' : 'mixed'
}

/**
 * The kind a stored group shows: its protocol decides Claude and Gemini, and its models decide the rest.
 * @param api - the route's protocol.
 * @param ids - the route's model ids.
 * @returns the group kind.
 */
export function storedCialloKind(api: string | undefined, ids: readonly string[]): CialloGroupKind {
  if (api === CLAUDE_PROTOCOL) return 'claude'
  if (api === KIND_PROTOCOLS.gemini) return 'gemini'
  return classifyCialloModels(ids) === 'openai' ? 'openai' : 'mixed'
}

/**
 * The protocol a recognized group speaks, among those the adapter accepts.
 * @param kind - recognized group kind.
 * @param available - gateway protocols the schema accepts, in preference order.
 * @returns the kind's protocol, or the first available one when the schema lacks it.
 */
export function cialloKindProtocol(kind: CialloGroupKind, available: readonly string[]): string {
  const preferred = KIND_PROTOCOLS[kind]
  /* v8 ignore next -- every shipped pi-ai schema accepts all gateway protocols; the fallback keeps a narrowed schema usable */
  return available.includes(preferred) ? preferred : available[0] ?? preferred
}

/**
 * The model a new group proposes as the default: a Claude group's preferred model when listed, else the first.
 * @param kind - group kind.
 * @param ids - selected model ids in list order.
 * @returns the proposed default, or the empty string for an empty list.
 */
export function cialloPreferredModel(kind: CialloGroupKind, ids: readonly string[]): string {
  return kind === 'claude' && ids.includes(PREFERRED_CLAUDE_MODEL) ? PREFERRED_CLAUDE_MODEL : ids[0] ?? ''
}

/**
 * A group route's display name.
 * @param groupName - the user-facing group name.
 * @returns `CialloAPI · <group>`.
 */
export function cialloDisplayName(groupName: string): string {
  return `${CIALLO_API.displayName}${NAME_SEPARATOR}${groupName}`
}

/**
 * The group name a route's display name carries.
 * @param displayName - the route's display name.
 * @returns the part after `CialloAPI · `, or undefined when the name carries no group.
 */
export function cialloGroupName(displayName: string | undefined): string | undefined {
  const prefix = `${CIALLO_API.displayName}${NAME_SEPARATOR}`
  if (displayName?.startsWith(prefix) !== true) return undefined
  const name = displayName.slice(prefix.length).trim()
  return name.length > 0 ? name : undefined
}

/** Prompt-cache lifetime choices: the adapter's default five minutes, or one hour. */
export type CacheChoice = '5m' | '1h'

/** One group profile as the page reads it. */
export interface CialloProfile {
  /** Route display name. */
  displayName?: string
  /** Credential reference the route reads its key through. */
  apiKeyEnv?: string
  /** Route protocol. */
  api?: string
  /** Protocol base URL. */
  baseURL?: string
  /** Configured models. */
  models: DeepSeekModelDraft[]
  /** Prompt-cache lifetime. */
  cache: CacheChoice
  /** Stored Claude session-affinity choice, when the profile names one. */
  sessionAffinity?: boolean
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read a stored group profile.
 * @param value - the route's effective profile value.
 * @returns the fields the group card shows and edits.
 */
export function readCialloProfile(value: unknown): CialloProfile {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const displayName = text(record['displayName'])
  const apiKeyEnv = text(record['apiKeyEnv'])
  const api = text(record['api'])
  const baseURL = text(record['baseURL'])
  const sessionAffinity = record['sessionAffinity']
  return {
    ...displayName === undefined ? {} : { displayName },
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
    ...api === undefined ? {} : { api },
    ...baseURL === undefined ? {} : { baseURL },
    models: modelDrafts(record['models']),
    cache: record['cacheRetention'] === 'long' ? '1h' : '5m',
    ...typeof sessionAffinity === 'boolean' ? { sessionAffinity } : {},
  }
}

/**
 * Whether a group keeps a conversation on one upstream account: an explicit
 * choice, else on for a Claude group as the adapter defaults it.
 * @param profile - the stored group profile.
 * @returns the effective session-affinity state.
 */
export function cialloSessionAffinity(profile: Pick<CialloProfile, 'api' | 'sessionAffinity'>): boolean {
  return profile.sessionAffinity ?? profile.api === CLAUDE_PROTOCOL
}

/**
 * Read a model row's id.
 * @param model - stored model fields.
 * @returns the id, or the empty string when the row has none.
 */
export function modelId(model: DeepSeekModelDraft): string {
  return typeof model['id'] === 'string' ? model['id'] : ''
}

/** One model row of a group editor. */
export interface CialloModelRow {
  /** Stored model fields; fields the editor does not show survive. */
  model: DeepSeekModelDraft
  /** Whether the group serves this model. */
  checked: boolean
}

/** Disclosed fields a listing may add to a row the user already configured. */
const DISCLOSED_FIELDS = ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'defaultReasoningEffort'] as const

/**
 * Merge a listing into the editor rows. A configured row keeps every field it
 * has and gains only the disclosed fields it lacks; a newly listed model is
 * appended with the given checked state.
 * @param rows - current rows.
 * @param found - the listing, without duplicate ids.
 * @param checkNew - whether newly listed models start checked.
 * @returns the merged rows in configured-then-listed order.
 */
export function mergeCialloModels(
  rows: readonly CialloModelRow[], found: readonly LlmDiscoveredModel[], checkNew: boolean,
): CialloModelRow[] {
  const listed = new Map(found.map(candidate => [candidate.id, adoptCandidate(candidate)]))
  const merged = rows.map((row) => {
    const disclosed = listed.get(modelId(row.model))
    if (disclosed === undefined) return row
    const missing = DISCLOSED_FIELDS.filter(field => row.model[field] === undefined && disclosed[field] !== undefined)
    return missing.length === 0
      ? row
      : { ...row, model: { ...row.model, ...Object.fromEntries(missing.map(field => [field, disclosed[field]])) } }
  })
  const known = new Set(rows.map(row => modelId(row.model)))
  return [
    ...merged,
    ...[...listed.values()].filter(model => !known.has(modelId(model))).map(model => ({ model, checked: checkNew })),
  ]
}

/** The editable facts of one group, as its editor holds them. */
export interface CialloGroupDraft {
  /** Route id. */
  route: string
  /** User-facing group name. */
  groupName: string
  /** Route protocol. */
  api: string
  /** Protocol base URL. */
  baseURL: string
  /** Credential reference the profile names. */
  apiKeyEnv: string | undefined
  /** Selected models in list order. */
  models: readonly DeepSeekModelDraft[]
  /** Prompt-cache lifetime; written only for a Claude group. */
  cache: CacheChoice
  /** Session affinity; written only for a Claude group. */
  sessionAffinity: boolean
}

/**
 * Build a group profile over the stored user profile, keeping every field the editor does not own.
 * A Claude group writes `sessionAffinity` and stores the one-hour cache as `cacheRetention: long`,
 * removing the field for the five-minute default.
 * @param draft - the editor's facts.
 * @param previous - the stored user profile, or undefined for a new group.
 * @returns the profile to store at `providers.<route>`.
 */
export function cialloProfile(draft: CialloGroupDraft, previous: unknown): Record<string, JsonValue> {
  const base = typeof previous === 'object' && previous !== null && !Array.isArray(previous)
    ? { ...previous as Record<string, JsonValue> }
    : {}
  const profile: Record<string, JsonValue> = {
    ...base,
    displayName: cialloDisplayName(draft.groupName),
    ...draft.apiKeyEnv === undefined ? {} : { apiKeyEnv: draft.apiKeyEnv },
    api: draft.api,
    baseURL: draft.baseURL,
    models: draft.models.map(model => ({ ...model }) as JsonValue),
  }
  if (draft.api !== CLAUDE_PROTOCOL) return profile
  profile['sessionAffinity'] = draft.sessionAffinity
  if (draft.cache === '1h') profile['cacheRetention'] = 'long'
  else Reflect.deleteProperty(profile, 'cacheRetention')
  return profile
}
