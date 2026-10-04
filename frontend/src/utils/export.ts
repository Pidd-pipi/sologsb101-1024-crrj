import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  bumpDataVersion,
  ensureInitialThresholdVersion,
  INITIAL_THRESHOLD_VERSION_ID,
  type BackupPayload,
  type BatchArchive
} from '@/utils/db'
import type { Environment } from '@/types/environment'
import type { ThresholdVersion } from '@/types/threshold'
import { INITIAL_THRESHOLD_SETTINGS } from '@/utils/temperature'

/** 导入 / 校验结果：校验失败时 errors 非空、payload 为 null */
export interface ParseResult {
  ok: boolean
  errors: string[]
  payload: BackupPayload | null
}

const COLLECTIONS: Array<keyof Pick<BackupPayload, 'milks' | 'batches' | 'shelves' | 'turnings' | 'environments' | 'tastings'>> = [
  'milks',
  'batches',
  'shelves',
  'turnings',
  'environments',
  'tastings'
]

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input)
}

/** 校验并规整一条阈值版本，非法时返回 null */
function normalizeThresholdVersion(input: unknown, now: number): ThresholdVersion | null {
  if (!isPlainObject(input) || typeof input.id !== 'string') return null
  const tempRanges = isPlainObject(input.tempRanges) ? input.tempRanges : {}
  const humidity = isPlainObject(input.humidity) ? input.humidity : {}
  const zones = ['冷区', '中温区', '常温区'] as const
  const ranges = {} as ThresholdVersion['tempRanges']
  let valid = true
  zones.forEach((zone) => {
    const range = tempRanges[zone]
    if (!isPlainObject(range) || !isFiniteNumber(range.min) || !isFiniteNumber(range.max)) {
      valid = false
      return
    }
    ranges[zone] = { min: range.min, max: range.max }
  })
  if (!valid) return null
  if (!isFiniteNumber(humidity.min) || !isFiniteNumber(humidity.max)) return null
  return {
    id: input.id,
    label: typeof input.label === 'string' && input.label.trim() ? input.label : '导入的阈值版本',
    effectiveAt: typeof input.effectiveAt === 'string' ? input.effectiveAt.slice(0, 10) : '2025-01-01',
    isActive: input.isActive === true,
    note: typeof input.note === 'string' ? input.note : '',
    tempRanges: ranges,
    humidity: { min: humidity.min, max: humidity.max },
    createdAt: isFiniteNumber(input.createdAt) ? input.createdAt : now,
    updatedAt: isFiniteNumber(input.updatedAt) ? input.updatedAt : now
  }
}

/**
 * 校验批次熟成档案 JSON 的必备字段，返回错误信息数组（为空表示通过）。
 * 同时剔除非法条目，保证导入的数据结构完整。
 */
export function validatePayload(input: unknown): ParseResult {
  const errors: string[] = []
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  if (input.app !== 'gbcheeseage') {
    errors.push('app 字段应为 gbcheeseage，文件来源不明')
  }
  COLLECTIONS.forEach((key) => {
    if (!Array.isArray(input[key])) errors.push(`${key} 字段缺失或不是数组`)
  })
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const obj = input as Partial<BackupPayload>
  const now = Date.now()
  // 阈值版本：老备份可能没有该字段，校验阶段先补一份初始版本，写入前还会与本地合并
  const rawVersions = Array.isArray(obj.thresholdVersions) ? obj.thresholdVersions : []
  const thresholdVersions = rawVersions
    .map((item) => normalizeThresholdVersion(item, now))
    .filter((item): item is ThresholdVersion => item !== null)
  if (thresholdVersions.length === 0) {
    thresholdVersions.push({
      ...INITIAL_THRESHOLD_SETTINGS,
      id: INITIAL_THRESHOLD_VERSION_ID,
      label: '初始温湿度阈值',
      effectiveAt: '2025-01-01',
      isActive: true,
      note: '旧版备份导入时补建的初始阈值版本',
      createdAt: now,
      updatedAt: now
    })
  }
  const payload: BackupPayload = {
    app: 'gbcheeseage',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    milks: (obj.milks ?? []).filter((item) => typeof item?.id === 'string'),
    batches: (obj.batches ?? []).filter((item) => typeof item?.id === 'string'),
    shelves: (obj.shelves ?? []).filter((item) => typeof item?.id === 'string'),
    turnings: (obj.turnings ?? []).filter((item) => typeof item?.id === 'string'),
    environments: (obj.environments ?? []).filter((item) => typeof item?.id === 'string'),
    tastings: (obj.tastings ?? []).filter((item) => typeof item?.id === 'string'),
    thresholdVersions
  }
  if (payload.batches.length === 0 && payload.milks.length === 0) {
    errors.push('文件中没有任何奶源或批次记录')
    return { ok: false, errors, payload: null }
  }
  // 引用完整性校验：批次的奶源、转架/环境/品评的批次必须能在文件内找到
  const milkIds = new Set(payload.milks.map((item) => item.id))
  const batchIds = new Set(payload.batches.map((item) => item.id))
  payload.batches.forEach((batch) => {
    if (!milkIds.has(batch.milkId)) {
      errors.push(`批次 ${batch.id} 引用了不存在的奶源 ${batch.milkId}`)
    }
  })
  payload.turnings.forEach((turning) => {
    if (!batchIds.has(turning.batchId)) {
      errors.push(`转架作业 ${turning.id} 引用了不存在的批次 ${turning.batchId}`)
    }
  })
  payload.environments.forEach((record) => {
    if (!batchIds.has(record.batchId)) {
      errors.push(`环境记录 ${record.id} 引用了不存在的批次 ${record.batchId}`)
    }
  })
  payload.tastings.forEach((tasting) => {
    if (!batchIds.has(tasting.batchId)) {
      errors.push(`品评记录 ${tasting.id} 引用了不存在的批次 ${tasting.batchId}`)
    }
  })
  if (errors.length > 0) return { ok: false, errors, payload: null }
  return { ok: true, errors, payload }
}

