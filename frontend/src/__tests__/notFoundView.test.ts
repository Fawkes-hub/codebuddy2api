import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn<(location: unknown) => Promise<void>>(),
}));

vi.mock('../utils/chunkLoadRecovery', () => ({
  chunkLoadRecovery: { push: pushMock },
}));

import NotFoundView from '../views/NotFoundView.vue';

describe('NotFoundView', () => {
  beforeEach(() => {
    pushMock.mockReset().mockResolvedValue();
  });

  it('说明路由不存在并通过 chunk 恢复器返回总览', async () => {
    const wrapper = mount(NotFoundView);

    expect(wrapper.text()).toContain('页面不存在');
    expect(wrapper.find('a').exists()).toBe(false);
    expect(wrapper.get('button').attributes('type')).toBe('button');

    await wrapper.get('button').trigger('click');

    expect(pushMock).toHaveBeenCalledOnce();
    expect(pushMock).toHaveBeenCalledWith({ name: 'dashboard' });
  });
});
