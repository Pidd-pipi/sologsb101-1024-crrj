/**
 * 温区阈值版本：每季度调整温湿度阈值时另存一个新版本，而不是原地覆盖。
 * - 新登记的环境记录按当前生效版本（isActive = true）判定并记录阈值快照；
 * - 历史记录保留原判定结论与所引用的版本，版本变化后被标记为 stale（待重算），
 *   只有显式重算才会切换到新版本的结论。
 */
import type { TempZone } from '@/types/shelf'

/** 单温区温度上下限（℃） */
export interface TempZoneRange {
  min: number
  max: number
}

/** 一版完整的温湿度阈值：三个温区的温度区间 + 全库湿度区间 */
export interface ThresholdSettings {
  /** 各温区适宜温度区间（℃） */
  tempRanges: Record<TempZone, TempZoneRange>
  /** 全库适宜湿度区间（%） */
  humidity: { min: number; max: number }
}

export interface ThresholdVersion extends ThresholdSettings {
  id: string
  /** 人类可读的版本名，如「2025 Q1 初始阈值」 */
  label: string
  /** 生效时间（YYYY-MM-DD） */
  effectiveAt: string
  /** 是否为当前生效版本；同一时间至多一个版本生效 */
  isActive: boolean
  /** 调整备注，如「入夏前整体上调 1℃」 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 新建阈值版本的入参：id / 生效状态 / 时间戳由封装层补齐 */
export type NewThresholdVersionInput = Omit<ThresholdVersion, 'id' | 'isActive' | 'createdAt' | 'updatedAt'> & {
  isActive?: boolean
}

/** 深拷贝一版阈值设置，避免表单对象直接引用存储对象 */
export function cloneSettings(settings: ThresholdSettings): ThresholdSettings {
  return JSON.parse(JSON.stringify(settings)) as ThresholdSettings
}

/** 两版阈值的任一区间是否不同（用于发布前检测「无变化」与预演影响面） */
export function settingsChanged(a: ThresholdSettings, b: ThresholdSettings): boolean {
  const zones = Object.keys(a.tempRanges) as TempZone[]
  if (
    zones.some((zone) => a.tempRanges[zone].min !== b.tempRanges[zone].min) ||
    zones.some((zone) => a.tempRanges[zone].max !== b.tempRanges[zone].max)
  ) {
    return true
  }
  return a.humidity.min !== b.humidity.min || a.humidity.max !== b.humidity.max
}
