/**
 * Read-only inspection and non-destructive, idempotent import from a legacy
 * DeepSeek Harness home (`~/.dsh`) into the active Ciallo App home.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/legacy-dsh.ts
 */

import { constants as fsConstants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import {
  LEGACY_DSH_HOME_DISPLAY,
  defaultLegacyDshHome,
  dshHomeDisplay,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  checkpointRecord,
  projectionCacheDomainSpec,
  type CheckpointIdentity,
  type CheckpointRecord,
} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { parseDocument } from 'yaml'
import type {
  LegacyDshImportOptions,
  LegacyDshImportResult,
  LegacyDshSummary,
} from './types.ts'

const SESSION_LOG_FILE = /^session\.v\d+\.jsonl(?:\.zstd)?$/u
const SAFE_CACHE_KEY_RE = /^[a-zA-Z0-9_-]+$/
const ACCEPTED_PROJCACHE_VERSIONS = new Set<number>([
  projectionCacheDomainSpec.version,
  ...projectionCacheDomainSpec.compatibleVersions,
])
const MAX_PROJECTION_WARM_SESSIONS = 200
const PROJECTION_WARM_YIELD_INTERVAL = 16

/** Dependencies injected by {@link SettingsController} or unit tests. */
export interface LegacyDshContext {
  readonly ctx: Context
  readonly legacyHome?: (() => string) | undefined
  readonly targetHome?: (() => string) | undefined
}

interface LegacySessionLocation {
  readonly projectSlug: string
  readonly sessionDir: string
  readonly sourceDir: string
  readonly targetDir: string
  readonly logFiles: readonly string[]
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // Missing or inaccessible directories simply report false.
    return false
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // Missing or inaccessible files simply report false.
    return false
  }
}

function isSkippedEntryName(name: string): boolean {
  return name.endsWith('.lock') || name.includes('.tmp')
}

async function listSubdirectories(dir: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Absent or unreadable directories yield no children.
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === '.' || entry.name === '..') continue
    if (entry.isDirectory()) results.push(entry.name)
  }
  return results
}

async function listSessionLogFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Absent or unreadable session directories yield no logs.
    return []
  }
  return entries
    .filter(entry => !entry.isSymbolicLink() && entry.isFile() && SESSION_LOG_FILE.test(entry.name))
    .map(entry => entry.name)
}

async function scanLegacySessions(
  legacyRoot: string,
  targetRoot: string,
  signal?: AbortSignal,
): Promise<LegacySessionLocation[]> {
  const legacySessionsRoot = join(legacyRoot, 'sessions')
  const targetSessionsRoot = join(targetRoot, 'sessions')
  const projectSlugs = await listSubdirectories(legacySessionsRoot, signal)
  const found: LegacySessionLocation[] = []
  for (const projectSlug of projectSlugs) {
    const legacyProjectDir = join(legacySessionsRoot, projectSlug)
    const sessionDirs = await listSubdirectories(legacyProjectDir, signal)
    for (const sessionDir of sessionDirs) {
      const sourceDir = join(legacyProjectDir, sessionDir)
      const logFiles = await listSessionLogFiles(sourceDir, signal)
      if (logFiles.length === 0) continue
      found.push({
        projectSlug,
        sessionDir,
        sourceDir,
        targetDir: join(targetSessionsRoot, projectSlug, sessionDir),
        logFiles,
      })
    }
  }
  return found
}

async function hasAnyRegularFile(root: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // Absent directories have no files.
    return false
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || isSkippedEntryName(entry.name)) continue
    if (entry.isFile()) return true
    if (entry.isDirectory()) {
      if (await hasAnyRegularFile(join(root, entry.name), signal)) return true
    }
  }
  return false
}

async function copyMissingFile(source: string, destination: string): Promise<boolean> {
  try {
    const info = await lstat(source)
    if (info.isSymbolicLink() || !info.isFile()) return false
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw error
  }
}

async function copyMissingTree(
  sourceRoot: string,
  targetRoot: string,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true })
  } catch {
    // Missing source trees copy zero files.
    return 0
  }
  let copied = 0
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.isSymbolicLink() || isSkippedEntryName(entry.name)) continue
    const sourcePath = join(sourceRoot, entry.name)
    const targetPath = join(targetRoot, entry.name)
    if (entry.isDirectory()) {
      copied += await copyMissingTree(sourcePath, targetPath, signal)
    } else if (entry.isFile()) {
      if (await copyMissingFile(sourcePath, targetPath)) copied++
    }
  }
  return copied
}

/**
 * Parse addressable API-key reference pairs from `<legacyRoot>/.credentials.yaml`.
 * OAuth `records` and foreign keys are ignored, and secret values never leave the Host.
 */
