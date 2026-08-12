import { defineComponent, markRaw, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CActionMenu from '../components/ui/CActionMenu.vue';
import CTooltip from '../components/ui/CTooltip.vue';

const IconStub = markRaw(defineComponent({ template: '<svg class="item-icon" />' }));

function panel(): HTMLElement | null {
  return document.body.querySelector('.c-action-menu-panel');
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function mountMenu(overrides: Record<string, unknown> = {}) {
  return mount(CActionMenu, {
    attachTo: document.body,
    props: {
      items: [
        { key: 'disabled', label: '禁用操作', disabled: true, title: '当前不可用' },
        { key: 'normal', label: '普通操作', icon: IconStub },
        {
          key: 'danger',
          label: '危险操作',
          danger: true,
          separatorBefore: true,
        },
        {
          key: 'loading',
          label: '加载操作',
          loading: true,
        },
      ],
      ...overrides,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CActionMenu', () => {
  it('用 ellipsis 触发并渲染带图标、名称、状态和分隔线的菜单项', async () => {
    const wrapper = mountMenu();
    const trigger = wrapper.get('[aria-label="更多操作"]');

    expect(trigger.attributes('aria-haspopup')).toBe('menu');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.find('.lucide-ellipsis').exists()).toBe(true);
    expect(trigger.classes()).toContain('rounded-md');
    expect(trigger.classes()).not.toContain('rounded-full');
    await trigger.trigger('click');
    await nextTick();

    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(panel()?.getAttribute('role')).toBe('menu');
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual([
      '禁用操作',
      '普通操作',
      '危险操作',
      '加载操作',
    ]);
    expect(menuItems()[0].disabled).toBe(true);
    expect(menuItems()[0].getAttribute('title')).toBeNull();
    const tooltips = wrapper.findAllComponents(CTooltip);
    expect(tooltips).toHaveLength(1);
    expect(tooltips[0].props('content')).toBe('当前不可用');
    expect(menuItems()[1].querySelector('.item-icon')).not.toBeNull();
    expect(menuItems()[2].className).toContain('border-t');
    expect(menuItems()[2].className).toContain('text-error-600');
    expect(menuItems()[3].querySelector('[role="status"]')).not.toBeNull();

    menuItems()[1].click();
    await nextTick();
    expect(wrapper.emitted('select')).toEqual([['normal']]);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it('支持触发器和菜单内完整键盘导航', async () => {
    const wrapper = mountMenu();
    const trigger = wrapper.get<HTMLButtonElement>('[aria-label="更多操作"]');

    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(document.activeElement).toBe(menuItems()[1]);

    menuItems()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menuItems()[2]);
    menuItems()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menuItems()[1]);
    menuItems()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(menuItems()[2]);
    menuItems()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(menuItems()[1]);
    menuItems()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(menuItems()[2]);

    menuItems()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);

    await trigger.trigger('keydown', { key: 'ArrowUp' });
    await nextTick();
    expect(document.activeElement).toBe(menuItems()[2]);
    menuItems()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await nextTick();
    expect(panel()).toBeNull();

    await trigger.trigger('keydown', { key: 'Enter' });
    await nextTick();
    expect(panel()).not.toBeNull();
    menuItems()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(panel()).not.toBeNull();
    wrapper.unmount();
  });

  it('签到说明使用自定义多行 Tooltip 而非系统 title', async () => {
    vi.useFakeTimers();
    const wrapper = mountMenu({
      items: [
        {
          key: 'checkin',
          label: '签到',
          disabled: true,
          title: '签到时间：2026/8/12 09:30\n获得积分：100',
        },
      ],
    });
    await wrapper.get('[aria-label="更多操作"]').trigger('click');
    await nextTick();

    const tooltip = wrapper.getComponent(CTooltip);
    expect(menuItems()[0].getAttribute('title')).toBeNull();
    await tooltip.trigger('mouseenter');
    vi.advanceTimersByTime(300);
    await flushPromises();

    const popover = document.body.querySelector('.c-tooltip-popover');
    expect(popover).not.toBeNull();
    expect(Array.from(popover!.querySelectorAll('span')).map((line) => line.textContent)).toEqual([
      '签到时间：2026/8/12 09:30获得积分：100',
      '签到时间：2026/8/12 09:30',
      '获得积分：100',
    ]);

    await tooltip.trigger('mouseleave');
    await flushPromises();
    expect(document.body.querySelector('.c-tooltip-popover')).toBeNull();
    wrapper.unmount();
  });

  it('鼠标打开菜单不会提前显示签到 Tooltip，实际移入后移出即隐藏', async () => {
    vi.useFakeTimers();
    const wrapper = mountMenu({
      items: [{ key: 'checkin', label: '签到', title: '签到详情' }],
    });

    await wrapper.get('[aria-label="更多操作"]').trigger('click');
    await nextTick();
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(document.body.querySelector('.c-tooltip-popover')).toBeNull();

    const tooltip = wrapper.getComponent(CTooltip);
    await tooltip.trigger('mouseenter');
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(document.body.querySelector('.c-tooltip-popover')?.textContent).toBe('签到详情');

    await tooltip.trigger('mouseleave');
    await flushPromises();
    expect(document.body.querySelector('.c-tooltip-popover')).toBeNull();
    wrapper.unmount();
  });

  it('鼠标打开且焦点未进入菜单时仍可用 Escape 关闭', async () => {
    const wrapper = mountMenu();
    const trigger = wrapper.get<HTMLButtonElement>('[aria-label="更多操作"]');

    await trigger.trigger('click');
    await nextTick();
    expect(panel()).not.toBeNull();
    expect(document.activeElement).not.toBe(menuItems()[1]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(panel()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();

    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it('处理外部点击、属性禁用、全禁用菜单和卸载清理', async () => {
    const wrapper = mountMenu();
    const trigger = wrapper.get<HTMLButtonElement>('[aria-label="更多操作"]');
    await trigger.trigger('click');
    await nextTick();

    trigger.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(panel()).toBeNull();
    await trigger.trigger('click');
    await nextTick();
    panel()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(panel()).toBeNull();

    await trigger.trigger('click');
    await wrapper.setProps({ disabled: true });
    expect(panel()).toBeNull();
    expect(trigger.attributes('disabled')).toBeDefined();

    await wrapper.setProps({
      disabled: false,
      items: [{ key: 'only', label: '唯一操作', disabled: true }],
    });
    await trigger.trigger('keydown', { key: ' ' });
    await nextTick();
    expect(document.activeElement).toBe(panel());
    wrapper.unmount();
    document.body.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
  });

  it('根据视口空间在触发器上下方定位并响应滚动', async () => {
    const wrapper = mountMenu({ items: [{ key: 'one', label: '操作' }] });
    const trigger = wrapper.get<HTMLElement>('[aria-label="更多操作"]');
    let triggerRect = {
      left: 300,
      right: 340,
      top: 700,
      bottom: 740,
      width: 40,
      height: 40,
      x: 300,
      y: 700,
      toJSON: () => ({}),
    };
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('c-action-menu-trigger')) return triggerRect;
      if (this.classList.contains('c-action-menu-panel')) {
        return {
          left: 0,
          right: 200,
          top: 0,
          bottom: 160,
          width: 200,
          height: 160,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      }
      return original.call(this);
    });

    await trigger.trigger('click');
    await nextTick();
    expect(panel()?.style.left).toBe('140px');
    expect(panel()?.style.top).toBe('532px');

    triggerRect = {
      left: -20,
      right: 20,
      top: 20,
      bottom: 60,
      width: 40,
      height: 40,
      x: -20,
      y: 20,
      toJSON: () => ({}),
    };
    window.dispatchEvent(new Event('scroll'));
    (wrapper.vm.$ as any).setupState.updatePosition();
    await nextTick();
    expect(panel()?.style.left).toBe('8px');
    expect(panel()?.style.top).toBe('68px');
    wrapper.unmount();
  });

  it('覆盖关闭态、受阻打开和不可选择项的边界路径', async () => {
    const wrapper = mountMenu();
    const trigger = wrapper.get<HTMLButtonElement>('[aria-label="更多操作"]');
    const state = (wrapper.vm.$ as any).setupState;

    expect(state.enabledItems()).toEqual([]);
    state.close();
    state.updatePosition();
    state.onDocumentClick({ target: {} } as MouseEvent);
    await trigger.trigger('keydown', { key: 'x' });
    expect(panel()).toBeNull();

    await wrapper.setProps({ disabled: true });
    await state.open();
    expect(panel()).toBeNull();
    await wrapper.setProps({ disabled: false, loading: true });
    expect(trigger.find('[role="status"]').exists()).toBe(true);
    await state.open();
    expect(panel()).toBeNull();

    await wrapper.setProps({ loading: false });
    const pendingOpen = state.open();
    state.close(false);
    await pendingOpen;
    expect(panel()).toBeNull();

    state.select({ key: 'disabled', label: '禁用', disabled: true });
    state.select({ key: 'loading', label: '加载', loading: true });
    expect(wrapper.emitted('select')).toBeUndefined();

    await wrapper.setProps({ items: [{ key: 'only', label: '唯一操作', disabled: true }] });
    await trigger.trigger('click');
    await nextTick();
    panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).not.toBe(panel());
    expect(panel()).not.toBeNull();
    wrapper.unmount();
  });
});
