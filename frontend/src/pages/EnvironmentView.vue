<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { DataLine, Delete, Edit, Plus, SetUp } from '@element-plus/icons-vue'
import { liveQuery } from 'dexie'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, {
  type FilterModel,
  type FilterSelectConfig
} from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useThresholdStore, StaleDataVersionError } from '@/stores/thresholdStore'
import { db, createId } from '@/utils/db'
import {
  INITIAL_THRESHOLD_SETTINGS,
  ZONE_COLOR,
  anomalyPercent,
  avgHumidity,
  avgTemp,
  judgeByVersion,
  judgeEnvironment,
  toPolyline,
  toSeriesPoints
} from '@/utils/temperature'
import {
  cloneSettings,
  settingsChanged,
  type ThresholdSettings
} from '@/types/threshold'
import type { Environment, EnvironmentFilterState } from '@/types/environment'
import type { TempZone } from '@/types/shelf'
import { TEMP_ZONES } from '@/types/shelf'

const milkStore = useMilkStore()
const shelfStore = useShelfStore()
const thresholdStore = useThresholdStore()
const { batches } = storeToRefs(milkStore)
const { shelves } = storeToRefs(shelfStore)
const { versions, activeVersion } = storeToRefs(thresholdStore)

const records = ref<Environment[]>([])
const loading = ref(true)
const ready = ref(false)
const error = ref<string | null>(null)
const filter = ref<EnvironmentFilterState>({ keyword: '', anomalies: [], batchIds: [] })
const onlyAnomaly = ref(false)
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const subscription = ref<{ unsubscribe: () => void } | null>(null)

const form = reactive({
  batchId: '',
  recordedAt: '',
  tempC: 12,
  humidityPct: 85,
  action: ''
})

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  recordedAt: [{ required: true, message: '请选择记录时间', trigger: 'change' }],
  tempC: [{ required: true, message: '请填写温度', trigger: 'blur' }],
  humidityPct: [{ required: true, message: '请填写湿度', trigger: 'blur' }]
}

function nowLocal(): string {
  const date = new Date()
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function subscribe(): void {
  const observable = liveQuery(async () =>
    (await db.environments.toArray()).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  )
  subscription.value = observable.subscribe({
    next: (list: Environment[]) => {
      records.value = list
      ready.value = true
      loading.value = false
      error.value = null
    },
    error: (err: unknown) => {
      error.value = err instanceof Error ? err.message : '读取环境记录失败'
      loading.value = false
    }
  })
}

onMounted(subscribe)
onUnmounted(() => subscription.value?.unsubscribe())

/** batchId → 所在窖位的温区；未上架批次按中温区默认判定 */
function zoneOf(batchId: string): TempZone {
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch?.shelfId) return '中温区'
  return shelves.value.find((shelf) => shelf.id === batch.shelfId)?.tempZone ?? '中温区'
}

/** 当前生效阈值；尚无版本数据时回落到内置初始阈值 */
const activeSettings = computed<ThresholdSettings>(
  () => thresholdStore.activeSettings ?? INITIAL_THRESHOLD_SETTINGS
)

/** 记录的判定口径：按记录自带的温区快照与其引用的阈值版本，保留历史结论语境 */
function verdictOfRecord(record: Environment) {
  return judgeByVersion(
    record.tempC,
    record.humidityPct,
    record.zone,
    thresholdStore.versionOf(record.thresholdVersionId)
  )
}

function versionLabelOf(versionId: string): string {
  return thresholdStore.versionOf(versionId)?.label ?? '未知版本'
}

function batchLabelOf(batchId: string): string {
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return '批次已删除'
  return `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}`
}

const batchOptions = computed(() =>
  batches.value.map((batch) => ({ label: batchLabelOf(batch.id), value: batch.id }))
)

