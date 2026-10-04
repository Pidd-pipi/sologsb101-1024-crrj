import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { Table } from 'dexie'

/**
 * 多标签页编辑防覆盖：
 * 打开编辑窗口时记录该行的 updatedAt 快照，保存前重新读取数据库，
 * 若快照之后已被其他标签页抢先提交，则阻止本次写入并提示重新载入，
 * 避免过期页面覆盖先提交的版本。
 */
export function useEditGuard() {
  const editingUpdatedAt = ref<number | null>(null)

  /** 打开编辑窗口时捕获当前行的 updatedAt 快照 */
  function capture(updatedAt: number | null | undefined): void {
    editingUpdatedAt.value = typeof updatedAt === 'number' ? updatedAt : null
  }

  /** 新建记录时无历史版本可比，清空快照 */
  function reset(): void {
    editingUpdatedAt.value = null
  }

  /**
   * 保存前校验目标记录是否已被其他标签页修改。
   * 返回 true 表示可以写入；false 表示已过期，调用方应中止保存。
   */
  async function ensureFresh<T extends { id: string; updatedAt?: number }>(
    table: Table<T, string>,
    id: string
  ): Promise<boolean> {
    if (editingUpdatedAt.value === null) return true
    const current = await table.get(id)
    if (current && typeof current.updatedAt === 'number' && current.updatedAt !== editingUpdatedAt.value) {
      ElMessage.warning('该记录已在其他标签页被修改并先提交，为避免覆盖，请关闭编辑窗口并重新载入最新内容后再修改。')
      return false
    }
    return true
  }

  return { editingUpdatedAt, capture, reset, ensureFresh }
}