/** 从文本解析并校验 JSON */
export function parseSnapshotJson(text: string): ParseResult {
  try {
    const parsed: unknown = JSON.parse(text)
    return validatePayload(parsed)
  } catch {
    return { ok: false, errors: ['JSON 解析失败，请确认文件未损坏'], payload: null }
  }
}

/** 读取用户选择的文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
}

/** 导出全量档案 JSON */
export async function exportSnapshotJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const [milks, batches, shelves, turnings, environments, tastings, thresholdVersions] = await Promise.all([
    db.milks.toArray(),
    db.batches.toArray(),
    db.shelves.toArray(),
    db.turnings.toArray(),
    db.environments.toArray(),
    db.tastings.toArray(),
    db.thresholdVersions.toArray()
  ])
  const payload: BackupPayload = {
    app: 'gbcheeseage',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    milks,
    batches,
    shelves,
    turnings,
    environments,
    tastings,
    thresholdVersions
  }
  const fileName = `gbcheeseage-archive-v${DB_VERSION}-${stamp()}.json`
  downloadJson(fileName, payload)
  return {
    fileName,
    counts: {
      milks: milks.length,
      batches: batches.length,
      shelves: shelves.length,
      turnings: turnings.length,
      environments: environments.length,
      tastings: tastings.length,
      thresholdVersions: thresholdVersions.length
    }
  }
}

/** 导出单个批次的熟成档案（含奶源、窖位、转架、环境与品评） */
export async function exportBatchArchiveJson(
  batchId: string
): Promise<{ fileName: string; counts: Record<string, number> }> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在，无法导出')
  const [milks, shelves, turnings, environments, tastings, thresholdVersions] = await Promise.all([
    db.milks.toArray(),
    db.shelves.toArray(),
    db.turnings.where('batchId').equals(batchId).toArray(),
    db.environments.where('batchId').equals(batchId).toArray(),
    db.tastings.where('batchId').equals(batchId).toArray(),
    db.thresholdVersions.toArray()
  ])
  // 只带回环境记录实际引用到的阈值版本，保证旧结论可按原口径还原
  const referencedVersionIds = new Set(environments.map((record) => record.thresholdVersionId))
  const batchVersions = thresholdVersions.filter((version) => referencedVersionIds.has(version.id))
  const archive: BatchArchive = {
    app: 'gbcheeseage',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    scope: 'batch',
    batchId,
    milks: milks.filter((milk) => milk.id === batch.milkId),
    batches: [batch],
    shelves: shelves.filter((shelf) => shelf.id === batch.shelfId),
    turnings,
    environments,
    tastings,
    thresholdVersions: batchVersions
  }
  const fileName = `gbcheeseage-batch-${batchId}-${stamp()}.json`
  downloadJson(fileName, archive)
  return {
    fileName,
    counts: {
      milks: archive.milks.length,
      batches: 1,
      shelves: archive.shelves.length,
      turnings: turnings.length,
      environments: environments.length,
      tastings: tastings.length,
      thresholdVersions: batchVersions.length
    }
  }
}

/**
 * 导入后合并阈值版本与环境记录引用：
 * - 覆盖模式：以导入文件为准，保证恰有一个生效版本，环境记录引用落到文件内版本（兜底初始版本）；
 * - 追加模式：保留本地生效版本，导入版本作为历史参照（全部置为非生效），
 *   环境记录引用优先用本地已有版本，其次文件内版本，最后落到本地生效 / 初始版本。
 */
