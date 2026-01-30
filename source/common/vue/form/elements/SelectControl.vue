<template>
  <div v-bind:class="{ inline: inline === true, 'form-control': true }">
    <label v-if="label" v-bind:for="fieldID" v-html="label"></label>
    <select
      v-bind:id="fieldID"
      v-model="inputValue"
      v-bind:disabled="props.disabled"
      v-bind:name="name"
      v-bind:class="{ inline: inline === true }"
    >
      <template v-for="(value, key) in options" v-bind:key="key">
        <!-- No groups -->
        <option
          v-if="typeof value === 'string' && value !== null"
          v-bind:value="key"
          v-bind:selected="key === modelValue"
        >
          {{ value }}
        </option>
        <!-- Groups -->
        <optgroup
          v-else
          v-bind:label="key"
        >
          <option
            v-for="(valueLabel, item) in value"
            v-bind:key="item"
            v-bind:value="{ [key]: item }"
            v-bind:selected="isSelectedGroup(key, item)"
          >
            {{ valueLabel }}
          </option>
        </optgroup>
      </template>
    </select>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Select
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This component displays a generic dropdown.
 *
 * END HEADER
 */

import { computed, ref, watch, toRef } from 'vue'

const props = defineProps<{
  modelValue: string|Record<string, string>
  disabled?: boolean
  inline?: boolean
  label?: string
  name?: string
  options: Record<string, string|Record<string, string>>
}>()

const inputValue = ref<string|Record<string, string>>(props.modelValue)

function isSelectedGroup (group: string, item: string) {
  if (typeof props.modelValue === 'object' && props.modelValue !== null) {
    return props.modelValue[group] === item
  }

  return false
}

const emit = defineEmits<(e: 'update:modelValue', val: string|Record<string, string>) => void>()

watch(toRef(props, 'modelValue'), () => {
  inputValue.value = props.modelValue
})

watch(inputValue, () => {
  emit('update:modelValue', inputValue.value)
})

const fieldID = computed<string>(() => 'form-select-' + (props.name ?? ''))
</script>

<style lang="less">
</style>
