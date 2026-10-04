/**
 * 应用级单例元数据：app_meta 表固定一行（id = 'singleton'）。
 * dataVersion 用于多标签页并发保护——任何会让其它标签页已打开表单过期的
 * 批量变更（发布阈值版本 / 覆盖导入 / 重置）都会把它加 1。
 */
export interface AppMeta {
  id: 'singleton'
  /** 数据修订号：跨标签页检测到变化即提示重新载入 */
  dataVersion: number
  updatedAt: number
}

export const APP_META_ID = 'singleton' as const