async function readLegacyCredentialRefs(legacyRoot: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>()
  const filename = join(legacyRoot, '.credentials.yaml')
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch {
    // Missing or unreadable legacy credentials file contributes zero references.
    return refs
  }
  try {
    const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
    if (document.errors.length > 0) return refs
    const root: unknown = document.toJS() ?? {}
    if (typeof root !== 'object' || root === null || Array.isArray(root)) return refs
    const fields = root as Record<string, unknown>
    const rawRefs: unknown = 'version' in fields ? fields['refs'] : fields
    if (typeof rawRefs !== 'object' || rawRefs === null || Array.isArray(rawRefs)) return refs
    for (const [key, value] of Object.entries(rawRefs as Record<string, unknown>)) {
      if (key === 'version' || !isCredentialRefName(key)) continue
      if (typeof value === 'string' && value.length > 0) {
        refs.set(key, value)
      }
    }
  } catch {
    // Malformed legacy YAML is skipped cleanly without surfacing file contents.
    return new Map()
  }
  return refs
}

function readObjectProperty(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

interface LegacyModelSettings {
  readonly piAiProviders: ReadonlyMap<string, Record<string, unknown>>
  readonly deepseek?: Record<string, unknown> | undefined
  readonly deepseekApiKey?: Record<string, unknown> | undefined
  readonly defaultModel?: Record<string, unknown> | undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsJsTag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsJsTag)
  if (!isPlainObject(value)) return false
  if (Object.hasOwn(value, '__jsExpr')) return true
  return Object.values(value).some(containsJsTag)
}

interface LegacyAffinityInfo {
  readonly enabled: boolean
  readonly port: number | undefined
  readonly upstream: string
}

function matchesAffinityRelay(value: unknown, expectedPort: number | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:') return false
    const isLoopback = parsed.hostname === '127.0.0.1'
      || parsed.hostname === 'localhost'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]'
    if (!isLoopback) return false
    if (expectedPort !== undefined) {
      return Number(parsed.port.length > 0 ? parsed.port : '80') === expectedPort
    }
    return true
  } catch {
    // Non-URL strings cannot match local session-affinity proxy endpoints.
    return false
  }
}

function hasNonEmptyString(value: unknown, key: string): boolean {
  if (!isPlainObject(value)) return false
  const prop = readObjectProperty(value, key)
  return typeof prop === 'string' && prop.trim().length > 0
}

function hasConfiguredDeepSeek(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (hasNonEmptyString(value, 'apiKey')) return true
  const providers = readObjectProperty(value, 'providers')
  return isPlainObject(providers) && Object.keys(providers).length > 0
}

function hasConfiguredDefaultModel(value: unknown): boolean {
  return hasNonEmptyString(value, 'provider') || hasNonEmptyString(value, 'model')
}

function collectSchemaDictKeys(schema: unknown, keys: Set<string>): void {
  if (!isPlainObject(schema)) return
  const properties = readObjectProperty(schema, 'properties')
  if (isPlainObject(properties)) {
    for (const key of Object.keys(properties)) keys.add(key)
  }
  for (const combiner of ['allOf', 'anyOf', 'oneOf']) {
    const variants = readObjectProperty(schema, combiner)
    if (!Array.isArray(variants)) continue
    for (const variant of variants) collectSchemaDictKeys(variant, keys)
  }
}

function schemaDictKeys(schema: unknown): ReadonlySet<string> {
  const keys = new Set<string>()
  collectSchemaDictKeys(schema, keys)
  return keys
}

function filterRecordBySchemaKeys(
  source: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (allowedKeys.size === 0) return { ...source }
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowedKeys.has(key)) filtered[key] = value
  }
  return filtered
}

function flattenPatchRows(rows: readonly unknown[]): Array<Record<string, unknown>> {
  const flattened: Array<Record<string, unknown>> = []
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    flattened.push(row)
    const inserted = readObjectProperty(row, 'insert')
    if (Array.isArray(inserted)) flattened.push(...flattenPatchRows(inserted))
    if (readObjectProperty(row, 'group') === true) {
      const nested = readObjectProperty(row, 'config')
      if (Array.isArray(nested)) flattened.push(...flattenPatchRows(nested))
    }
  }
  return flattened
}

function parseLegacyPatchRows(rawText: string): Array<Record<string, unknown>> {
  const document = parseDocument(rawText, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  })
  if (document.errors.length > 0) return []
  const parsed: unknown = document.toJS()
  return Array.isArray(parsed) ? flattenPatchRows(parsed) : []
}

function isAffinityPackageName(name: string): boolean {
  return name === '@local/dsh-ciallo-affinity'
    || name === 'dsh-ciallo-affinity'
    || name.endsWith('/dsh-ciallo-affinity')
}

