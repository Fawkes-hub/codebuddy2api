<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { chunkLoadRecovery } from '../../../src/utils/chunkLoadRecovery';

const draft = ref('');
const protectDraft = ref(false);
const version = __E2E_VERSION__;
let releaseReloadDeferral: (() => void) | null = null;

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

function pushBefore() {
  return chunkLoadRecovery.push('/before');
}

function pushBroken() {
  return chunkLoadRecovery.push('/broken');
}

function replaceTarget() {
  return chunkLoadRecovery.replace('/target');
}

function updateSource() {
  return chunkLoadRecovery.push('/source?updated=1');
}

function beginCriticalOperation(): void {
  if (releaseReloadDeferral === null) {
    releaseReloadDeferral = chunkLoadRecovery.deferReload();
  }
}

async function finishCriticalOperation(): Promise<void> {
  if (releaseReloadDeferral === null) throw new Error('延迟租约尚未创建');
  const release = releaseReloadDeferral;
  releaseReloadDeferral = null;
  try {
    await chunkLoadRecovery.push('/');
  } finally {
    release();
  }
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
      <button data-testid="push-before" type="button" @click="pushBefore">push 前置页</button>
      <button data-testid="push-broken" type="button" @click="pushBroken">push 异常页</button>
      <button data-testid="replace-target" type="button" @click="replaceTarget">
        replace 目标页
      </button>
      <button data-testid="update-source" type="button" @click="updateSource">更新来源页</button>
      <button data-testid="begin-critical-operation" type="button" @click="beginCriticalOperation">
        开始临界操作
      </button>
      <button
        data-testid="finish-critical-operation"
        type="button"
        @click="finishCriticalOperation"
      >
        完成临界操作
      </button>
    </div>
  </section>
</template>