const filteredRecords = computed(() =>
  records.value.filter((record) => {
    const keyword = filter.value.keyword.trim()
    if (keyword.length > 0) {
      const haystack = `${record.recordedAt}${record.action}${batchLabelOf(record.batchId)}`
      if (!haystack.includes(keyword)) return false
    }
    if (filter.value.batchIds.length > 0 && !filter.value.batchIds.includes(record.batchId)) {
      return false
    }
    if (filter.value.anomalies.length > 0) {
      const label = record.anomaly ? '异常' : '正常'
      if (!filter.value.anomalies.includes(label)) return false
    }
    if (onlyAnomaly.value && !record.anomaly) return false
    return true
  })
)

const summary = computed(() => ({
  total: filteredRecords.value.length,
  anomalyCount: filteredRecords.value.filter((record) => record.anomaly).length,
  staleCount: records.value.filter((record) => record.stale).length,
  avgTempC: avgTemp(filteredRecords.value),
  avgHumidityPct: avgHumidity(filteredRecords.value),
  anomalyPercent: anomalyPercent(filteredRecords.value)
}))

const anomalyRecords = computed(() => filteredRecords.value.filter((record) => record.anomaly))
const staleRecords = computed(() => records.value.filter((record) => record.stale))

/** 曲线数据：按记录时间升序换算成 SVG 坐标 */
const seriesPoints = computed(() => toSeriesPoints(filteredRecords.value))
const CHART_WIDTH = 720
const tempPolyline = computed(() => toPolyline(seriesPoints.value, 'tempRatio', CHART_WIDTH))
const humidityPolyline = computed(() => toPolyline(seriesPoints.value, 'humidityRatio', CHART_WIDTH))

const envFilterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  batchIds: [...filter.value.batchIds],
  anomalies: [...filter.value.anomalies]
}))

const envSelects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'batchIds',
    label: '批次',
    queryKey: 'batch',
    options: batchOptions.value.map((option) => ({
      label: option.label,
      value: option.value,
      count: records.value.filter((record) => record.batchId === option.value).length
    }))
  },
  {
    key: 'anomalies',
    label: '异常标记',
    queryKey: 'flag',
    options: [
      {
        label: '异常',
        value: '异常',
        count: records.value.filter((record) => record.anomaly).length
      },
      {
        label: '正常',
        value: '正常',
        count: records.value.filter((record) => !record.anomaly).length
      }
    ]
  }
])

/** 表单内实时越界判定与调整建议（始终按当前生效阈值版本） */
const preview = computed(() =>
  judgeEnvironment(form.tempC, form.humidityPct, zoneOf(form.batchId), activeSettings.value)
)
const previewZone = computed(() => zoneOf(form.batchId))

function applyFilter(model: FilterModel): void {
  filter.value = {
    keyword: model.keyword,
    batchIds: (model.batchIds as string[]) ?? [],
    anomalies: (model.anomalies as EnvironmentFilterState['anomalies']) ?? []
  }
}

function resetFilter(): void {
  filter.value = { keyword: '', anomalies: [], batchIds: [] }
  onlyAnomaly.value = false
}

function openDialog(record?: Environment): void {
  if (record) {
    editingId.value = record.id
    form.batchId = record.batchId
    form.recordedAt = record.recordedAt
    form.tempC = record.tempC
    form.humidityPct = record.humidityPct
    form.action = record.action
  } else {
    editingId.value = null
    form.batchId = batches.value[0]?.id ?? ''
    form.recordedAt = nowLocal()
    form.tempC = 12
    form.humidityPct = 85
    form.action = ''
  }
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  const zone = zoneOf(form.batchId)
  const verdict = judgeEnvironment(form.tempC, form.humidityPct, zone, activeSettings.value)
  const action = form.action.trim().length > 0 ? form.action.trim() : verdict.ok ? '' : verdict.suggestion
  const now = Date.now()
  const record: Environment = {
    id: editingId.value ?? createId('env'),
    batchId: form.batchId,
    recordedAt: form.recordedAt,
    tempC: form.tempC,
    humidityPct: form.humidityPct,
    zone,
    thresholdVersionId: activeVersion.value?.id ?? '',
    stale: false,
    anomaly: !verdict.ok,
    action,
    createdAt: now,
    updatedAt: now
  }
  if (editingId.value) {
    const existing = records.value.find((item) => item.id === editingId.value)
    await db.environments.put({ ...record, createdAt: existing?.createdAt ?? now })
    ElMessage.success('环境记录已按当前阈值版本更新')
  } else {
    await db.environments.put(record)
    ElMessage.success(`环境记录已按「${activeVersion.value?.label ?? '当前阈值'}」判定并保存`)
  }
  if (!verdict.ok) {
    ElMessage.warning(`温湿度越界已自动标异常：${verdict.message}；建议 ${verdict.suggestion}`)
  }
  dialogVisible.value = false
}