function isAffinityEntry(row: Record<string, unknown>): boolean {
  const id = readObjectProperty(row, 'id')
  const name = readObjectProperty(row, 'name')
  return id === 'ciallo-affinity'
    || id === 'dsh-ciallo-affinity'
    || (typeof name === 'string' && isAffinityPackageName(name))
}

function applyAffinityConfig(
  current: LegacyAffinityInfo,
  rows: readonly Record<string, unknown>[],
): LegacyAffinityInfo {
  let { enabled, port, upstream } = current
  for (const row of rows) {
    if (!isAffinityEntry(row)) continue
    enabled = true
    port ??= 18765
    const cfg = readObjectProperty(row, 'config')
    if (!isPlainObject(cfg) || containsJsTag(cfg)) continue
    const cfgPort = readObjectProperty(cfg, 'port')
    if (typeof cfgPort === 'number' && Number.isInteger(cfgPort) && cfgPort >= 1 && cfgPort <= 65535) {
      port = cfgPort
    }
    const rawUpstream = readObjectProperty(cfg, 'upstream')
    if (typeof rawUpstream === 'string' && rawUpstream.trim().length > 0) {
      const trimmed = rawUpstream.trim().replace(/\/+$/, '')
      if (trimmed.length > 0) upstream = trimmed
    }
  }
  return { enabled, port, upstream }
}

async function readProfileAffinityInfo(
  profileDir: string | undefined,
  patchRows: readonly Record<string, unknown>[],
  signal?: AbortSignal,
): Promise<LegacyAffinityInfo> {
  let info: LegacyAffinityInfo = {
    enabled: false,
    port: undefined,
    upstream: 'https://cialloapi.com',
  }

  if (profileDir !== undefined) {
    signal?.throwIfAborted()
    try {
      const pkgParsed: unknown = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      if (isPlainObject(pkgParsed)) {
        const candidates: string[] = []
        const deps = readObjectProperty(pkgParsed, 'dependencies')
        if (isPlainObject(deps)) candidates.push(...Object.keys(deps))
        const dsh = readObjectProperty(pkgParsed, 'dsh')
        const profileMeta = isPlainObject(dsh) ? readObjectProperty(dsh, 'profile') : undefined
        const bundles = isPlainObject(profileMeta) ? readObjectProperty(profileMeta, 'bundles') : undefined
        if (Array.isArray(bundles)) {
          for (const bundle of bundles) {
            if (typeof bundle === 'string') candidates.push(bundle)
          }
        }
        const matchedPackages = [...new Set(candidates.filter(isAffinityPackageName))]
        if (matchedPackages.length > 0) {
          info = { ...info, enabled: true, port: 18765 }
          for (const pkgName of matchedPackages) {
            signal?.throwIfAborted()
            try {
              const bundlePatch = await readFile(join(profileDir, 'node_modules', ...pkgName.split('/'), 'cordis.patch.yml'), 'utf8')
              info = applyAffinityConfig(info, parseLegacyPatchRows(bundlePatch))
            } catch {
              // Missing installed bundle patch simply keeps default relay port 18765 and https://cialloapi.com.
            }
          }
        }
      }
    } catch {
      // Missing or invalid profile package.json falls back to checking cordis.patch.yml directly.
    }
  }

  return applyAffinityConfig(info, patchRows)
}

function upgradeAffinityRoute(
  route: Record<string, unknown>,
  affinity: LegacyAffinityInfo,
): Record<string, unknown> {
  if (!affinity.enabled) return route
  if (readObjectProperty(route, 'api') !== 'anthropic-messages') return route
  const rawBaseUrl = readObjectProperty(route, 'baseURL') ?? readObjectProperty(route, 'baseUrl')
  if (!matchesAffinityRelay(rawBaseUrl, affinity.port)) return route
  const { baseUrl: _legacyBaseUrl, ...rest } = route
  return {
    ...rest,
    baseURL: affinity.upstream,
    sessionAffinity: true,
  }
}

async function readActiveProfileName(legacyRoot: string): Promise<string | undefined> {
  try {
    const raw = (await readFile(join(legacyRoot, 'profile'), 'utf8')).trim()
    if (raw.length > 0 && !raw.includes('/') && !raw.includes('\\')) return raw
  } catch {
    // No explicit legacy profile pointer file is present; fall back to standard profile order.
  }
  return undefined
}

