import type { TempZone } from '@/types/shelf'
import type { EnvSeriesPoint, Environment } from '@/types/environment'
import type { ThresholdSettings, ThresholdVersion } from '@/types/threshold'

/** 初始（v1）阈值：老数据升级与空库播种时补的初始阈值版本都取这一组 */
export const INITIAL_THRESHOLD_SETTINGS: ThresholdSettings = {
  tempRanges: {
    冷区: { min: 4, max: 8 },
    中温区: { min: 9, max: 13 },
    常温区: { min: 14, max: 18 }
  },
  humidity: { min: 80, max: 92 }
}

/** 各温区的适宜温度区间（℃）——无版本数据时的兜底常量，业务判定优先用阈值版本 */
export const TEMP_RANGE = INITIAL_THRESHOLD_SETTINGS.tempRanges

/** 熟成库适宜湿度区间（%）：低于下限需加湿，高于上限需除湿通风 */
export const HUMIDITY_RANGE = INITIAL_THRESHOLD_SETTINGS.humidity

/** 温区代表色，用于卡片与曲线 */
export const ZONE_COLOR: Record<TempZone, string> = {
  冷区: '#3d7ea6',
  中温区: '#d68910',
  常温区: '#c0392b'
}

/** 判定结果：是否越界 + 人类可读的原因 */
export interface RangeVerdict {
  ok: boolean
  /** 温度越界说明 */
  tempIssue: string
  /** 湿度越界说明 */
  humidityIssue: string
  /** 汇总说明，正常时为空串 */
  message: string
  /** 建议措施 */
  suggestion: string
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 单值区间判定文案 */
function judge(
  value: number,
  min: number,
  max: number,
  unit: string,
  lowLabel: string,
  highLabel: string
): string {
  if (value < min) return `${lowLabel}（${value}${unit} < ${min}${unit}）`
  if (value > max) return `${highLabel}（${value}${unit} > ${max}${unit}）`
  return ''
}

/**
 * 阈值判定：温度按 `settings` 中 `zone` 的温度阈值、湿度按 `settings` 的湿度阈值，
 * 任一越界即 ok = false，并给出开窗 / 加湿等调整建议。
 */
export function judgeEnvironment(
  tempC: number,
  humidityPct: number,
  zone: TempZone,
  settings: ThresholdSettings = INITIAL_THRESHOLD_SETTINGS
): RangeVerdict {
  const range = settings.tempRanges[zone]
  const tempIssue = judge(tempC, range.min, range.max, '℃', `${zone}温度偏低`, `${zone}温度偏高`)
  const humidityIssue = judge(
    humidityPct,
    settings.humidity.min,
    settings.humidity.max,
    '%',
    '湿度过低',
    '湿度过高'
  )

  const reasons: string[] = []
  const suggestions: string[] = []
  if (tempIssue) {
    reasons.push(tempIssue)
    suggestions.push(tempC > range.max ? '开窗通风降温或开启制冷' : '关闭新风并开启保温')
  }
  if (humidityIssue) {
    reasons.push(humidityIssue)
    suggestions.push(humidityPct < settings.humidity.min ? '开启加湿器并覆盖湿布' : '开窗排湿或开启除湿机')
  }

  return {
    ok: reasons.length === 0,
    tempIssue,
    humidityIssue,
    message: reasons.join('；'),
    suggestion: suggestions.join('；')
  }
}

/** 按指定阈值版本判定；版本缺失时回落到初始阈值 */
export function judgeByVersion(
  tempC: number,
  humidityPct: number,
  zone: TempZone,
  version: ThresholdVersion | null | undefined
): RangeVerdict {
  return judgeEnvironment(tempC, humidityPct, zone, version ?? INITIAL_THRESHOLD_SETTINGS)
}

/** 越界自动标异常：任一温湿度越界即为异常 */
export function isAnomaly(
  tempC: number,
  humidityPct: number,
  zone: TempZone,
  settings?: ThresholdSettings
): boolean {
  return !judgeEnvironment(tempC, humidityPct, zone, settings).ok
}

/** 异常记录的默认调整措施文案，写入表单初值 */
export function suggestAction(
  tempC: number,
  humidityPct: number,
  zone: TempZone,
  settings?: ThresholdSettings
): string {
  const verdict = judgeEnvironment(tempC, humidityPct, zone, settings)
  if (verdict.ok) return ''
  return verdict.suggestion
}

/** 温湿度越界标记换算：按调用方给出的阈值解析器批量判定一组记录 */
export function markAnomalies(
  records: Environment[],
  resolve: (record: Environment) => { zone: TempZone; settings: ThresholdSettings }
): number {
  let changed = 0
  records.forEach((record) => {
    const { zone, settings } = resolve(record)
    const expected = isAnomaly(record.tempC, record.humidityPct, zone, settings)
    if (record.anomaly !== expected) changed += 1
  })
  return changed
}

/** 均值：空数组返回 0 */
export function average(values: number[]): number {
  if (values.length === 0) return 0
  const sum = values.reduce((acc, value) => acc + value, 0)
  return round(sum / values.length, 1)
}

export function avgTemp(records: Environment[]): number {
  return average(records.map((record) => record.tempC))
}

export function avgHumidity(records: Environment[]): number {
  return average(records.map((record) => record.humidityPct))
}

/** 越界记录占比百分比 0-100 */
export function anomalyPercent(records: Environment[]): number {
  if (records.length === 0) return 0
  const count = records.filter((record) => record.anomaly).length
  return Math.round((count / records.length) * 100)
}

/**
 * 把环境记录换算成曲线采样点：
 * 温度/湿度各自按当前数据集的最小最大值归一化到 0-100 的百分比坐标。
 */
export function toSeriesPoints(records: Environment[]): EnvSeriesPoint[] {
  if (records.length === 0) return []
  const sorted = [...records].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  const temps = sorted.map((record) => record.tempC)
  const humidities = sorted.map((record) => record.humidityPct)
  const tempMin = Math.min(...temps)
  const tempMax = Math.max(...temps)
  const humMin = Math.min(...humidities)
  const humMax = Math.max(...humidities)

  const ratio = (value: number, min: number, max: number): number => {
    if (max - min < 0.001) return 50
    return round(((value - min) / (max - min)) * 100, 2)
  }

  return sorted.map((record) => ({
    id: record.id,
    label: record.recordedAt.slice(5).replace('T', ' '),
    tempC: record.tempC,
    humidityPct: record.humidityPct,
    anomaly: record.anomaly,
    tempRatio: ratio(record.tempC, tempMin, tempMax),
    humidityRatio: ratio(record.humidityPct, humMin, humMax)
  }))
}

/** 把 0-100 的归一化比例换算为 SVG viewBox（高 100）内的 y 坐标 */
export function ratioToY(ratio: number, height = 100): number {
  return round(height - (Math.min(100, Math.max(0, ratio)) / 100) * height, 2)
}

/** 曲线折线 points 字符串 */
export function toPolyline(points: EnvSeriesPoint[], key: 'tempRatio' | 'humidityRatio', width: number): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    const y = ratioToY(points[0][key])
    return `0,${y} ${width},${y}`
  }
  const step = width / (points.length - 1)
  return points.map((point, index) => `${round(index * step, 2)},${ratioToY(point[key])}`).join(' ')
}

/** 时间戳/日期串 → YYYY-MM-DD */
export function toDateString(input: Date | number | string): string {
  if (typeof input === 'string') return input.slice(0, 10)
  const date = new Date(input)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** YYYY-MM-DD → 本地当天零点的 Date */
export function parseDateString(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map((item) => Number(item))
  if (!year || !month || !day) return new Date(Number.NaN)
  return new Date(year, month - 1, day)
}

/** 日期串加天数，返回 YYYY-MM-DD */
export function addDays(value: string, days: number): string {
  const date = parseDateString(value)
  if (Number.isNaN(date.getTime())) return value
  date.setDate(date.getDate() + days)
  return toDateString(date)
}

/** 两个日期串之间的整天数（to - from） */
export function diffDays(from: string, to: string): number {
  const start = parseDateString(from)
  const end = parseDateString(to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  return Math.round((end.getTime() - start.getTime()) / 86400000)
}