async function reconcileThresholds(payload: BackupPayload, overwrite: boolean): Promise<void> {
  await ensureInitialThresholdVersion()
  const localVersions = await db.thresholdVersions.toArray()
  const localActive = localVersions.find((version) => version.isActive) ?? localVersions[0] ?? null
  const now = Date.now()

  if (overwrite) {
    // 以导入文件为准：先全部置为非生效，再挑出文件里标记生效的版本（缺失则取第一条）
    const versions = payload.thresholdVersions.map((version) => ({ ...version, isActive: false }))
    const activeById = new Set(
      payload.thresholdVersions.filter((version) => version.isActive).map((version) => version.id)
    )
    const active = versions.find((version) => activeById.has(version.id)) ?? versions[0]
    if (active) active.isActive = true
    await db.thresholdVersions.bulkPut(versions)
    const versionIds = new Set(versions.map((version) => version.id))
    await db.environments.toCollection().modify((record) => {
      if (!record.thresholdVersionId || !versionIds.has(record.thresholdVersionId)) {
        record.thresholdVersionId = active?.id ?? INITIAL_THRESHOLD_VERSION_ID
      }
    })
    return
  }

  // 追加模式：导入版本作为历史参照，同 id 不覆盖本地，全部置为非生效
  const localIds = new Set(localVersions.map((version) => version.id))
  const imported = payload.thresholdVersions
    .filter((version) => !localIds.has(version.id))
    .map((version) => ({ ...version, isActive: false, updatedAt: now }))
  if (imported.length > 0) await db.thresholdVersions.bulkPut(imported)
  const importedIds = new Set(imported.map((version) => version.id))
  await db.environments.toCollection().modify((record) => {
    if (localIds.has(record.thresholdVersionId)) return
    if (importedIds.has(record.thresholdVersionId)) return
    record.thresholdVersionId = localActive?.id ?? INITIAL_THRESHOLD_VERSION_ID
  })
}

/** 导入档案：overwrite 为 true 时先清空全部表，否则按 id 合并覆盖 */
export async function importSnapshotJson(
  payload: BackupPayload,
  overwrite = false
): Promise<Record<string, number>> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.milks, db.batches, db.shelves, db.turnings, db.environments, db.tastings, db.thresholdVersions],
    async () => {
      await db.thresholdVersions.bulkPut(payload.thresholdVersions)
      await db.milks.bulkPut(payload.milks)
      await db.batches.bulkPut(payload.batches)
      await db.shelves.bulkPut(payload.shelves)
      await db.turnings.bulkPut(payload.turnings)
      await db.environments.bulkPut(payload.environments)
      await db.tastings.bulkPut(payload.tastings)
    }
  )
  await reconcileThresholds(payload, overwrite)
  if (overwrite) await bumpDataVersion()
  return {
    milks: payload.milks.length,
    batches: payload.batches.length,
    shelves: payload.shelves.length,
    turnings: payload.turnings.length,
    environments: payload.environments.length,
    tastings: payload.tastings.length,
    thresholdVersions: payload.thresholdVersions.length
  }
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapPayloadIds(payload: BackupPayload): BackupPayload {
  const milkIdMap = new Map<string, string>()
  const batchIdMap = new Map<string, string>()
  const shelfIdMap = new Map<string, string>()

  const milks = payload.milks.map((milk) => {
    const id = createId('milk')
    milkIdMap.set(milk.id, id)
    return { ...milk, id }
  })
  const shelves = payload.shelves.map((shelf) => {
    const id = createId('shelf')
    shelfIdMap.set(shelf.id, id)
    return { ...shelf, id }
  })
  const batches = payload.batches.map((batch) => {
    const id = createId('batch')
    batchIdMap.set(batch.id, id)
    return {
      ...batch,
      id,
      milkId: milkIdMap.get(batch.milkId) ?? batch.milkId,
      shelfId: batch.shelfId ? shelfIdMap.get(batch.shelfId) ?? null : null
    }
  })
  const turnings = payload.turnings.map((turning) => ({
    ...turning,
    id: createId('turn'),
    batchId: batchIdMap.get(turning.batchId) ?? turning.batchId,
    shelfId: shelfIdMap.get(turning.shelfId) ?? turning.shelfId
  }))
  const environments: Environment[] = payload.environments.map((record) => ({
    ...record,
    id: createId('env'),
    batchId: batchIdMap.get(record.batchId) ?? record.batchId
  }))
  const tastings = payload.tastings.map((tasting) => ({
    ...tasting,
    id: createId('tast'),
    batchId: batchIdMap.get(tasting.batchId) ?? tasting.batchId
  }))
  // 阈值版本 id 保持不变：作为历史判定口径被环境记录引用，导入后由 reconcileThresholds 与本地合并
  const thresholdVersions = payload.thresholdVersions.map((version) => ({ ...version, isActive: false }))

  return { ...payload, milks, batches, shelves, turnings, environments, tastings, thresholdVersions }
}