async function readLegacyModelSettings(legacyRoot: string, signal?: AbortSignal): Promise<LegacyModelSettings> {
  signal?.throwIfAborted()
  const profileDirs = await listSubdirectories(join(legacyRoot, 'profiles'), signal)
  const profileSet = new Set(profileDirs)
  const orderedProfiles: string[] = []
  const activeProfile = await readActiveProfileName(legacyRoot)
  for (const preferred of [activeProfile, 'desktop', 'web', 'default']) {
    if (preferred !== undefined && profileSet.has(preferred) && !orderedProfiles.includes(preferred)) {
      orderedProfiles.push(preferred)
    }
  }
  for (const remaining of [...profileDirs].sort()) {
    if (!orderedProfiles.includes(remaining)) orderedProfiles.push(remaining)
  }

  const candidateFiles: Array<{ readonly profileDir: string | undefined; readonly patchPath: string }> = [
    ...orderedProfiles.map((profile) => {
      const profileDir = join(legacyRoot, 'profiles', profile)
      return { profileDir, patchPath: join(profileDir, 'cordis.patch.yml') }
    }),
    { profileDir: undefined, patchPath: join(legacyRoot, 'cordis.patch.yml') },
  ]

  const piAiProviders = new Map<string, Record<string, unknown>>()
  let deepseek: Record<string, unknown> | undefined
  let deepseekApiKey: Record<string, unknown> | undefined
  let defaultModel: Record<string, unknown> | undefined

  for (const candidate of candidateFiles) {
    signal?.throwIfAborted()
    let rawText: string
    try {
      rawText = await readFile(candidate.patchPath, 'utf8')
    } catch {
      // Absent or unreadable legacy profile patch files are skipped cleanly.
      continue
    }
    const rows = parseLegacyPatchRows(rawText)
    if (rows.length === 0) continue

    const affinity = await readProfileAffinityInfo(candidate.profileDir, rows, signal)

    for (const row of rows) {
      const id = readObjectProperty(row, 'id')
      const cfg = readObjectProperty(row, 'config')
      if (typeof id !== 'string' || !isPlainObject(cfg)) continue

      if (id === 'llm-pi-ai') {
        const providers = readObjectProperty(cfg, 'providers')
        if (!isPlainObject(providers)) continue
        for (const [routeId, rawRoute] of Object.entries(providers)) {
          if (routeId.length === 0 || !isPlainObject(rawRoute) || containsJsTag(rawRoute)) continue
          if (piAiProviders.has(routeId)) continue
          piAiProviders.set(routeId, upgradeAffinityRoute(rawRoute, affinity))
        }
        continue
      }

      if (containsJsTag(cfg)) continue
      if (id === 'llm-deepseek' && deepseek === undefined && hasConfiguredDeepSeek(cfg)) {
        deepseek = cfg
      } else if (id === 'llm-deepseek-api-key' && deepseekApiKey === undefined && hasConfiguredDeepSeek(cfg)) {
        deepseekApiKey = cfg
      } else if (id === 'agent-default-model' && defaultModel === undefined && hasConfiguredDefaultModel(cfg)) {
        defaultModel = cfg
      }
    }
  }

  return {
    piAiProviders,
    deepseek,
    deepseekApiKey,
    defaultModel,
  }
}

function readExistingPiAiProviders(
  descriptor: { readonly value: unknown } | undefined,
): Record<string, unknown> | undefined {
  if (descriptor === undefined || !isPlainObject(descriptor.value)) return undefined
  const providers = readObjectProperty(descriptor.value, 'providers')
  return isPlainObject(providers) ? providers : undefined
}

function collectSettingsDescriptors(
  settings: NonNullable<Context['settings']>,
): Map<string, ReturnType<typeof settings.describe>[number]> {
  const descriptors = new Map<string, ReturnType<typeof settings.describe>[number]>()
  for (const descriptor of settings.describe()) {
    descriptors.set(descriptor.ns, descriptor)
  }
  return descriptors
}

function countLegacyProviders(
  legacyModels: LegacyModelSettings,
  settings: Context['settings'] | undefined,
): { readonly providerCount: number; readonly newProviderCount: number } {
  const providerCount = legacyModels.piAiProviders.size
    + (legacyModels.deepseek === undefined ? 0 : 1)
    + (legacyModels.deepseekApiKey === undefined ? 0 : 1)
  if (providerCount === 0 || settings === undefined) {
    return { providerCount, newProviderCount: providerCount }
  }

  const descriptors = collectSettingsDescriptors(settings)
  const existingProviders = readExistingPiAiProviders(descriptors.get('llm-pi-ai'))
  let newProviderCount = 0
  for (const routeId of legacyModels.piAiProviders.keys()) {
    if (existingProviders === undefined || !Object.hasOwn(existingProviders, routeId)) newProviderCount++
  }
  if (legacyModels.deepseek !== undefined && !hasConfiguredDeepSeek(descriptors.get('llm-deepseek')?.value)) {
    newProviderCount++
  }
  if (legacyModels.deepseekApiKey !== undefined && !hasConfiguredDeepSeek(descriptors.get('llm-deepseek-api-key')?.value)) {
    newProviderCount++
  }
  return { providerCount, newProviderCount }
}

