import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerOverlay } from '../components/ui/overlayStack';

describe('overlayStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
    document.documentElement.style.removeProperty('--page-scrollbar-compensation');
  });

  it('隔离并恢复页面、无焦点控件时聚焦容器，且注销幂等', async () => {
    document.body.style.overflow = 'scroll';
    const opener = document.createElement('button');
    const background = document.createElement('main');
    background.setAttribute('aria-hidden', 'legacy');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const root = document.createElement('section');
    root.tabIndex = -1;
    document.body.append(opener, background, svg, root);
    opener.focus();
    const onEscape = vi.fn<() => void>();
    const unregister = registerOverlay({
      elements: [root],
      focusRoot: root,
      modal: true,
      onEscape,
    });

    expect(document.body.style.overflow).toBe('hidden');
    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(document.activeElement).toBe(root);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(root);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledOnce();

    unregister();
    unregister();
    await Promise.resolve();
    expect(document.body.style.overflow).toBe('scroll');
    expect(background.inert).toBe(false);
    expect(background.getAttribute('aria-hidden')).toBe('legacy');
    expect(document.activeElement).toBe(opener);
  });

  it('只捕获顶层键盘，并覆盖中间焦点移动、非顶层注销和失效恢复点', async () => {
    const lower = document.createElement('section');
    const lowerButton = document.createElement('button');
    lower.append(lowerButton);
    const upper = document.createElement('section');
    const buttons = Array.from({ length: 3 }, () => document.createElement('button'));
    upper.append(...buttons);
    document.body.append(lower, upper);
    lowerButton.focus();
    const unregisterLower = registerOverlay({
      elements: [lower],
      focusRoot: lower,
      modal: false,
    });
    const unregisterUpper = registerOverlay({
      elements: [upper],
      focusRoot: upper,
      modal: false,
    });

    buttons[0].focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);
    buttons[2].focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    unregisterLower();
    lower.remove();
    unregisterUpper();
    await Promise.resolve();
    expect(document.body.style.overflow).toBe('');
  });

  it('活动元素不是 HTMLElement 时不保存恢复点', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const root = document.createElement('section');
    root.tabIndex = -1;
    document.body.append(svg, root);
    const activeSpy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(svg);
    const unregister = registerOverlay({ elements: [root], focusRoot: root, modal: false });
    activeSpy.mockRestore();
    expect(() => unregister()).not.toThrow();
  });

  it('稳定滚动条槽存在时不重复补偿，嵌套浮层并完整恢复原样式', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(
      window.innerWidth - 16,
    );
    document.body.style.paddingRight = '12px';
    const lower = document.createElement('section');
    const upper = document.createElement('section');
    lower.tabIndex = -1;
    upper.tabIndex = -1;
    document.body.append(lower, upper);

    const unregisterLower = registerOverlay({ elements: [lower], focusRoot: lower, modal: true });
    const lowerPadding = document.body.style.paddingRight;

    const unregisterUpper = registerOverlay({ elements: [upper], focusRoot: upper, modal: true });
    const upperPadding = document.body.style.paddingRight;

    unregisterUpper();
    const afterUpperPadding = document.body.style.paddingRight;
    unregisterLower();

    expect([lowerPadding, upperPadding, afterUpperPadding]).toEqual(['12px', '12px', '12px']);
    expect(document.body.style.paddingRight).toBe('12px');
  });

  it('隐藏滚动条后视口确实扩张时仅补偿一次', () => {
    const clientWidth = vi
      .spyOn(document.documentElement, 'clientWidth', 'get')
      .mockImplementation(() =>
        document.body.style.overflow === 'hidden' ? window.innerWidth : window.innerWidth - 16,
      );
    document.body.style.paddingRight = '12px';
    document.documentElement.style.setProperty('--page-scrollbar-compensation', '3px');
    const lower = document.createElement('section');
    const upper = document.createElement('section');
    lower.tabIndex = -1;
    upper.tabIndex = -1;
    document.body.append(lower, upper);

    const unregisterLower = registerOverlay({ elements: [lower], focusRoot: lower, modal: true });
    const lowerPadding = document.body.style.paddingRight;
    const lowerFixedCompensation = document.documentElement.style.getPropertyValue(
      '--page-scrollbar-compensation',
    );
    const unregisterUpper = registerOverlay({ elements: [upper], focusRoot: upper, modal: true });
    const upperPadding = document.body.style.paddingRight;
    const upperFixedCompensation = document.documentElement.style.getPropertyValue(
      '--page-scrollbar-compensation',
    );

    unregisterUpper();
    unregisterLower();

    expect(clientWidth).toHaveBeenCalledTimes(2);
    expect([lowerPadding, upperPadding]).toEqual(['28px', '28px']);
    expect([lowerFixedCompensation, upperFixedCompensation]).toEqual(['16px', '16px']);
    expect(document.body.style.paddingRight).toBe('12px');
    expect(document.documentElement.style.getPropertyValue('--page-scrollbar-compensation')).toBe(
      '3px',
    );
  });

  it('补偿滚动条宽度时以零处理空右内边距', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() =>
      document.body.style.overflow === 'hidden' ? window.innerWidth : window.innerWidth - 16,
    );
    const root = document.createElement('section');
    root.tabIndex = -1;
    document.body.append(root);

    const unregister = registerOverlay({ elements: [root], focusRoot: root, modal: true });
    const lockedPadding = document.body.style.paddingRight;
    unregister();

    expect(lockedPadding).toBe('16px');
    expect(document.body.style.paddingRight).toBe('');
  });

  it('没有传统滚动条时不添加额外补偿', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(window.innerWidth);
    const root = document.createElement('section');
    root.tabIndex = -1;
    document.body.append(root);

    const unregister = registerOverlay({ elements: [root], focusRoot: root, modal: true });
    expect(document.body.style.paddingRight).toBe('');
    expect(document.documentElement.style.getPropertyValue('--page-scrollbar-compensation')).toBe(
      '0px',
    );
    unregister();
  });
});
