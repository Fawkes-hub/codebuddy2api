import { enableAutoUnmount, mount } from '@vue/test-utils';
import { defineComponent, h, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerOverlay } from '../components/ui/overlayStack';

enableAutoUnmount(afterEach);

const { retryReload, stayOnCurrentPage } = vi.hoisted(() => ({
  retryReload: vi.fn<() => void>(),
  stayOnCurrentPage: vi.fn<() => void>(),
}));

vi.mock('../utils/chunkLoadRecovery', async () => {
  const { ref } = await import('vue');
  return {
    chunkLoadRecovery: {
      failure: ref<{ canStay: boolean } | null>(null),
      retryReload,
      stayOnCurrentPage,
    },
  };
});

import { chunkLoadRecovery } from '../utils/chunkLoadRecovery';
import ChunkLoadRecoveryDialog from '../components/ChunkLoadRecoveryDialog.vue';
const failure = chunkLoadRecovery.failure as Ref<{ canStay: boolean } | null>;

const CButtonStub = defineComponent({
  name: 'CButton',
  inheritAttrs: false,
  props: { variant: String },
  emits: ['click'],
  setup(props, { attrs, emit, slots }) {
    return () =>
      h(
        'button',
        { ...attrs, 'data-variant': props.variant, onClick: () => emit('click') },
        slots.default?.(),
      );
  },
});

function mountDialog() {
  return mount(ChunkLoadRecoveryDialog, {
    attachTo: document.body,
    global: { stubs: { CButton: CButtonStub } },
  });
}

describe('ChunkLoadRecoveryDialog', () => {
  beforeEach(() => {
    failure.value = null;
    retryReload.mockReset();
    stayOnCurrentPage.mockReset();
  });

  it('没有失败时不渲染对话框', () => {
    const wrapper = mountDialog();
    expect(document.body.querySelector('.chunk-load-error-screen')).toBeNull();
    wrapper.unmount();
  });

  it('初始页面未成功加载时只提供重新加载', async () => {
    const wrapper = mountDialog();
    failure.value = { canStay: false };
    await wrapper.vm.$nextTick();

    const screen = document.body.querySelector<HTMLElement>('.chunk-load-error-screen')!;
    expect(screen.getAttribute('role')).toBe('alertdialog');
    expect(screen.textContent).toContain('页面资源加载失败');
    expect(screen.textContent).not.toContain('留在当前页');
    const retry = screen.querySelector<HTMLButtonElement>('button')!;
    expect(document.activeElement).toBe(retry);

    retry.click();
    expect(retryReload).toHaveBeenCalledOnce();
  });

  it('已有可用页面时允许留在当前页或重新加载', async () => {
    failure.value = { canStay: true };
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    const buttons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.chunk-load-error-screen button'),
    );

    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['留在当前页', '重新加载']);
    buttons[0].click();
    buttons[1].click();
    expect(stayOnCurrentPage).toHaveBeenCalledOnce();
    expect(retryReload).toHaveBeenCalledOnce();
  });

  it('状态清除和组件卸载都会释放模态浮层', async () => {
    failure.value = { canStay: true };
    const wrapper = mountDialog();
    await wrapper.vm.$nextTick();
    expect(document.body.style.overflow).toBe('hidden');

    failure.value = null;
    await wrapper.vm.$nextTick();
    expect(document.body.style.overflow).toBe('');

    failure.value = { canStay: true };
    await wrapper.vm.$nextTick();
    wrapper.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('位于已有模态浮层之上并保持焦点约束', async () => {
    const lowerOverlay = document.createElement('section');
    const lowerButton = document.createElement('button');
    lowerOverlay.append(lowerButton);
    document.body.append(lowerOverlay);
    const unregisterLower = registerOverlay({
      elements: [lowerOverlay],
      focusRoot: lowerOverlay,
      modal: true,
    });
    const wrapper = mountDialog();

    failure.value = { canStay: true };
    await wrapper.vm.$nextTick();
    const screen = document.body.querySelector<HTMLElement>('.chunk-load-error-screen')!;
    const stay = screen.querySelector<HTMLButtonElement>('button')!;
    expect(lowerOverlay.inert).toBe(true);
    expect(screen.inert).not.toBe(true);
    expect(document.activeElement).toBe(stay);

    lowerButton.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(stay);

    wrapper.unmount();
    expect(lowerOverlay.inert).toBe(false);
    unregisterLower();
    lowerOverlay.remove();
  });
});
