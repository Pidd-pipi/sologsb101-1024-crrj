import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { liveQuery } from 'dexie'
import { db } from '@/utils/db'

export interface UseDataVersionOptions {
  /** 检测到其它标签页提交时是否弹窗提示重新载入，默认 true */
  prompt?: boolean
}

/**
 * 多标签页并发保护：订阅 app_meta 单例的 dataVersion。
 * 其它标签页发布阈值版本 / 覆盖导入 / 重置会推进修订号，
 * 本标签页随即提示「数据已更新，请重新载入」，避免过期页面覆盖先提交的版本。
 * 首次读到的值只作为基线，不触发提示。
 */
export function useDataVersion(options: UseDataVersionOptions = {}) {
  const { prompt = true } = options
  const dataVersion = ref(0)
  const stale = ref(false)
  let initialized = false
  let asking = false
  let subscription: { unsubscribe: () => void } | null = null

  async function reload(): Promise<void> {
    window.location.reload()
  }

  function onChange(next: number): void {
    if (!initialized) {
      dataVersion.value = next
      initialized = true
      return
    }
    if (next !== dataVersion.value) {
      dataVersion.value = next
      stale.value = true
      if (prompt && !asking) {
        asking = true
        void ElMessageBox.confirm(
          '其它标签页已经更新了数据（阈值版本、导入或重置），当前页面内容已过期。继续保存会覆盖先提交的版本，请重新载入。',
          '数据已在其它标签页更新',
          {
            type: 'warning',
            confirmButtonText: '重新载入',
            cancelButtonText: '稍后手动刷新',
            closeOnClickModal: false,
            closeOnPressEscape: false,
            showClose: false
          }
        )
          .then(() => {
            void reload()
          })
          .catch(() => {
            asking = false
          })
      }
    }
  }

  onMounted(() => {
    const observable = liveQuery(async () => (await db.appMeta.get('singleton'))?.dataVersion ?? 0)
    subscription = observable.subscribe({
      next: (value) => onChange(value),
      error: () => {
        /* 元数据订阅失败不阻断业务页面 */
      }
    })
  })

  onUnmounted(() => subscription?.unsubscribe())

  return { dataVersion, stale, reload }
}
