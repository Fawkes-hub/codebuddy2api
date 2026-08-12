import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutationOptions, mutationState, invalidateQueries, setQueryData, toastMock } = vi.hoisted(
  () => ({
    mutationOptions: {} as Record<string, (...args: any[]) => any>,
    mutationState: {
      isPending: { __v_isRef: true as const, value: false },
      mutate: vi.fn<(value: 'personal' | 'enterprise') => void>(),
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
    },
  }),
);

vi.mock('@tanstack/vue-query', () => ({
  useQueryClient: () => ({ invalidateQueries, setQueryData }),
  useMutation: (options: Record<string, (...args: any[]) => any>) => {
    Object.assign(mutationOptions, options);
    return mutationState;
  },
}));
vi.mock('../composables/useToast', () => ({ useToast: () => toastMock }));

import CredentialQuotaProbeModeDialog from '../components/CredentialQuotaProbeModeDialog.vue';
import { adminApi } from '../api/admin';

const ModalStub = defineComponent({
  name: 'CModal',
  props: ['open', 'title', 'closable'],
  emits: ['update:open'],
  template:
    '<div v-if="open" class="modal-stub"><h2>{{ title }}</h2><slot /><div class="footer"><slot name="footer" /></div></div>',
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
  return mount(CredentialQuotaProbeModeDialog, {
    props: { open: true, credential: credential as any },
    global: { stubs: { CModal: ModalStub } },
  });
}

describe('CredentialQuotaProbeModeDialog', () => {
  beforeEach(() => {
    Object.keys(mutationOptions).forEach((key) => delete mutationOptions[key]);
    mutationState.isPending.value = false;
    mutationState.mutate.mockReset();
    invalidateQueries.mockReset();
    invalidateQueries.mockResolvedValue(undefined);
    setQueryData.mockReset();
    toastMock.success.mockReset();
  });

  it('默认选择个人版并可切换为企业版后保存探测', async () => {
    const apiSpy = vi
      .spyOn(adminApi, 'updateCredentialQuotaProbeMode')
      .mockResolvedValue({} as never);
    const wrapper = mountDialog();
    const state = (wrapper.vm.$ as any).setupState;

    expect(wrapper.text()).toContain('额度探测方式');
    expect(wrapper.text()).toContain('个人版');
    expect(wrapper.text()).toContain('企业版');
    expect(wrapper.text()).not.toContain('企业 ID');
    expect(state.mode).toBe('personal');

    await wrapper.findAll('[role="radio"]')[1].trigger('click');
    expect(state.mode).toBe('enterprise');
    await state.submit();
    expect(mutationState.mutate).toHaveBeenCalledWith('enterprise');
    await mutationOptions.mutationFn('enterprise');
    expect(apiSpy).toHaveBeenCalledWith('cred-1', 'enterprise');
  });

  it('仅在重新打开或切换目标凭证时初始化选择', async () => {
    const wrapper = mountDialog({ ...baseCredential, quota_probe_mode: 'enterprise' });
    const state = (wrapper.vm.$ as any).setupState;
    expect(state.mode).toBe('enterprise');

    await wrapper.findAll('[role="radio"]')[0].trigger('click');
    expect(state.mode).toBe('personal');
    await wrapper.setProps({
      credential: { ...baseCredential, quota_probe_mode: 'enterprise' },
    });
    expect(state.mode).toBe('personal');

    await wrapper.setProps({
      credential: {
        ...baseCredential,
        credential_id: 'cred-2',
        quota_probe_mode: 'enterprise',
      },
    });
    expect(state.mode).toBe('enterprise');
    await wrapper.setProps({ open: false, credential: baseCredential });
    await wrapper.setProps({ open: true });
    expect(state.mode).toBe('personal');
  });

  it('成功时更新缓存、刷新列表、提示所选方式并关闭', async () => {
    const wrapper = mountDialog();
    const updated = { ...baseCredential, quota_probe_mode: 'enterprise' as const };
    mutationOptions.onMutate();
    expect(wrapper.emitted('updating')).toEqual([[true]]);

    await mutationOptions.onSuccess(
      { credential: updated, quota_refresh_succeeded: true },
      'enterprise',
    );
    expect(toastMock.success).toHaveBeenCalledWith('已切换为企业版额度探测');
    expect(setQueryData).toHaveBeenCalledWith(
      ['admin', 'test-user', 'credentials'],
      expect.any(Function),
    );
    const updater = setQueryData.mock.calls[0][1] as (old: any) => any;
    expect(updater(undefined)).toBeUndefined();
    const untouched = { ...baseCredential, credential_id: 'cred-2' };
    const cached = updater({ credentials: [untouched, baseCredential], current: {} });
    expect(cached.credentials[0]).toBe(untouched);
    expect(cached.credentials[1].quota_probe_mode).toBe('enterprise');
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['admin', 'test-user', 'credentials'],
    });
    expect(wrapper.emitted('close')).toBeUndefined();

    mutationOptions.onSettled();
    expect(wrapper.emitted('updating')).toEqual([[true], [false]]);
    expect(wrapper.emitted('close')).toEqual([[]]);

    await mutationOptions.onSuccess(
      {
        credential: { ...baseCredential, quota_probe_mode: 'personal' },
        quota_refresh_succeeded: true,
      },
      'personal',
    );
    expect(toastMock.success).toHaveBeenCalledWith('已切换为个人版额度探测');
  });

  it('更新失败保留弹窗，并处理关闭、空凭证和进行中保护', async () => {
    const wrapper = mountDialog(null);
    const state = (wrapper.vm.$ as any).setupState;
    await state.submit();
    expect(mutationState.mutate).not.toHaveBeenCalled();
    wrapper.findComponent({ name: 'CModal' }).vm.$emit('update:open', false);
    expect(wrapper.emitted('close')).toEqual([[]]);

    mutationOptions.onMutate();
    mutationOptions.onSettled();
    expect(wrapper.emitted('updating')).toEqual([[true], [false]]);
    expect(wrapper.emitted('close')).toEqual([[]]);

    mutationState.isPending.value = true;
    await wrapper.setProps({ credential: baseCredential });
    await state.submit();
    state.close();
    expect(mutationState.mutate).not.toHaveBeenCalled();
    expect(wrapper.findComponent({ name: 'CModal' }).props('closable')).toBe(false);
  });
});
