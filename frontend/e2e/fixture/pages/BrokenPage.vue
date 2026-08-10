<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({ name: 'BrokenPage' });

throw new ReferenceError('E2E_MODULE_INITIALIZATION_ERROR');
</script>

<template>
  <section>
    <h1>不应显示的异常页面</h1>
  </section>
</template>