async function remove(record: Environment): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${record.recordedAt} 的环境记录（${record.tempC}℃ / ${record.humidityPct}%）？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await db.environments.delete(record.id)
  ElMessage.success('环境记录已删除')
}

/** 重算失效记录：版本变化后只有显式重算，旧记录的异常结论才会切换到新版本口径 */
async function recomputeStale(): Promise<void> {
  const pending = records.value.filter((record) => record.stale).length
  if (pending === 0) {
    ElMessage.info('没有结论已失效、待重算的记录')
    return
  }
  const { updated, version } = await thresholdStore.recompute(true)
  ElMessage.success(
    `已按「${version?.label ?? '当前阈值'}」重算 ${pending} 条失效记录，其中 ${updated} 条有实际更新`
  )
}

/** 一键按当前生效版本重算全部记录（人工标记也对齐到当前口径） */
async function remarkAnomalies(): Promise<void> {
  const { updated, version } = await thresholdStore.recompute(false)
  ElMessage.success(
    updated === 0
      ? '全部记录标记已是最新'
      : `已按「${version?.label ?? '当前阈值'}」重算 ${updated} 条记录`
  )
}

/* ---------------- 阈值版本管理对话框 ---------------- */

const thresholdDialogVisible = ref(false)
const savingThreshold = ref(false)
const baseDataVersion = ref(0)
const thresholdForm = reactive({
  label: '',
  effectiveAt: '',
  note: '',
  settings: cloneSettings(INITIAL_THRESHOLD_SETTINGS)
})

/** 发布前预演：按表单阈值与当前生效版本逐条比对，统计结论会反转的记录数 */
const previewChangedCount = computed(() => {
  const current = thresholdStore.activeSettings
  if (!current || !settingsChanged(current, thresholdForm.settings)) return 0
  let count = 0
  records.value.forEach((record) => {
    const oldOk = judgeByVersion(
      record.tempC,
      record.humidityPct,
      record.zone,
      thresholdStore.activeVersion
    ).ok
    const newOk = judgeEnvironment(
      record.tempC,
      record.humidityPct,
      record.zone,
      thresholdForm.settings
    ).ok
    if (oldOk !== newOk) count += 1
  })
  return count
})

const thresholdUnchanged = computed(() => {
  const current = thresholdStore.activeSettings
  return current ? !settingsChanged(current, thresholdForm.settings) : false
})

