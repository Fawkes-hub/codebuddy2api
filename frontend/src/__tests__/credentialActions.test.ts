import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CredentialActions from '../components/CredentialActions.vue';
import CActionMenu from '../components/ui/CActionMenu.vue';
import type { CredentialRecord } from '../types';

const ActionMenuStub = defineComponent({
  name: 'CActionMenu',
  props: ['items', 'disabled', 'loading'],
  emits: ['select'],
  template: '<div class="action-menu-stub" />',
});

const ModalStub = defineComponent({
  name: 'CModal',
  props: ['open', 'title', 'closable'],
  emits: ['update:open'],
  template:
    '<div v-if="open" class="modal-stub"><slot /><div class="modal-footer"><slot name="footer" /></div></div>',
});

const credential: CredentialRecord = {
  credential_id: 'cred-1',
  filename: 'credential.json',
  user_id: 'user-1',
  email: 'user@example.com',
  time_remaining_str: '1h',
  is_expired: false,
  token_type: 'Bearer',
  auth_source: 'manual',
  has_refresh_token: false,
  has_token: true,
  token_display: 'token...view',
};

function mountActions(overrides: Record<string, unknown> = {}) {
  return mount(CredentialActions, {
    props: {
      credential,
      isCurrent: false,
      isTesting: false,
      canCheckIn: true,
      canEditQuotaProbeMode: true,
      ...overrides,
    },
    global: { stubs: { CActionMenu: ActionMenuStub, CModal: ModalStub } },
  });
}

function items(wrapper: ReturnType<typeof mountActions>) {
  return wrapper.findComponent(CActionMenu).props('items') as Array<Record<string, any>>;
}

