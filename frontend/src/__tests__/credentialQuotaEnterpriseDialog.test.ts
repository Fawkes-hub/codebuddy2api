import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutationOptions, mutationState, invalidateQueries, setQueryData, toastMock, validateMock } =
  vi.hoisted(() => ({
    mutationOptions: {} as Record<string, (...args: any[]) => any>,
    mutationState: {
      isPending: { __v_isRef: true as const, value: false },
      mutate: vi.fn<(value: string | null) => void>(),
    },
    invalidateQueries: vi.fn<() => Promise<void>>(),
    setQueryData:
      vi.fn<
        (
          queryKey: readonly unknown[],
          updater: (old: Record<string, unknown> | undefined) => unknown,
        ) => void
      >(),
    toastMock: {
      success: vi.fn<(message: string) => void>(),
      warning: vi.fn<(message: string) => void>(),
    },
    validateMock: vi.fn<() => Promise<void>>(),
  }));

vi.mock('@tanstack/vue-query', () => ({
  useQueryClient: () => ({ invalidateQueries, setQueryData }),
  useMutation: (options: Record<string, (...args: any[]) => any>) => {
    Object.assign(mutationOptions, options);
    return mutationState;
  },
}));
vi.mock('../composables/useToast', () => ({ useToast: () => toastMock }));

import CredentialQuotaEnterpriseDialog from '../components/CredentialQuotaEnterpriseDialog.vue';
import { adminApi } from '../api/admin';

const FormStub = defineComponent({
  name: 'CForm',
  setup(_, { expose, slots }) {
    expose({ validate: validateMock, restoreValidation: vi.fn<() => void>() });
    return () => h('form', null, slots.default?.());
  },
});
const ModalStub = defineComponent({
  name: 'CModal',
  props: ['open', 'title', 'closable'],
  emits: ['update:open'],
  template:
    '<div v-if="open" class="modal-stub"><h2>{{ title }}</h2><slot /><div class="footer"><slot name="footer" /></div></div>',
});
const PopconfirmStub = defineComponent({
  name: 'CPopconfirm',
  props: ['title', 'confirmVariant'],
  emits: ['confirm'],
  template:
    '<div class="popconfirm-stub"><slot /><button class="confirm-delete" @click="$emit(\'confirm\')">确认删除标记</button></div>',
});

const baseCredential = {
  credential_id: 'cred-1',
  filename: 'token.json',
  user_id: 'user',
  time_remaining_str: '1h',
  is_expired: false,
  token_type: 'Bearer',
  auth_source: 'manual' as const,
  has_refresh_token: false,
  has_token: true,
  token_display: 'token',
};

function mountDialog(credential: Record<string, unknown> | null = baseCredential) {
  return mount(CredentialQuotaEnterpriseDialog, {
    props: { open: true, credential: credential as any },
    global: {
      stubs: {
        CForm: FormStub,
        CFormItem: { props: ['label', 'path'], template: '<label>{{ label }}<slot /></label>' },
        CModal: ModalStub,
        CPopconfirm: PopconfirmStub,
      },
    },
  });
}

