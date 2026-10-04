import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createInitialThresholdVersion,
  type ThresholdFormState,
  type ThresholdVersion
} from '@/types/threshold'
import type { TempZone } from '@/types/shelf'
import { judgeEnvironmentAt, toDateString } from '@/utils/temperature'

/**
 * 温区阈值版本 store：维护阈值版本列表、按记录时间解析所属版本，
 * 并在版本变化后重算受影响环境记录的异常结论。
 * 新记录按其记录时间所属版本判定；旧记录保留原异常结论。
 */
export const useThresholdStore = defineStore('threshold', () => {
  const thresholdsTable = useIdbTable<ThresholdVersion>((database) => database.thresholds, {
    sortByUpdatedAt: false
  })

  const versions = computed<ThresholdVersion[]>(() =>
    [...thresholdsTable.rows.value].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
  )
  const loading = computed(() => thresholdsTable.loading.value)
  const ready = computed(() => thresholdsTable.ready.value)
  const error = computed(() => thresholdsTable.error.value)

  /** 今天生效的版本（生效日期 ≤ 今天的最新版本） */
  const currentVersion = computed<ThresholdVersion>(() => versionAt(toDateString(new Date())))

  /** 按记录日期解析所属版本：生效日期 ≤ 该日期的最新版本，早于所有版本时取最早版本 */
  function versionAt(recordedAt: string): ThresholdVersion {
    const day = recordedAt.slice(0, 10)
    const eligible = versions.value.filter((version) => version.effectiveAt <= day)
    return (
      eligible[eligible.length - 1] ??
      versions.value[0] ??
      createInitialThresholdVersion(0)
    )
  }

  /** 按记录日期取判定区间覆写 */
  function rangesAt(recordedAt: string): {
    tempRanges: ThresholdVersion['tempRanges']
    humidity: ThresholdVersion['humidity']
  } {
    const version = versionAt(recordedAt)
    return { tempRanges: version.tempRanges, humidity: version.humidity }
  }

  /**
   * 按各记录所属阈值版本重算异常结论。
   * 版本变化后，thresholdVersionId 与「记录时间所属版本」不一致的记录结论失效，
   * 需按正确版本重新判定并回写；版本未覆盖的旧记录保留原结论。
   * 返回被重算的记录条数。
   */
  async function recalcAll(): Promise<number> {
    const [records, versionsList, batches, shelves] = await Promise.all([
      db.environments.toArray(),
      db.thresholds.toArray(),
      db.batches.toArray(),
      db.shelves.toArray()
    ])
    const sorted = [...versionsList].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
    const resolve = (day: string): ThresholdVersion => {
      const eligible = sorted.filter((version) => version.effectiveAt <= day)
      return eligible[eligible.length - 1] ?? sorted[0] ?? createInitialThresholdVersion(0)
    }
    const zoneOf = (batchId: string): TempZone => {
      const batch = batches.find((item) => item.id === batchId)
      if (!batch?.shelfId) return '中温区'
      return shelves.find((shelf) => shelf.id === batch.shelfId)?.tempZone ?? '中温区'
    }

    let changed = 0
    const now = Date.now()
    await db.transaction('rw', db.environments, async () => {
      for (const record of records) {
        const version = resolve(record.recordedAt.slice(0, 10))
        const zone = zoneOf(record.batchId)
        const verdict = judgeEnvironmentAt(
          record.tempC,
          record.humidityPct,
          zone,
          version.tempRanges[zone],
          version.humidity
        )
        const anomaly = !verdict.ok
        if (record.thresholdVersionId !== version.id || record.anomaly !== anomaly) {
          await db.environments.update(record.id, {
            thresholdVersionId: version.id,
            anomaly,
            action: record.action || (anomaly ? verdict.suggestion : ''),
            updatedAt: now
          })
          changed += 1
        }
      }
    })
    return changed
  }

  /** 新建阈值版本：版本号递增，生效日期不可重复；保存后重算受影响记录结论 */
  async function createVersion(
    input: ThresholdFormState
  ): Promise<{ version: ThresholdVersion; recalculated: number }> {
    const list = await thresholdsTable.list()
    if (list.some((version) => version.effectiveAt === input.effectiveAt)) {
      throw new Error(`生效日期 ${input.effectiveAt} 已存在阈值版本，请调整生效日期`)
    }
    const maxVersion = list.reduce((max, version) => Math.max(max, version.version), 0)
    const now = Date.now()
    const record: ThresholdVersion = {
      id: createId('thr'),
      version: maxVersion + 1,
      effectiveAt: input.effectiveAt,
      note: input.note.trim() || `v${maxVersion + 1} 阈值调整`,
      tempRanges: input.tempRanges,
      humidity: input.humidity,
      createdAt: now,
      updatedAt: now
    }
    await thresholdsTable.upsert(record)
    const recalculated = await recalcAll()
    return { version: record, recalculated }
  }

  return {
    versions,
    currentVersion,
    loading,
    ready,
    error,
    versionAt,
    rangesAt,
    createVersion,
    recalcAll
  }
})

export type ThresholdStore = ReturnType<typeof useThresholdStore>