describe('CredentialActions', () => {
  it('仅保留选择和测试快捷按钮，其余操作按顺序进入图标加名称菜单', async () => {
    const wrapper = mountActions();
    expect(wrapper.findAll('.table-action-button')).toHaveLength(2);
    expect(items(wrapper).map((item) => item.label)).toEqual([
      '签到',
      '刷新额度',
      '额度探测方式',
      '删除凭证',
    ]);
    expect(items(wrapper).every((item) => item.icon)).toBe(true);
    expect(items(wrapper).at(-1)?.separatorBefore).toBe(true);
    expect(items(wrapper).at(-1)?.danger).toBe(true);

    await wrapper.get('[aria-label="切换为当前凭证"]').trigger('click');
    await wrapper.get('[aria-label="测试凭证"]').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['cred-1']]);
    expect(wrapper.emitted('test')).toEqual([['cred-1']]);

    const menu = wrapper.findComponent(CActionMenu);
    menu.vm.$emit('select', 'checkin');
    menu.vm.$emit('select', 'refreshQuota');
    menu.vm.$emit('select', 'editQuotaProbeMode');
    (wrapper.vm.$ as any).setupState.handleMenuAction('unknown');
    expect(wrapper.emitted('checkin')).toEqual([['cred-1']]);
    expect(wrapper.emitted('refreshQuota')).toEqual([['cred-1']]);
    expect(wrapper.emitted('editQuotaProbeMode')).toEqual([['cred-1']]);
  });

  it('按凭证能力显示账号切换与额度探测方式入口', async () => {
    const wrapper = mountActions({
      canSwitchAccount: true,
      credential: { ...credential, quota_probe_mode: 'enterprise' },
    });
    expect(items(wrapper).map((item) => item.label)).toEqual([
      '签到',
      '切换 CodeBuddy 账号',
      '刷新额度',
      '额度探测方式',
      '删除凭证',
    ]);
    wrapper.findComponent(CActionMenu).vm.$emit('select', 'switchAccount');
    expect(wrapper.emitted('switchAccount')).toEqual([['cred-1']]);

    await wrapper.setProps({ canSwitchAccount: false, canEditQuotaProbeMode: false });
    expect(items(wrapper).map((item) => item.label)).toEqual(['签到', '刷新额度', '删除凭证']);
    await wrapper.setProps({ canCheckIn: false });
    expect(items(wrapper).map((item) => item.label)).toEqual(['刷新额度', '删除凭证']);
  });

  it('保留签到详情、资格原因和已过期额度刷新原因', async () => {
    const wrapper = mountActions({
      credential: {
        ...credential,
        daily_checkin: {
          code: 0,
          message: 'OK',
          success: true,
          credit: 100,
          checked_in_at: 1_700_000_000,
          next_checkin_at: 1_700_086_400,
        },
      },
    });
    const checkin = items(wrapper)[0];
    expect(checkin.disabled).toBe(true);
    expect(checkin.title).toContain('签到时间：');
    expect(checkin.title).toContain('获得积分：100');
    expect(checkin.title).toContain('下次可签到：');

    await wrapper.setProps({
      credential: {
        ...credential,
        daily_checkin: { code: 0, message: 'OK', success: true, credit: null },
      },
    });
    expect(items(wrapper)[0].title).toBe('签到时间：-\n获得积分：-');

    await wrapper.setProps({
      credential: {
        ...credential,
        daily_checkin: { code: 7, message: '稍后再试', success: false },
      },
    });
    expect(items(wrapper)[0].title).toBe('Code：7\n消息：稍后再试');

    await wrapper.setProps({
      credential: {
        ...credential,
        daily_checkin: { code: null, message: '网络异常', success: false },
      },
    });
    expect(items(wrapper)[0].title).toBe('Code：未知\n消息：网络异常');

    await wrapper.setProps({
      credential: { ...credential, is_expired: true },
      canCheckIn: false,
      checkinDisabledReason: '凭证已过期，无法签到',
    });
    expect(items(wrapper)[0]).toMatchObject({
      label: '签到',
      disabled: true,
      title: '凭证已过期，无法签到',
    });
    expect(items(wrapper)[1]).toMatchObject({
      label: '刷新额度',
      disabled: true,
      title: '凭证已过期，无法刷新额度',
    });
  });

  it('并发状态锁定快捷按钮和菜单并阻止重复事件', async () => {
    const wrapper = mountActions({
      isCurrent: true,
      autoRotationEnabled: true,
      isRefreshingQuota: true,
      canSwitchAccount: true,
    });
    expect(wrapper.get('[aria-label="固定当前凭证"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[aria-label="测试凭证"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findComponent(CActionMenu).props('disabled')).toBe(true);
    expect(wrapper.findComponent(CActionMenu).props('loading')).toBe(true);
    const state = (wrapper.vm.$ as any).setupState;
    state.selectCredential();
    state.testCredential();
    state.handleMenuAction('checkin');
    state.handleMenuAction('switchAccount');
    state.handleMenuAction('refreshQuota');
    state.handleMenuAction('editQuotaProbeMode');
    state.handleMenuAction('delete');
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.emitted('test')).toBeUndefined();
    expect(wrapper.emitted('checkin')).toBeUndefined();
    expect(wrapper.emitted('delete')).toBeUndefined();

    await wrapper.setProps({ isRefreshingQuota: false, hasActiveTests: true });
    expect(wrapper.findComponent(CActionMenu).props('disabled')).toBe(true);
    expect(wrapper.get('[aria-label="测试凭证"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[aria-label="测试凭证"]').trigger('click');
    expect(wrapper.emitted('test')).toEqual([['cred-1']]);
    await wrapper.setProps({ hasActiveTests: false, writeInProgress: true });
    expect(wrapper.findComponent(CActionMenu).props('disabled')).toBe(true);
    expect(wrapper.get('[aria-label="测试凭证"]').attributes('disabled')).toBeDefined();
  });

  it('过期凭证保留额度探测方式入口但禁用并阻止事件', () => {
    const wrapper = mountActions({
      credential: { ...credential, is_expired: true },
      quotaProbeModeDisabledReason: '凭证已过期，无法修改额度探测方式',
    });
    const item = items(wrapper).find((candidate) => candidate.key === 'editQuotaProbeMode');

    expect(item).toMatchObject({
      label: '额度探测方式',
      disabled: true,
      title: '凭证已过期，无法修改额度探测方式',
    });
    wrapper.findComponent(CActionMenu).vm.$emit('select', 'editQuotaProbeMode');
    expect(wrapper.emitted('editQuotaProbeMode')).toBeUndefined();
  });

  it('当前固定状态正确显示，并通过模态确认删除', async () => {
    const wrapper = mountActions({ isCurrent: true });
    expect(wrapper.get('[aria-label="已是当前凭证"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[aria-label="已是当前凭证"]').classes()).toContain(
      'current-credential-action-button',
    );

    wrapper.findComponent(CActionMenu).vm.$emit('select', 'delete');
    await wrapper.vm.$nextTick();
    const modal = wrapper.findComponent({ name: 'CModal' });
    expect(modal.props('open')).toBe(true);
    expect(wrapper.text()).toContain('user@example.com');
    await wrapper.setProps({ isDeleting: true });
    (wrapper.vm.$ as any).setupState.closeDeleteModal();
    (wrapper.vm.$ as any).setupState.confirmDelete();
    expect(modal.props('open')).toBe(true);
    expect(wrapper.emitted('delete')).toBeUndefined();
    await wrapper.setProps({ isDeleting: false });
    const buttons = wrapper.findAll('.modal-footer button');
    await buttons[0].trigger('click');
    expect(modal.props('open')).toBe(false);

    wrapper.findComponent(CActionMenu).vm.$emit('select', 'delete');
    await wrapper.vm.$nextTick();
    await wrapper.findAll('.modal-footer button')[1].trigger('click');
    expect(wrapper.emitted('delete')).toEqual([['cred-1']]);

    await wrapper.setProps({ credential: { ...credential, email: undefined } });
    expect((wrapper.vm.$ as any).setupState.deleteTitle).toContain('user-1');
    await wrapper.setProps({ credential: { ...credential, email: undefined, user_id: '' } });
    expect((wrapper.vm.$ as any).setupState.deleteTitle).toContain('cred-1');
  });
});