describe('CredentialQuotaEnterpriseDialog', () => {
  beforeEach(() => {
    Object.keys(mutationOptions).forEach((key) => delete mutationOptions[key]);
    mutationState.isPending.value = false;
    mutationState.mutate.mockReset();
    invalidateQueries.mockReset();
    invalidateQueries.mockResolvedValue(undefined);
    setQueryData.mockReset();
    toastMock.success.mockReset();
    toastMock.warning.mockReset();
    validateMock.mockReset();
    validateMock.mockResolvedValue(undefined);
  });

  it('新增标记时校验并提交去除首尾空白的企业 ID', async () => {
    const apiSpy = vi
      .spyOn(adminApi, 'updateCredentialQuotaEnterpriseId')
      .mockResolvedValue({} as never);
    const wrapper = mountDialog();
    const state = (wrapper.vm.$ as any).setupState;
    expect(wrapper.text()).toContain('标记为企业版');
    expect(wrapper.text()).not.toContain('删除企业ID');
    expect(state.rules.enterpriseId.validator('enterprise-1')).toBe(true);
    expect(state.rules.enterpriseId.validator('bad\nvalue')).toBe('企业 ID 包含无效字符');
    expect(state.rules.enterpriseId.validator('非-ascii')).toBe('企业 ID 包含无效字符');
    expect(state.rules.enterpriseId.validator('')).toBe(true);

    validateMock.mockRejectedValueOnce(new Error('invalid'));
    state.form.enterpriseId = ' enterprise-1 ';
    await state.submit();
    expect(mutationState.mutate).not.toHaveBeenCalled();
    state.form.enterpriseId = '   ';
    await state.submit();
    expect(mutationState.mutate).not.toHaveBeenCalled();
    await wrapper.get('input').setValue(' enterprise-1 ');
    expect(state.form.enterpriseId).toBe(' enterprise-1 ');
    await state.submit();
    expect(mutationState.mutate).toHaveBeenCalledWith('enterprise-1');
    await mutationOptions.mutationFn('enterprise-1');
    expect(apiSpy).toHaveBeenCalledWith('cred-1', 'enterprise-1');
  });

  it('修改时预填并可二次确认删除企业 ID', async () => {
    const wrapper = mountDialog({ ...baseCredential, quota_enterprise_id: 'enterprise-1' });
    const state = (wrapper.vm.$ as any).setupState;
    expect(wrapper.text()).toContain('修改企业ID');
    expect(state.form.enterpriseId).toBe('enterprise-1');
    expect(wrapper.text()).toContain('删除企业ID');
    await wrapper.get('.confirm-delete').trigger('click');
    expect(mutationState.mutate).toHaveBeenCalledWith(null);

    state.form.enterpriseId = 'draft-enterprise';
    await wrapper.setProps({
      credential: { ...baseCredential, quota_enterprise_id: 'enterprise-2' },
    });
    expect(state.form.enterpriseId).toBe('draft-enterprise');
    await wrapper.setProps({
      credential: {
        ...baseCredential,
        credential_id: 'cred-2',
        quota_enterprise_id: 'enterprise-2',
      },
    });
    expect(state.form.enterpriseId).toBe('enterprise-2');
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true, credential: baseCredential });
    expect(state.form.enterpriseId).toBe('');
  });

  it('成功时更新缓存、刷新列表、提示结果并关闭', async () => {
    const wrapper = mountDialog();
    const updated = { ...baseCredential, quota_enterprise_id: 'enterprise-1' };
    await mutationOptions.onMutate();
    expect(wrapper.emitted('updating')).toEqual([[true]]);

    await mutationOptions.onSuccess(
      { credential: updated, quota_refresh_succeeded: true },
      'enterprise-1',
    );
    expect(toastMock.success).toHaveBeenCalledWith('已标记为企业版额度');
    expect(setQueryData).toHaveBeenCalledWith(
      ['admin', 'test-user', 'credentials'],
      expect.any(Function),
    );
    const updater = setQueryData.mock.calls[0][1] as (old: any) => any;
    expect(updater(undefined)).toBeUndefined();
    const untouched = { ...baseCredential, credential_id: 'cred-2' };
    const cached = updater({ credentials: [untouched, baseCredential], current: {} });
    expect(cached.credentials[0]).toBe(untouched);
    expect(cached.credentials[1].quota_enterprise_id).toBe('enterprise-1');
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['admin', 'test-user', 'credentials'],
    });
    expect(wrapper.emitted('close')).toBeUndefined();

    mutationOptions.onSettled();
    expect(wrapper.emitted('updating')).toEqual([[true], [false]]);
    expect(wrapper.emitted('close')).toEqual([[]]);

    await mutationOptions.onSuccess(
      { credential: baseCredential, quota_refresh_succeeded: true },
      null,
    );
    expect(toastMock.success).toHaveBeenCalledWith('企业 ID 已删除，已切换为个人版额度');
    await mutationOptions.onSuccess(
      { credential: baseCredential, quota_refresh_succeeded: false },
      null,
    );
    expect(toastMock.warning).toHaveBeenCalledWith('企业 ID 已删除，但个人版额度刷新失败');
  });

  it('更新失败结束后保留弹窗供用户重试', () => {
    const wrapper = mountDialog();

    mutationOptions.onMutate();
    mutationOptions.onSettled();

    expect(wrapper.emitted('updating')).toEqual([[true], [false]]);
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('处理关闭、空凭证和进行中保护', async () => {
    const wrapper = mountDialog(null);
    const state = (wrapper.vm.$ as any).setupState;
    await state.submit();
    state.removeEnterpriseId();
    expect(mutationState.mutate).not.toHaveBeenCalled();
    (wrapper.findComponent({ name: 'CModal' }).vm as any).$emit('update:open', false);
    expect(wrapper.emitted('close')).toEqual([[]]);

    mutationState.isPending.value = true;
    await wrapper.setProps({ credential: baseCredential });
    await state.submit();
    state.removeEnterpriseId();
    state.close();
    expect(mutationState.mutate).not.toHaveBeenCalled();
    expect(wrapper.findComponent({ name: 'CModal' }).props('closable')).toBe(false);
  });
});
