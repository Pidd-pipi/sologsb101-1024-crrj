/**
 * 温区阈值版本：每季度调整温湿度阈值时保存一份版本快照。
 * 环境记录按「记录时间 ≥ 版本生效日期」归属到对应版本，
 * 判定结论（异常标记）随版本封存，历史记录不会被新阈值重判。
 */
import type { TempZone } from '@/types/shelf'

/** 单个温区的温度区间（℃） */
export interface ThresholdRange {
  min: number
  max: number
}

/** 阈值版本快照：各温区温度区间 + 湿度区间 */
export interface ThresholdVersion {
  id: string
  /** 版本号，从 1 递增 */
  version: number
  /** 生效日期（YYYY-MM-DD）：记录时间 ≥ 该日期的记录按此版本判定 */
  effectiveAt: string
  /** 版本说明，如「2025 年第二季度阈值调整」 */
  note: string
  /** 各温区温度区间快照 */
  tempRanges: Record<TempZone, ThresholdRange>
  /** 湿度区间快照（%） */
  humidity: ThresholdRange
  createdAt: number
  updatedAt: number
}

/** 初始默认温度区间（℃）：冷区 4-8、中温区 9-13、常温区 14-18 */
export const DEFAULT_TEMP_RANGES: Record<TempZone, ThresholdRange> = {
  冷区: { min: 4, max: 8 },
  中温区: { min: 9, max: 13 },
  常温区: { min: 14, max: 18 }
}

/** 熟成库默认湿度区间（%）：低于下限需加湿，高于上限需除湿通风 */
export const DEFAULT_HUMIDITY_RANGE: ThresholdRange = { min: 80, max: 92 }

/** 初始阈值版本 id（旧数据升级补录时固定使用，便于环境记录回填） */
export const INITIAL_THRESHOLD_ID = 'threshold_v1'

function todayStr(): string {
  const date = new Date()
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 构造初始阈值版本（v1，生效日期早于所有业务记录） */
export function createInitialThresholdVersion(now = Date.now()): ThresholdVersion {
  return {
    id: INITIAL_THRESHOLD_ID,
    version: 1,
    effectiveAt: '2025-01-01',
    note: '初始阈值（系统升级补录）',
    tempRanges: {
      冷区: { ...DEFAULT_TEMP_RANGES.冷区 },
      中温区: { ...DEFAULT_TEMP_RANGES.中温区 },
      常温区: { ...DEFAULT_TEMP_RANGES.常温区 }
    },
    humidity: { ...DEFAULT_HUMIDITY_RANGE },
    createdAt: now,
    updatedAt: now
  }
}

/** 阈值版本表单状态 */
export interface ThresholdFormState {
  effectiveAt: string
  note: string
  tempRanges: Record<TempZone, ThresholdRange>
  humidity: ThresholdRange
}

/** 新建阈值版本表单：默认带出当前阈值，生效日期取今天 */
export function createEmptyThresholdForm(): ThresholdFormState {
  return {
    effectiveAt: todayStr(),
    note: '',
    tempRanges: {
      冷区: { ...DEFAULT_TEMP_RANGES.冷区 },
      中温区: { ...DEFAULT_TEMP_RANGES.中温区 },
      常温区: { ...DEFAULT_TEMP_RANGES.常温区 }
    },
    humidity: { ...DEFAULT_HUMIDITY_RANGE }
  }
}

/** 版本可读标签：vN · 生效日期 */
export function thresholdLabel(version: ThresholdVersion | null | undefined): string {
  if (!version) return '未分类版本'
  return `v${version.version} · ${version.effectiveAt}`
}
