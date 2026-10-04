import { defineStore } from 'pinia'
import { computed } from 'vue'
import {
  db,
  createId,
  bumpDataVersion,
  getAppMeta,
  INITIAL_THRESHOLD_VERSION_ID
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  cloneSettings,
  settingsChanged,
  type NewThresholdVersionInput,
  type ThresholdSettings,
  type ThresholdVersion
} from '@/types/threshold'
import { judgeEnvironment } from '@/utils/temperature'
import type { Environment } from '@/types/environment'

/** 发布阈值版本的结果：changed = 新旧判定不一致、结论已失效待重算的记录数 */
export interface PublishThresholdResult {
  version: ThresholdVersion
  changed: number
}

/** 多标签页冲突：发布前 dataVersion 已被其它标签页推进时抛出 */
export class StaleDataVersionError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`数据已在其它标签页更新（修订号 ${expected} → ${actual}），请重新载入后再保存`)
    this.name = 'StaleDataVersionError'
  }
}

/**
 * 温区阈值版本 store：维护阈值版本历史、当前生效版本、失效记录与发布/重算动作。
 * - 发布新版本：旧版本失活，旧环境记录保留原 anomaly 结论，仅判定会反转的记录标 stale；
 * - 重算：按当前生效版本重判 stale 记录（或全部记录），重算后结论才会切换。
 */
export const useThresholdStore = defineStore('threshold', () => {
  const versionsTable = useIdbTable<ThresholdVersion>((database) => database.thresholdVersions, {
    sortByUpdatedAt: false
  })

  const versions = computed<ThresholdVersion[]>(() =>
    versionsTable.rows.value.slice().sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))
  )
  const loading = computed(() => versionsTable.loading.value)
  const ready = computed(() => versionsTable.ready.value)
  const error = computed(() => versionsTable.error.value)

  const activeVersion = computed<ThresholdVersion | null>(
    () => versions.value.find((version) => version.isActive) ?? null
  )

  const versionMap = computed<Record<string, ThresholdVersion>>(() => {
    const map: Record<string, ThresholdVersion> = {}
    versions.value.forEach((version) => {
      map[version.id] = version
    })
    return map
  })

  /** 生效版本的阈值设置；无版本数据时为 null（调用方自行兜底初始阈值） */
  const activeSettings = computed<ThresholdSettings | null>(() =>
    activeVersion.value ? cloneSettings(activeVersion.value) : null
  )

  function versionOf(id: string): ThresholdVersion | null {
    return versionMap.value[id] ?? null
  }

  /** 读取某条环境记录的判定阈值：记录引用版本缺失时返回 null（由调用方兜底） */
  function settingsOfRecord(record: Environment): ThresholdSettings | null {
    const version = versionMap.value[record.thresholdVersionId]
    return version ? cloneSettings(version) : null
  }

  /** 当前数据修订号：打开发布对话框时取一次，保存时比对，防止覆盖其它标签页的提交 */
  async function currentDataVersion(): Promise<number> {
    return (await getAppMeta()).dataVersion
  }

  /**
   * 发布新阈值版本：
   * 1. 校验与生效版本确有差异、修订号未被其它标签页推进；
   * 2. 旧生效版本失活，新版本生效；
   * 3. 全部环境记录按新版本预演：判定反转的保留原 anomaly 并标 stale，一致的直接迁移引用；
   * 4. dataVersion +1，通知其它标签页重新载入。
   */
  async function publishVersion(
    input: NewThresholdVersionInput,
    expectedDataVersion?: number
  ): Promise<PublishThresholdResult> {
    const now = Date.now()
    const result = await db.transaction(
      'rw',
      [db.thresholdVersions, db.environments, db.appMeta],
      async () => {
        if (expectedDataVersion !== undefined) {
          const meta = await getAppMeta()
          if (meta.dataVersion !== expectedDataVersion) {
            throw new StaleDataVersionError(expectedDataVersion, meta.dataVersion)
          }
        }
        const current = (await db.thresholdVersions.toArray()).find((version) => version.isActive) ?? null
        if (current) {
          if (!settingsChanged(current, input)) {
            throw new Error('新阈值与当前生效版本完全一致，无需发布新版本')
          }
        }
        const version: ThresholdVersion = {
          ...cloneSettings(input),
          id: createId('threshold'),
          label: input.label,
          effectiveAt: input.effectiveAt,
          note: input.note,
          isActive: true,
          createdAt: now,
          updatedAt: now
        }
        if (current) {
          await db.thresholdVersions.update(current.id, { isActive: false, updatedAt: now })
        }
        await db.thresholdVersions.put(version)

        let changed = 0
        const records = await db.environments.toArray()
        for (const record of records) {
          // 旧结论以记录实际引用的版本为准（可能还是更早的版本），缺失时才回落到当前生效版本
          const oldVersion =
            (await db.thresholdVersions.get(record.thresholdVersionId)) ?? current ?? version
          const oldVerdict = judgeEnvironment(
            record.tempC,
            record.humidityPct,
            record.zone,
            oldVersion
          )
          const newVerdict = judgeEnvironment(record.tempC, record.humidityPct, record.zone, version)
          if (oldVerdict.ok === newVerdict.ok) {
            // 结论不受影响：迁移到新版本引用，不改变异常结论
            if (record.thresholdVersionId !== version.id || record.stale) {
              await db.environments.update(record.id, {
                thresholdVersionId: version.id,
                stale: false,
                updatedAt: now
              })
            }
          } else {
            // 结论会反转：保留原 anomaly，标记失效待重算
            changed += 1
            await db.environments.update(record.id, { stale: true, updatedAt: now })
          }
        }

        await bumpDataVersion()
        return { version, changed }
      }
    )
    return result
  }

  /**
   * 重算失效记录：按当前生效版本重判并切换 anomaly 结论、迁移版本引用、清除失效标记。
   * onlyStale = false 时（一键重算全部）也会把人工标记与当前口径对齐。
   */
  async function recompute(onlyStale = true): Promise<{ updated: number; version: ThresholdVersion | null }> {
    const now = Date.now()
    return db.transaction('rw', [db.environments, db.thresholdVersions], async () => {
      const active = (await db.thresholdVersions.toArray()).find((version) => version.isActive) ?? null
      if (!active) {
        const fallback = await db.thresholdVersions.get(INITIAL_THRESHOLD_VERSION_ID)
        if (fallback) {
          await db.thresholdVersions.update(fallback.id, { isActive: true, updatedAt: now })
        }
        return { updated: 0, version: fallback ?? null }
      }
      const targets = (await db.environments.toArray()).filter(
        (record) => !onlyStale || record.stale
      )
      let updated = 0
      for (const record of targets) {
        const verdict = judgeEnvironment(record.tempC, record.humidityPct, record.zone, active)
        const anomaly = !verdict.ok
        const patch: Partial<Environment> = {}
        if (record.anomaly !== anomaly) {
          patch.anomaly = anomaly
          if (anomaly && !record.action) patch.action = verdict.suggestion
        }
        if (record.stale) patch.stale = false
        if (record.thresholdVersionId !== active.id) patch.thresholdVersionId = active.id
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = now
          await db.environments.update(record.id, patch)
          updated += 1
        }
      }
      return { updated, version: active }
    })
  }

  return {
    versions,
    activeVersion,
    activeSettings,
    versionMap,
    loading,
    ready,
    error,
    versionOf,
    settingsOfRecord,
    currentDataVersion,
    publishVersion,
    recompute
  }
})

export type ThresholdStore = ReturnType<typeof useThresholdStore>
