<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { CredentialRecord, CredentialsResponse } from '../types';
import { adminApi } from '../api/admin';
import { useSessionStore } from '../stores/session';
import { useToast } from '../composables/useToast';
import { adminQueryKeys } from '../utils/adminQueryKeys';
import CButton from './ui/CButton.vue';
import CForm, { type FormRules } from './ui/CForm.vue';
import CFormItem from './ui/CFormItem.vue';
import CInput from './ui/CInput.vue';
import CModal from './ui/CModal.vue';
import CPopconfirm from './ui/CPopconfirm.vue';

const props = defineProps<{
  open: boolean;
  credential: CredentialRecord | null;
}>();
const emit = defineEmits<{ close: []; updating: [value: boolean] }>();
const session = useSessionStore();
const queryClient = useQueryClient();
const queryKeys = adminQueryKeys(session.username);
const toast = useToast();
const form = reactive({ enterpriseId: '' });
const formRef = ref<InstanceType<typeof CForm> | null>(null);
const hasEnterpriseId = computed(() => Boolean(props.credential?.quota_enterprise_id));
const title = computed(() => (hasEnterpriseId.value ? '修改企业ID' : '标记为企业版'));
let updateSucceeded = false;
const rules: FormRules = {
  enterpriseId: {
    required: true,
    whitespace: true,
    message: '请输入企业 ID',
    trigger: 'input',
    validator: (value) => {
      if (!value) return true;
      return /^[\x20-\x7e]+$/.test(String(value)) || '企业 ID 包含无效字符';
    },
  },
};

function reset(): void {
  form.enterpriseId = props.credential?.quota_enterprise_id || '';
  formRef.value?.restoreValidation();
}

watch(
  () => [props.open, props.credential?.credential_id] as const,
  ([open, credentialId], previous) => {
    if (open && (!previous?.[0] || credentialId !== previous[1])) reset();
  },
  { immediate: true },
);

const updateMutation = useMutation({
  mutationFn: (enterpriseId: string | null) =>
    adminApi.updateCredentialQuotaEnterpriseId(props.credential!.credential_id, enterpriseId),
  networkMode: 'always',
  onMutate: () => {
    updateSucceeded = false;
    emit('updating', true);
  },
  onSuccess: async (result, enterpriseId) => {
    updateSucceeded = true;
    queryClient.setQueryData<CredentialsResponse>(queryKeys.credentials, (old) => {
      if (!old) return old;
      return {
        ...old,
        credentials: old.credentials.map((credential) =>
          credential.credential_id === result.credential.credential_id
            ? result.credential
            : credential,
        ),
      };
    });
    if (enterpriseId === null) {
      if (result.quota_refresh_succeeded) {
        toast.success('企业 ID 已删除，已切换为个人版额度');
      } else {
        toast.warning('企业 ID 已删除，但个人版额度刷新失败');
      }
    } else {
      toast.success('已标记为企业版额度');
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
  },
  onSettled: () => {
    emit('updating', false);
    if (updateSucceeded) emit('close');
    updateSucceeded = false;
  },
});

function close(): void {
  if (!updateMutation.isPending.value) emit('close');
}

async function submit(): Promise<void> {
  if (!props.credential || updateMutation.isPending.value) return;
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  const enterpriseId = form.enterpriseId.trim();
  if (!enterpriseId) return;
  updateMutation.mutate(enterpriseId);
}

function removeEnterpriseId(): void {
  if (!props.credential || !props.credential.quota_enterprise_id || updateMutation.isPending.value)
    return;
  updateMutation.mutate(null);
}
</script>

<template>
  <CModal
    :open="open"
    :title="title"
    :closable="!updateMutation.isPending.value"
    @update:open="close"
  >
    <p class="mb-4 text-sm text-muted">
      此企业 ID 只用于额度探测，不会加入聊天、模型查询、凭证测试或签到请求。
    </p>
    <CForm ref="formRef" :model="form" :rules="rules" label-placement="top">
      <CFormItem label="企业 ID" path="enterpriseId" required>
        <CInput
          v-model="form.enterpriseId"
          :disabled="updateMutation.isPending.value"
          :maxlength="256"
          autocomplete="off"
          placeholder="请输入企业 ID"
          @enter="submit"
        />
      </CFormItem>
    </CForm>
    <template #footer>
      <CPopconfirm
        v-if="hasEnterpriseId"
        title="确定删除企业 ID？删除后该凭证将按个人版探测额度。"
        confirm-variant="danger"
        @confirm="removeEnterpriseId"
      >
        <CButton class="mr-auto" variant="danger" :disabled="updateMutation.isPending.value">
          删除企业ID
        </CButton>
      </CPopconfirm>
      <CButton :disabled="updateMutation.isPending.value" @click="close">取消</CButton>
      <CButton
        variant="primary"
        :loading="updateMutation.isPending.value"
        :disabled="!credential"
        @click="submit"
      >
        保存并探测
      </CButton>
    </template>
  </CModal>
</template>
