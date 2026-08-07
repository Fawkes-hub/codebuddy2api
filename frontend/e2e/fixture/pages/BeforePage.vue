<script setup lang="ts">
import { chunkLoadRecovery } from '../../../src/utils/chunkLoadRecovery';

const version = __E2E_VERSION__;

function openSource() {
  return chunkLoadRecovery.push('/source');
}
</script>

<template>
  <section>
    <h1>前置页面 {{ version }}</h1>
    <button data-testid="open-source" type="button" @click="openSource">进入来源页</button>
  </section>
</template>
