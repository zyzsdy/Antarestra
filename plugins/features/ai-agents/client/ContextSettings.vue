<script setup lang="ts">
import { computed } from 'vue'
import { CheckboxField, SelectField } from '@antarestra/webui/components'
import type { ContextPolicy } from '@antarestra/contracts'
import type { Capabilities } from '../src/types.js'
const policy = defineModel<ContextPolicy>({ required: true })
const props = defineProps<{ capabilities: Capabilities; invalid?: string }>()
const models = computed(() => [
  { id: 'inherit', name: '与本次主模型相同' },
  ...props.capabilities.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: JSON.stringify([provider.id, model.id]),
      name: `${provider.title} / ${model.title}`,
    })),
  ),
])
const model = computed({
  get: () =>
    policy.value.compaction.model
      ? JSON.stringify([
          policy.value.compaction.model.providerId,
          policy.value.compaction.model.modelId,
        ])
      : 'inherit',
  set: (value: string) => {
    const [providerId, modelId] =
      value !== 'inherit' ? (JSON.parse(value) as [string, string]) : ['', '']
    policy.value.compaction.model = value !== 'inherit' ? { providerId, modelId } : null
  },
})
const thinking = computed({
  get: () => policy.value.compaction.thinking ?? 'inherit',
  set: (value: string) => {
    policy.value.compaction.thinking = value === 'inherit' ? null : value
  },
})
const levels = computed(() => {
  const ref = policy.value.compaction.model
  const available = ref
    ? (props.capabilities.providers
        .find((p) => p.id === ref.providerId)
        ?.models.find((m) => m.id === ref.modelId)?.thinkingLevels ?? [])
    : props.capabilities.providers.flatMap((p) => p.models.flatMap((m) => m.thinkingLevels))
  return [
    { id: 'inherit', name: '与本次主请求相同' },
    { id: 'off', name: '不指定思考强度' },
    ...[...new Set(available)].filter((level) => level !== 'off').map((id) => ({ id, name: id })),
  ]
})
function amount(event: Event, field: 'reserve' | 'keepRecent') {
  const value = (event.target as HTMLInputElement).value.trim()
  policy.value.compaction[field] = /^\d+$/.test(value) ? Number(value) : value
}
</script>

<template>
  <section class="agents-context-settings" aria-label="上下文管理">
    <h3>上下文管理</h3>
    <label class="agents-check"
      ><CheckboxField v-model="policy.compaction.enabled" />在接近上下文窗口时自动压缩</label
    >
    <label for="agent-context-reserve">接近窗口／输出预留</label>
    <input
      id="agent-context-reserve"
      :value="policy.compaction.reserve"
      placeholder="16000 或 10%"
      @input="amount($event, 'reserve')"
      aria-describedby="agent-context-hint agent-validation"
      :aria-invalid="invalid === 'agent-context-reserve'"
    />
    <p id="agent-context-hint" class="agents-hint">
      支持 token 正整数或百分比。输出预留用于预算判断，不限制模型实际最大输出；关闭压缩后仍生效。
    </p>
    <label for="agent-context-recent">保留最近不压缩窗口</label>
    <input
      id="agent-context-recent"
      :value="policy.compaction.keepRecent"
      :disabled="!policy.compaction.enabled"
      placeholder="10000 或 10%"
      @input="amount($event, 'keepRecent')"
      aria-describedby="agent-validation"
      :aria-invalid="invalid === 'agent-context-recent'"
    />
    <label for="agent-compression-model">压缩模型</label>
    <SelectField
      id="agent-compression-model"
      v-model="model"
      label="压缩模型"
      :options="models"
      searchable
      :disabled="!policy.compaction.enabled"
    />
    <label for="agent-compression-thinking">压缩思考强度</label>
    <SelectField
      id="agent-compression-thinking"
      v-model="thinking"
      label="压缩思考强度"
      :options="levels"
      :disabled="!policy.compaction.enabled"
    />
    <label class="agents-check"><CheckboxField v-model="policy.trimming.enabled" />自动裁剪</label>
    <template v-if="policy.trimming.enabled">
      <label for="agent-trim-mode">保留轮数</label>
      <SelectField
        id="agent-trim-mode"
        v-model="policy.trimming.mode"
        label="保留轮数"
        :options="[
          { id: 'rounds', name: '指定轮数' },
          { id: 'auto', name: '自动' },
        ]"
      />
      <template v-if="policy.trimming.mode === 'rounds'">
        <label for="agent-trim-rounds">完整历史轮数</label>
        <input
          id="agent-trim-rounds"
          v-model.number="policy.trimming.rounds"
          type="number"
          min="1"
          step="1"
          aria-describedby="agent-trim-hint agent-validation"
          :aria-invalid="invalid === 'agent-trim-rounds'"
        />
      </template>
      <p id="agent-trim-hint" class="agents-hint">
        指定轮数始终只保留最近 N
        轮完整历史，加本次输入；自动模式仅在超预算时从头删除完整轮次。聊天原文仍可查看。
      </p>
      <label class="agents-check"
        ><CheckboxField v-model="policy.trimming.keepFirst" />保留首条用户消息</label
      >
    </template>
  </section>
</template>
