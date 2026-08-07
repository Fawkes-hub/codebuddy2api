import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appMock,
  toastMock,
  queryClientOptions,
  queryCacheOptions,
  mutationCacheOptions,
  unauthorizedErrorMock,
  chunkLoadRecoveryMock,
} = vi.hoisted(() => ({
  appMock: {
    component: vi.fn<(name: string, component?: unknown) => unknown>(),
    use: vi.fn<(plugin: unknown, ...options: unknown[]) => unknown>(),
    mount: vi.fn<(rootContainer: string) => unknown>(),
  },
  toastMock: { error: vi.fn<(message: string, duration?: number) => void>() },
  queryClientOptions: [] as unknown[],
  queryCacheOptions: [] as Array<{ onError: (error: unknown) => void }>,
  mutationCacheOptions: [] as Array<{ onError: (error: unknown) => void }>,
  unauthorizedErrorMock: vi.fn<(error: unknown) => boolean>(),
  chunkLoadRecoveryMock: {
    install:
      vi.fn<
        (
          router: unknown,
          options: { onUnexpectedNavigationError: (error: unknown) => void },
        ) => () => void
      >(),
  },
}));

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return { ...actual, createApp: () => appMock };
});

vi.mock('pinia', () => ({
  createPinia: () => 'pinia-plugin',
}));

vi.mock('../composables/useToast', () => ({
  useToast: () => toastMock,
}));

vi.mock('@tanstack/vue-query', () => ({
  VueQueryPlugin: 'vue-query-plugin',
  QueryClient: class {
    constructor(options: unknown) {
      queryClientOptions.push(options);
    }
  },
  QueryCache: class {
    constructor(options: { onError: (error: unknown) => void }) {
      queryCacheOptions.push(options);
    }
  },
  MutationCache: class {
    constructor(options: { onError: (error: unknown) => void }) {
      mutationCacheOptions.push(options);
    }
  },
}));

vi.mock('../router', () => ({ default: 'router-plugin' }));
vi.mock('../App.vue', () => ({ default: {} }));
vi.mock('../api/client', () => ({
  isUnauthorizedError: unauthorizedErrorMock,
}));

vi.mock('../utils/chunkLoadRecovery', () => ({
  chunkLoadRecovery: chunkLoadRecoveryMock,
}));

describe('main', () => {
  beforeEach(async () => {
    vi.resetModules();
    appMock.component.mockReset();
    appMock.use.mockReset();
    appMock.mount.mockReset();
    appMock.use.mockReturnValue(appMock);
    appMock.mount.mockReturnValue(appMock);
    toastMock.error.mockReset();
    queryClientOptions.length = 0;
    queryCacheOptions.length = 0;
    mutationCacheOptions.length = 0;
    unauthorizedErrorMock.mockReset();
    chunkLoadRecoveryMock.install.mockReset();
    chunkLoadRecoveryMock.install.mockReturnValue(vi.fn());

    await import('../main');
  });

  it('注册 Pinia、路由、VueQuery 插件并挂载应用', () => {
    expect(appMock.use.mock.calls).toEqual([
      ['pinia-plugin'],
      ['router-plugin'],
      ['vue-query-plugin', { queryClient: expect.any(Object) }],
    ]);
    expect(appMock.mount).toHaveBeenCalledWith('#app');
    expect(chunkLoadRecoveryMock.install).toHaveBeenCalledWith('router-plugin', {
      onUnexpectedNavigationError: expect.any(Function),
    });
    expect(appMock.use.mock.invocationCallOrder[0]).toBeLessThan(
      chunkLoadRecoveryMock.install.mock.invocationCallOrder[0],
    );
    expect(chunkLoadRecoveryMock.install.mock.invocationCallOrder[0]).toBeLessThan(
      appMock.use.mock.invocationCallOrder[1],
    );
    expect(queryClientOptions).toHaveLength(1);
    expect(queryClientOptions[0]).toEqual(
      expect.objectContaining({
        defaultOptions: {
          queries: expect.objectContaining({
            networkMode: 'always',
            refetchOnReconnect: false,
          }),
          mutations: expect.objectContaining({ networkMode: 'always' }),
        },
      }),
    );
  });

  it('非 chunk 路由错误保留控制台错误并显示通用提示', () => {
    const error = new Error('路由守卫异常');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const options = chunkLoadRecoveryMock.install.mock.calls[0][1];

    options.onUnexpectedNavigationError(error);

    expect(consoleError).toHaveBeenCalledWith(error);
    expect(toastMock.error).toHaveBeenCalledWith('页面跳转失败，请重试');
    consoleError.mockRestore();
  });

  it('查询缓存按错误类型提示', () => {
    unauthorizedErrorMock.mockReturnValueOnce(true).mockReturnValue(false);
    const onError = queryCacheOptions[0].onError;

    onError(new Error('unauthorized'));
    expect(toastMock.error).not.toHaveBeenCalled();
    onError(new Error('query failed'));
    onError('bad');

    expect(toastMock.error.mock.calls).toEqual([['query failed'], ['查询失败']]);
  });

  it('mutation 缓存按错误类型提示', () => {
    unauthorizedErrorMock.mockReturnValueOnce(true).mockReturnValue(false);
    const onError = mutationCacheOptions[0].onError;

    onError(new Error('unauthorized'));
    expect(toastMock.error).not.toHaveBeenCalled();
    onError(new Error('mutation failed'));
    onError('bad');

    expect(toastMock.error.mock.calls).toEqual([['mutation failed'], ['操作失败']]);
  });
});
