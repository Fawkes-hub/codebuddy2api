import { describe, expect, it } from 'vitest';

import { createHashedAssetFileName, rewriteThemeInitAssetUrl } from '../../vite.config';

describe('Vite 静态资源配置', () => {
  it('根据内容生成稳定且可失效的主题脚本文件名', () => {
    const first = createHashedAssetFileName('theme-init', 'js', 'first');

    expect(first).toMatch(/^assets\/theme-init-[a-f0-9]{12}\.js$/);
    expect(createHashedAssetFileName('theme-init', 'js', 'first')).toBe(first);
    expect(createHashedAssetFileName('theme-init', 'js', 'second')).not.toBe(first);
  });

  it('只替换唯一的主题初始化脚本引用', () => {
    const source = '<script src="/src/theme-init.js"></script>';

    expect(rewriteThemeInitAssetUrl(source, 'assets/theme-init-0123456789ab.js')).toBe(
      '<script src="/assets/theme-init-0123456789ab.js"></script>',
    );
    expect(() => rewriteThemeInitAssetUrl('<main></main>', 'assets/theme-init-hash.js')).toThrow(
      '主题初始化脚本引用必须恰好出现一次',
    );
    expect(() =>
      rewriteThemeInitAssetUrl(`${source}${source}`, 'assets/theme-init-hash.js'),
    ).toThrow('主题初始化脚本引用必须恰好出现一次');
  });
});