/** Read legacy workspace `path -> title` hints from `storages/workspace.json` when available. */
async function readLegacyWorkspaceTitles(legacyRoot: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const filename = join(legacyRoot, 'storages', 'workspace.json')
  try {
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return titles
    const tables = readObjectProperty(parsed, 'tables')
    if (typeof tables !== 'object' || tables === null) return titles
    const workspaces = readObjectProperty(tables, 'workspaces')
    if (typeof workspaces !== 'object' || workspaces === null) return titles
    for (const entry of Object.values(workspaces as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue
      const path = readObjectProperty(entry, 'path')
      const title = readObjectProperty(entry, 'title')
      if (typeof path === 'string' && path.length > 0 && typeof title === 'string' && title.trim().length > 0) {
        titles.set(path, title)
      }
    }
  } catch {
    // Missing or malformed workspace metadata simply falls back to directory basenames.
    return titles
  }
  return titles
}

async function loadLegacyWholeUnitProjcache(legacyRoot: string): Promise<ReadonlyMap<string, unknown>> {
  const map = new Map<string, unknown>()
  try {
    const parsed: unknown = JSON.parse(await readFile(join(legacyRoot, 'storages', 'session_projcache.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return map
    const unit = readObjectProperty(parsed, 'unit')
    if (typeof unit !== 'object' || unit === null) return map
    if (readObjectProperty(unit, 'name') !== projectionCacheDomainSpec.name) return map
    const version = readObjectProperty(unit, 'version')
    if (typeof version !== 'number' || !ACCEPTED_PROJCACHE_VERSIONS.has(version)) return map
    const tables = readObjectProperty(parsed, 'tables')
    if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) return map
    const sessions = readObjectProperty(tables, 'sessions')
    if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return map
    for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
      map.set(key, value)
    }
  } catch {
    // Absent or unreadable whole-unit legacy cache falls back to cold log folding.
    return map
  }
  return map
}

async function readLegacyProjcacheRecord(
  legacyRoot: string,
  sessionId: string,
  getWholeUnit: () => Promise<ReadonlyMap<string, unknown>>,
): Promise<CheckpointRecord | undefined> {
  if (SAFE_CACHE_KEY_RE.test(sessionId)) {
    const recordPath = join(legacyRoot, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    try {
      const parsed: unknown = JSON.parse(await readFile(recordPath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const version = readObjectProperty(parsed, 'version')
        const rawRecord = readObjectProperty(parsed, 'record')
        if (typeof version === 'number' && ACCEPTED_PROJCACHE_VERSIONS.has(version)) {
          const validated = checkpointRecord.safeParse(rawRecord)
          if (validated.success) return validated.data
        }
      }
    } catch {
      // Absent, unreadable, or foreign per-record cache falls back to whole-unit or cold fold.
    }
  }
  const wholeUnit = await getWholeUnit()
  const fallbackRaw = wholeUnit.get(sessionId)
  if (fallbackRaw === undefined) return undefined
  const validated = checkpointRecord.safeParse(fallbackRaw)
  return validated.success ? validated.data : undefined
}

function legacyCheckpointMatchesHeader(stored: CheckpointIdentity, header: SessionHeader): boolean {
  const versionOk = stored.formatVersion === undefined || stored.formatVersion <= header.version
  return versionOk
    && stored.createdAt === header.createdAt
    && stored.cwd === header.cwd
    && (stored.isSeeded ?? false) === header.isSeeded
}

async function readRoots(context: LegacyDshContext): Promise<{
  readonly legacyRoot: string
  readonly targetRoot: string
  readonly distinct: boolean
}> {
  const legacyRoot = (context.legacyHome ?? defaultLegacyDshHome)()
  const targetRoot = (context.targetHome ?? resolveDshHome)()
  const distinct = !sameResolvedPath(legacyRoot, targetRoot) && await isDirectory(legacyRoot)
  return { legacyRoot, targetRoot, distinct }
}

/**
 * Inspect whether a distinct legacy DeepSeek Harness home (`~/.dsh`) has data
 * eligible for one-click migration into the active home (`~/.ciallo`).
 * @param context - Host context and optional path overrides for testing.
 * @param signal - Caller cancellation signal.
 * @returns redacted counts and availability flags.
 */
export async function inspectLegacyDsh(
  context: LegacyDshContext,
  signal?: AbortSignal,
): Promise<LegacyDshSummary> {
  signal?.throwIfAborted()
  const { legacyRoot, targetRoot, distinct } = await readRoots(context)
  const targetDisplay = dshHomeDisplay(targetRoot)
  if (!distinct) {
    return {
      available: false,
      sourceDisplay: LEGACY_DSH_HOME_DISPLAY,
      targetDisplay,
      sessionCount: 0,
      newSessionCount: 0,
      hasAttachments: false,
      hasSkills: false,
      hasAgentsMd: false,
      credentialCount: 0,
      providerCount: 0,
      newProviderCount: 0,
    }
  }

  const sessions = await scanLegacySessions(legacyRoot, targetRoot, signal)
  let newSessionCount = 0
  for (const session of sessions) {
    const existingLogs = await listSessionLogFiles(session.targetDir, signal)
    if (existingLogs.length === 0) newSessionCount++
  }
  if (sessions.length > 0 && newSessionCount === 0) {
    const persistence = context.ctx.get('sessionPersistence')
    const projectionCache = context.ctx.get('sessionProjectionCache')
    if (persistence !== undefined && projectionCache !== undefined) {
      const persisted = await persistence.list(signal === undefined ? {} : { signal })
      let uncachedColdCount = 0
      for (const record of persisted) {
        signal?.throwIfAborted()
        if (record.header.origin === 'subagent' || record.header.cwd === undefined) continue
        if (
          projectionCache.cachedSnapshot(record.header) === undefined
          && projectionCache.cachedPredecessorTitle(record.header) === undefined
        ) {
          uncachedColdCount++
        }
      }
      newSessionCount = Math.min(sessions.length, uncachedColdCount)
    }
  }

  const [hasAttachments, hasSkills, hasAgentsMd, refs, legacyModels] = await Promise.all([
    hasAnyRegularFile(join(legacyRoot, 'attachments'), signal),
    hasAnyRegularFile(join(legacyRoot, 'skills'), signal),
    isRegularFile(join(legacyRoot, 'AGENTS.md')),
    readLegacyCredentialRefs(legacyRoot),
    readLegacyModelSettings(legacyRoot, signal),
  ])

  const credentialCount = refs.size
  const { providerCount, newProviderCount } = countLegacyProviders(legacyModels, context.ctx.get('settings'))
  const available = sessions.length > 0
    || hasAttachments
    || hasSkills
    || hasAgentsMd
    || credentialCount > 0
    || providerCount > 0

  return {
    available,
    sourceDisplay: LEGACY_DSH_HOME_DISPLAY,
    targetDisplay,
    sessionCount: sessions.length,
    newSessionCount,
    hasAttachments,
    hasSkills,
    hasAgentsMd,
    credentialCount,
    providerCount,
    newProviderCount,
  }
}

/**
 * Copy sessions, projection cache hints, attachments, skills, `AGENTS.md`,
 * stored API key references (optional), and legacy model provider configs from
 * `~/.dsh` into `~/.ciallo` without overwriting existing target data or
 * mutating the legacy directory.
 * @param context - Host context and optional path overrides for testing.
 * @param options - Migration options.
 * @param signal - Caller cancellation signal.
 * @returns summary counts of newly imported vs skipped artifacts.
 */
export async function importLegacyDsh(
  context: LegacyDshContext,
  options: LegacyDshImportOptions = {},
  signal?: AbortSignal,
): Promise<LegacyDshImportResult> {
  signal?.throwIfAborted()
  const emptyResult: LegacyDshImportResult = {
    importedSessions: 0,
    skippedSessions: 0,
    attachedWorkspaces: 0,
    importedAttachments: 0,
    importedSkills: 0,
    importedAgentsMd: false,
    importedCredentials: 0,
    importedProviders: 0,
  }

  const { legacyRoot, targetRoot, distinct } = await readRoots(context)
  if (!distinct) return emptyResult

  const sessions = await scanLegacySessions(legacyRoot, targetRoot, signal)
  let importedSessions = 0
  let skippedSessions = 0
  for (const session of sessions) {
    signal?.throwIfAborted()
    const existingLogs = await listSessionLogFiles(session.targetDir, signal)
    if (existingLogs.length > 0) {
      skippedSessions++
      continue
    }
    let copiedAny = false
    for (const file of session.logFiles) {
      if (await copyMissingFile(join(session.sourceDir, file), join(session.targetDir, file))) {
        copiedAny = true
      }
    }
    if (copiedAny) {
      importedSessions++
    } else {
      skippedSessions++
    }
  }

  const importedAttachments = await copyMissingTree(
    join(legacyRoot, 'attachments'),
    join(targetRoot, 'attachments'),
    signal,
  )
  const importedSkills = await copyMissingTree(
    join(legacyRoot, 'skills'),
    join(targetRoot, 'skills'),
    signal,
  )
  const importedAgentsMd = await copyMissingFile(
    join(legacyRoot, 'AGENTS.md'),
    join(targetRoot, 'AGENTS.md'),
  )

  let importedCredentials = 0
  if (options.includeCredentials !== false) {
    const credentials = context.ctx.get('credentials')
    if (credentials !== undefined) {
      const refs = await readLegacyCredentialRefs(legacyRoot)
      for (const [rawRef, secretValue] of refs) {
        signal?.throwIfAborted()
        try {
          const ref = credentialRef(rawRef)
          const info = await credentials.describe(ref)
          if (info.configured || !info.writable) continue
          await credentials.set(ref, secretValue)
          importedCredentials++
        } catch (error) {
          context.ctx.get('logger')?.warn('legacy-dsh: failed to import credential reference %s: %s', rawRef, String(error))
        }
      }
    }
  }

  let importedProviders = 0
  const settings = context.ctx.get('settings')
  if (settings !== undefined && settings.writable) {
    const legacyModels = await readLegacyModelSettings(legacyRoot, signal)
    if (
      legacyModels.piAiProviders.size > 0
      || legacyModels.deepseek !== undefined
      || legacyModels.deepseekApiKey !== undefined
      || legacyModels.defaultModel !== undefined
    ) {
      const descriptors = collectSettingsDescriptors(settings)

      const piAiDesc = descriptors.get('llm-pi-ai')
      if (piAiDesc !== undefined && legacyModels.piAiProviders.size > 0) {
        const existingProviders = readExistingPiAiProviders(piAiDesc)
        const missingProviders: Array<readonly [string, Record<string, unknown>]> = []
        for (const [routeId, routeConfig] of legacyModels.piAiProviders) {
          if (existingProviders === undefined || !Object.hasOwn(existingProviders, routeId)) {
            missingProviders.push([routeId, routeConfig])
          }
        }
        if (missingProviders.length > 0) {
          try {
            await settings.mutate(
              'llm-pi-ai',
              missingProviders.map(([routeId, routeConfig]) => ({
                op: 'set',
                path: ['providers', routeId],
                value: routeConfig,
              })),
              piAiDesc.revision,
            )
            importedProviders += missingProviders.length
          } catch (batchError) {
            context.ctx.get('logger')?.warn(
              'legacy-dsh: batched provider migration failed (%s); retrying per route',
              String(batchError),
            )
            for (const [routeId, routeConfig] of missingProviders) {
              signal?.throwIfAborted()
              try {
                await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', routeId], value: routeConfig }])
                importedProviders++
              } catch (routeError) {
                context.ctx.get('logger')?.warn(
                  'legacy-dsh: failed to import provider route %s: %s',
                  routeId,
                  String(routeError),
                )
              }
            }
          }
        }
      }

      const deepseekCandidates: Array<readonly [string, Record<string, unknown> | undefined]> = [
        ['llm-deepseek', legacyModels.deepseek],
        ['llm-deepseek-api-key', legacyModels.deepseekApiKey],
      ]
      for (const [ns, candidate] of deepseekCandidates) {
        if (candidate === undefined) continue
        signal?.throwIfAborted()
        const desc = descriptors.get(ns)
        if (desc === undefined || hasConfiguredDeepSeek(desc.value)) continue
        const patch = filterRecordBySchemaKeys(candidate, schemaDictKeys(desc.schema))
        if (Object.keys(patch).length === 0) continue
        try {
          await settings.update(ns, patch, desc.revision)
          importedProviders++
        } catch (error) {
          context.ctx.get('logger')?.warn('legacy-dsh: failed to import %s settings: %s', ns, String(error))
        }
      }

      if (legacyModels.defaultModel !== undefined) {
        signal?.throwIfAborted()
        const defaultDesc = descriptors.get('agent-default-model')
        if (
          defaultDesc !== undefined
          && !hasConfiguredDefaultModel(defaultDesc.value)
          && !hasConfiguredDefaultModel(defaultDesc.user)
        ) {
          const patch = filterRecordBySchemaKeys(legacyModels.defaultModel, schemaDictKeys(defaultDesc.schema))
          if (Object.keys(patch).length > 0) {
            try {
              await settings.update('agent-default-model', patch, defaultDesc.revision)
            } catch (error) {
              context.ctx.get('logger')?.warn('legacy-dsh: failed to import agent-default-model: %s', String(error))
            }
          }
        }
      }
    }
  }

  let attachedWorkspaces = 0
  const persistence = context.ctx.get('sessionPersistence')
  const workspaceRegistry = context.ctx.get('workspaceRegistry')
  if (persistence !== undefined) {
    const records = [...await persistence.list(signal === undefined ? {} : { signal })]
    if (workspaceRegistry !== undefined) {
      const legacyTitles = await readLegacyWorkspaceTitles(legacyRoot)
      records.sort((left, right) => left.header.createdAt - right.header.createdAt)
      const touchedWorkspaces = new Set<string>()
      const directoryExistsCache = new Map<string, boolean>()

      for (const record of records) {
        signal?.throwIfAborted()
        const cwd = record.header.cwd
        if (record.header.origin === 'subagent' || typeof cwd !== 'string' || cwd.length === 0) continue
        let exists = directoryExistsCache.get(cwd)
        if (exists === undefined) {
          exists = await isDirectory(cwd)
          directoryExistsCache.set(cwd, exists)
        }
        if (!exists) continue
        try {
          const workspace = await workspaceRegistry.create(cwd, legacyTitles.get(cwd))
          const alreadyAttached = workspace.sessionIds.includes(record.header.id)
          if (!alreadyAttached) {
            await workspace.attachSession(record.header.id)
            if (!touchedWorkspaces.has(workspace.id)) {
              touchedWorkspaces.add(workspace.id)
              attachedWorkspaces++
            }
          }
        } catch (error) {
          context.ctx.get('logger')?.warn(
            'legacy-dsh: failed to attach session %s to workspace %s: %s',
            record.header.id,
            cwd,
            String(error),
          )
        }
      }
    }

    const projectionCache = context.ctx.get('sessionProjectionCache')
    if (projectionCache !== undefined) {
      const cacheTable = context.ctx.get('storageDomain')
        ?.get(projectionCacheDomainSpec.name)
        ?.table('sessions')
      let wholeUnitPromise: Promise<ReadonlyMap<string, unknown>> | undefined
      const getWholeUnit = (): Promise<ReadonlyMap<string, unknown>> => {
        wholeUnitPromise ??= loadLegacyWholeUnitProjcache(legacyRoot)
        return wholeUnitPromise
      }
      const byNewest = [...records].sort((left, right) => right.header.createdAt - left.header.createdAt)
      let warmed = 0
      for (const record of byNewest) {
        signal?.throwIfAborted()
        if (record.header.origin === 'subagent' || record.header.cwd === undefined) continue
        if (
          projectionCache.cachedSnapshot(record.header) !== undefined
          || projectionCache.cachedPredecessorTitle(record.header) !== undefined
        ) {
          continue
        }

        if (cacheTable !== undefined && SAFE_CACHE_KEY_RE.test(record.header.id)) {
          const legacyRecord = await readLegacyProjcacheRecord(legacyRoot, record.header.id, getWholeUnit)
          if (legacyRecord !== undefined && legacyCheckpointMatchesHeader(legacyRecord.identity, record.header)) {
            try {
              await cacheTable.put(record.header.id, legacyRecord)
            } catch (error) {
              context.ctx.get('logger')?.warn(
                'legacy-dsh: failed to seed projection cache for session %s: %s',
                record.header.id,
                String(error),
              )
            }
            if (
              projectionCache.cachedSnapshot(record.header) !== undefined
              || projectionCache.cachedPredecessorTitle(record.header) !== undefined
            ) {
              continue
            }
          }
        }

        if (
          record.formatStatus === 'migration-required'
          || warmed >= MAX_PROJECTION_WARM_SESSIONS
          || typeof persistence.open !== 'function'
        ) {
          continue
        }
        try {
          const openOptions = signal === undefined ? undefined : { signal }
          const handle = await persistence.open(record.header.id, 'read', openOptions)
          let read
          try {
            read = await handle.read(0, undefined, openOptions)
          } finally {
            await handle.close()
          }
          projectionCache.coldSnapshot(handle.header, handle.inheritedEventCount, read.events)
          warmed++
          if (warmed % PROJECTION_WARM_YIELD_INTERVAL === 0) await scheduler.yield()
        } catch (error) {
          context.ctx.get('logger')?.warn(
            'legacy-dsh: cold projection warm-up failed for session %s: %s',
            record.header.id,
            String(error),
          )
        }
      }
      if (warmed > 0 && cacheTable !== undefined) {
        try {
          await cacheTable.delete('__legacy_dsh_drain_barrier__')
        } catch (error) {
          context.ctx.get('logger')?.warn(
            'legacy-dsh: projection cache drain barrier failed: %s',
            String(error),
          )
        }
      }
    }
  }

  return {
    importedSessions,
    skippedSessions,
    attachedWorkspaces,
    importedAttachments,
    importedSkills,
    importedAgentsMd,
    importedCredentials,
    importedProviders,
  }
}
