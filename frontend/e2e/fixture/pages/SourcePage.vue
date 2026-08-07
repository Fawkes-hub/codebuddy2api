<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { chunkLoadRecovery } from '../../../src/utils/chunkLoadRecovery';

const draft = ref('');
const protectDraft = ref(false);
const version = __E2E_VERSION__;

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!protectDraft.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onMounted(() => window.addEventListener('beforeunload', handleBeforeUnload));
onUnmounted(() => window.removeEventListener('beforeunload', handleBeforeUnload));

function pushTarget() {
  return chunkLoadRecovery.push('/target');
}

function replaceTarget() {
  return chunkLoadRecovery.replace('/target');
}
</script>

<template>
  <section>
    <h1>来源页面 {{ version }}</h1>
    <label>
      草稿
      <input v-model="draft" data-testid="draft" />
    </label>
    <label>
      <input v-model="protectDraft" data-testid="protect-draft" type="checkbox" />
      离开前确认
    </label>
    <div>
      <button data-testid="push-target" type="button" @click="pushTarget">push 目标页</button>
      <button data-testid="replace-target" type="button" @click="replaceTarget">
        replace 目标页
      </button>
    </div>
  </section>
</template>