function todayString(): string {
  const date = new Date()
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function quarterLabel(): string {
  const date = new Date()
  const quarter = Math.floor(date.getMonth() / 3) + 1
  return `${date.getFullYear()} Q${quarter} 阈值调整`
}

async function openThresholdDialog(): Promise<void> {
  const source = thresholdStore.activeSettings ?? INITIAL_THRESHOLD_SETTINGS
  thresholdForm.label = quarterLabel()
  thresholdForm.effectiveAt = todayString()
  thresholdForm.note = ''
  thresholdForm.settings = cloneSettings(source)
  // 记录打开时的数据修订号；保存时若已被其它标签页推进则拒绝提交
  baseDataVersion.value = await thresholdStore.currentDataVersion()
  thresholdDialogVisible.value = true
}

async function submitThreshold(): Promise<void> {
  const label = thresholdForm.label.trim()
  if (!label) {
    ElMessage.warning('请填写版本名称')
    return
  }
  if (!thresholdForm.effectiveAt) {
    ElMessage.warning('请选择生效日期')
    return
  }
  savingThreshold.value = true
  try {
    const result = await thresholdStore.publishVersion(
      {
        label,
        effectiveAt: thresholdForm.effectiveAt,
        note: thresholdForm.note.trim(),
        ...cloneSettings(thresholdForm.settings)
      },
      baseDataVersion.value
    )
    ElMessage.success(
      `已发布新版本「${result.version.label}」：${result.changed} 条历史记录结论失效，保留原标记待重算`
    )
    thresholdDialogVisible.value = false
  } catch (err) {
    if (err instanceof StaleDataVersionError) {
      try {
        await ElMessageBox.confirm(`${err.message}。是否立即重新载入？`, '保存失败：页面已过期', {
          type: 'warning',
          confirmButtonText: '重新载入',
          cancelButtonText: '取消'
        })
        window.location.reload()
      } catch {
        /* 用户取消，留在对话框 */
      }
    } else {
      ElMessage.warning(err instanceof Error ? err.message : '阈值版本发布失败')
    }
  } finally {
    savingThreshold.value = false
  }
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>熟成库温湿度记录</h2>
        <p>
          当前阈值版本「{{ activeVersion?.label ?? '初始阈值' }}」（{{ activeVersion?.effectiveAt ?? '—' }} 生效）：冷区
          {{ activeSettings.tempRanges['冷区'].min }}-{{ activeSettings.tempRanges['冷区'].max }}℃ · 中温区
          {{ activeSettings.tempRanges['中温区'].min }}-{{ activeSettings.tempRanges['中温区'].max }}℃ · 常温区
          {{ activeSettings.tempRanges['常温区'].min }}-{{ activeSettings.tempRanges['常温区'].max }}℃，湿度
          {{ activeSettings.humidity.min }}-{{ activeSettings.humidity.max }}%。新记录按当前版本判定，历史记录保留原结论。
        </p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openDialog()">新增记录</el-button>
        <el-button type="warning" :icon="DataLine" @click="recomputeStale">
          重算失效记录{{ summary.staleCount > 0 ? `（${summary.staleCount}）` : '' }}
        </el-button>
        <el-button :icon="DataLine" @click="remarkAnomalies">全部重算</el-button>
        <el-button :icon="SetUp" @click="openThresholdDialog">温区阈值版本</el-button>
      </div>
    </div>

    <el-alert
      v-if="staleRecords.length > 0"
      type="warning"
      :closable="false"
      show-icon
      class="alert-gap"
    >
      阈值版本已调整，{{ staleRecords.length }} 条历史记录的异常结论已失效（原结论保留不变）。
      <el-button type="warning" size="small" :icon="DataLine" @click="recomputeStale">立即按新版本重算</el-button>
    </el-alert>

    <div class="stat-row">
      <StatBadge label="记录条数" :value="summary.total" suffix="条" icon="Files" />
      <StatBadge label="异常条数" :value="summary.anomalyCount" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="平均温度" :value="summary.avgTempC" suffix="℃" icon="Sunny" tone="warning" />
      <StatBadge label="平均湿度" :value="summary.avgHumidityPct" suffix="%" icon="Pouring" tone="info" />
      <StatBadge
        label="异常占比"
        :value="summary.anomalyPercent"
        suffix="%"
        icon="PieChart"
        :percent="summary.anomalyPercent"
        show-percent
        tone="primary"
      />
    </div>

    <FilterBar
      :model-value="envFilterModel"
      :selects="envSelects"
      keyword-placeholder="搜索记录时间 / 措施 / 批次"
      switch-label="仅看异常"
      :switch-value="onlyAnomaly"
      :has-switch="true"
      switch-key="onlyAnomaly"
      switch-query-key="only"
      @update:model-value="applyFilter"
      @update:switch-value="(value: boolean) => (onlyAnomaly = value)"
      @reset="resetFilter"
    />

    <div class="section-card">
      <div class="section-card__head">
        <h3>温湿度曲线</h3>
        <div class="chart-legend">
          <span><i class="chart-legend__dot" style="background: #d68910"></i>温度 ℃</span>
          <span><i class="chart-legend__dot" style="background: #3d7ea6"></i>湿度 %</span>
          <span><i class="chart-legend__dot" style="background: #c0392b"></i>越界异常点</span>
        </div>
      </div>

      <EmptyPanel
        v-if="ready && seriesPoints.length === 0"
        compact
        title="暂无可绘制的记录"
        description="新增温湿度记录后，这里会按时间顺序绘制温度与湿度曲线。"
        action-text="新增记录"
        @action="openDialog()"
      />

      <div v-else class="chart-wrap">
        <svg
          class="chart"
          :viewBox="`0 0 ${CHART_WIDTH} 100`"
          preserveAspectRatio="none"
          role="img"
          aria-label="温湿度曲线"
        >
          <line x1="0" y1="25" :x2="CHART_WIDTH" y2="25" class="chart-grid" />
          <line x1="0" y1="50" :x2="CHART_WIDTH" y2="50" class="chart-grid" />
          <line x1="0" y1="75" :x2="CHART_WIDTH" y2="75" class="chart-grid" />
          <polyline :points="tempPolyline" class="chart-line chart-line--temp" />
          <polyline :points="humidityPolyline" class="chart-line chart-line--humidity" />
          <g v-for="(point, index) in seriesPoints" :key="point.id">
            <circle
              v-if="point.anomaly"
              :cx="seriesPoints.length === 1 ? CHART_WIDTH / 2 : (index * CHART_WIDTH) / (seriesPoints.length - 1)"
              :cy="100 - point.tempRatio"
              r="2.6"
              class="chart-dot-anomaly"
            />
          </g>
        </svg>
        <div class="chart-axis">
          <span v-for="point in seriesPoints" :key="`axis_${point.id}`" class="chart-axis__item">
            {{ point.label }}
          </span>
        </div>
      </div>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>异常提示（{{ anomalyRecords.length }}）</h3>
        <span class="muted">越界记录自动标异常并给出开窗 / 加湿措施</span>
      </div>
      <EmptyPanel
        v-if="anomalyRecords.length === 0"
        compact
        title="当前筛选下没有越界记录"
        description="温湿度均在温区适宜范围内，继续保持每日登记即可。"
      />
      <el-table v-else :data="anomalyRecords" border stripe size="small">
        <el-table-column prop="recordedAt" label="记录时间" width="160" />
        <el-table-column label="批次" min-width="200">
          <template #default="{ row }">{{ batchLabelOf(row.batchId) }}</template>
        </el-table-column>
        <el-table-column label="记录温区" width="130">
          <template #default="{ row }">{{ row.zone }}</template>
        </el-table-column>
        <el-table-column label="温度" width="90">
          <template #default="{ row }">
            <span class="mono">{{ row.tempC }} ℃</span>
          </template>
        </el-table-column>
        <el-table-column label="湿度" width="90">
          <template #default="{ row }">
            <span class="mono">{{ row.humidityPct }} %</span>
          </template>
        </el-table-column>
        <el-table-column label="越界原因（按判定时版本）" min-width="220">
          <template #default="{ row }">{{ verdictOfRecord(row).message }}</template>
        </el-table-column>
        <el-table-column label="判定版本" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="row.stale ? 'warning' : 'info'" effect="plain">
              {{ versionLabelOf(row.thresholdVersionId) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="action" label="调整措施" min-width="200" show-overflow-tooltip />
      </el-table>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>记录明细（{{ filteredRecords.length }} / {{ records.length }}）</h3>
        <span class="muted">
          按记录时的阈值版本判定；版本调整后结论失效的记录标「待重算」，原异常结论保留至手动重算
        </span>
      </div>

      <EmptyPanel
        v-if="ready && filteredRecords.length === 0"
        title="没有符合条件的环境记录"
        description="调整筛选条件，或新增一条温湿度记录；越界时系统会自动标异常。"
        action-text="新增记录"
        @action="openDialog()"
      />
      <el-table v-else :data="filteredRecords" border stripe>
        <el-table-column prop="recordedAt" label="记录时间" width="170" />
        <el-table-column label="批次" min-width="210">
          <template #default="{ row }">{{ batchLabelOf(row.batchId) }}</template>
        </el-table-column>
        <el-table-column label="记录温区" width="100">
          <template #default="{ row }">{{ row.zone }}</template>
        </el-table-column>
        <el-table-column label="温度" width="100">
          <template #default="{ row }">
            <span class="mono" :style="{ color: ZONE_COLOR[(row as Environment).zone] }">{{ row.tempC }} ℃</span>
          </template>
        </el-table-column>
        <el-table-column label="湿度" width="100">
          <template #default="{ row }">
            <span class="mono">{{ row.humidityPct }} %</span>
          </template>
        </el-table-column>
        <el-table-column label="异常结论" width="110">
          <template #default="{ row }">
            <el-tag :type="row.anomaly ? 'danger' : 'success'" effect="dark" size="small">
              {{ row.anomaly ? '异常' : '正常' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="判定版本" min-width="180">
          <template #default="{ row }">
            <el-tag size="small" :type="row.stale ? 'warning' : 'info'" effect="plain">
              {{ versionLabelOf(row.thresholdVersionId) }}
            </el-tag>
            <el-tag v-if="row.stale" type="warning" size="small" effect="dark" class="stale-tag">
              待重算
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="action" label="调整措施" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button text :icon="Edit" @click="openDialog(row)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑环境记录' : '新增环境记录'"
      width="580px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="form.batchId" filterable placeholder="选择批次" style="width: 100%">
            <el-option
              v-for="option in batchOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="记录时间" prop="recordedAt">
          <el-date-picker
            v-model="form.recordedAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            placeholder="选择记录时间"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="温度 ℃" prop="tempC">
          <el-slider v-model="form.tempC" :min="-5" :max="30" :step="0.1" show-input />
        </el-form-item>
        <el-form-item label="湿度 %" prop="humidityPct">
          <el-slider v-model="form.humidityPct" :min="40" :max="100" :step="0.5" show-input />
        </el-form-item>
        <el-form-item label="调整措施" prop="action">
          <el-input
            v-model="form.action"
            type="textarea"
            :rows="2"
            :placeholder="preview.ok ? '温湿度正常，可留空' : preview.suggestion"
          />
        </el-form-item>
        <el-alert
          :type="preview.ok ? 'success' : 'error'"
          :closable="false"
          show-icon
        >
          <template v-if="preview.ok">
            {{ previewZone }} 温湿度正常（{{ form.tempC }}℃ / {{ form.humidityPct }}%），将按「{{ activeVersion?.label ?? '当前阈值' }}」标记为正常。
          </template>
          <template v-else>
            越界：{{ preview.message }} → 按「{{ activeVersion?.label ?? '当前阈值' }}」自动标异常，建议措施：{{ preview.suggestion }}
          </template>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="thresholdDialogVisible"
      title="温区阈值版本（每季度调整请发布新版本）"
      width="720px"
      destroy-on-close
    >
      <el-alert type="info" :closable="false" show-icon class="alert-gap">
        发布新版本不会重判历史记录：旧记录保留原异常结论，只有新旧结论不一致的记录会标「待重算」；
        新登记的记录直接按新版本判定。多标签页同时编辑时，先提交的版本优先，过期页面保存会被拒绝并提示重新载入。
      </el-alert>

      <el-form :model="thresholdForm" label-width="110px">
        <el-form-item label="版本名称" required>
          <el-input v-model="thresholdForm.label" placeholder="如：2026 Q2 入夏阈值" />
        </el-form-item>
        <el-form-item label="生效日期" required>
          <el-date-picker
            v-model="thresholdForm.effectiveAt"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择生效日期"
          />
        </el-form-item>

        <el-divider content-position="left">各温区温度区间（℃）</el-divider>
        <el-form-item v-for="zone in TEMP_ZONES" :key="zone" :label="zone">
          <el-input-number
            v-model="thresholdForm.settings.tempRanges[zone].min"
            :min="-10"
            :max="30"
            :step="0.5"
            :precision="1"
          />
          <span class="range-sep">～</span>
          <el-input-number
            v-model="thresholdForm.settings.tempRanges[zone].max"
            :min="-10"
            :max="35"
            :step="0.5"
            :precision="1"
          />
          <span class="muted range-current">
            当前：{{ thresholdStore.activeSettings?.tempRanges[zone].min }}-{{ thresholdStore.activeSettings?.tempRanges[zone].max }}℃
          </span>
        </el-form-item>

        <el-divider content-position="left">全库湿度区间（%）</el-divider>
        <el-form-item label="湿度">
          <el-input-number
            v-model="thresholdForm.settings.humidity.min"
            :min="0"
            :max="100"
            :step="1"
          />
          <span class="range-sep">～</span>
          <el-input-number
            v-model="thresholdForm.settings.humidity.max"
            :min="0"
            :max="100"
            :step="1"
          />
          <span class="muted range-current">
            当前：{{ thresholdStore.activeSettings?.humidity.min }}-{{ thresholdStore.activeSettings?.humidity.max }}%
          </span>
        </el-form-item>

        <el-form-item label="调整备注">
          <el-input v-model="thresholdForm.note" type="textarea" :rows="2" placeholder="如：入夏前整体上调 1℃" />
        </el-form-item>

        <el-alert :type="thresholdUnchanged ? 'info' : 'warning'" :closable="false" show-icon>
          <template v-if="thresholdUnchanged">
            新阈值与当前生效版本完全一致，无需发布新版本。
          </template>
          <template v-else>
            发布后将有 <strong>{{ previewChangedCount }}</strong> 条历史记录的异常结论失效（原结论保留，标记待重算），
            其余记录自动迁移到新版本引用。当前共有 {{ versions.length }} 个阈值版本。
          </template>
        </el-alert>
      </el-form>

      <template #footer>
        <el-button @click="thresholdDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="savingThreshold"
          :disabled="thresholdUnchanged"
          @click="submitThreshold"
        >
          发布新版本
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.alert-gap {
  margin-bottom: 16px;
}

.stale-tag {
  margin-left: 6px;
}

.range-sep {
  margin: 0 10px;
  color: #8c8479;
}

.range-current {
  margin-left: 12px;
  font-size: 12px;
}

.chart-wrap {
  width: 100%;
}

.chart {
  width: 100%;
  height: 180px;
  background: #fdfbf6;
  border: 1px solid #efe7d8;
  border-radius: 10px;
}

.chart-grid {
  stroke: #e7dfd0;
  stroke-width: 0.4;
  stroke-dasharray: 2 2;
}

.chart-line {
  fill: none;
  stroke-width: 1.4;
  vector-effect: non-scaling-stroke;
}

.chart-line--temp {
  stroke: #d68910;
}

.chart-line--humidity {
  stroke: #3d7ea6;
}

.chart-dot-anomaly {
  fill: #c0392b;
}

.chart-axis {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  color: #8c8479;
  font-size: 11px;
}
</style>
