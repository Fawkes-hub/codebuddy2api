import type { RouteComponent, RouteLocationRaw, Router } from 'vue-router';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChunkLoadRecovery } from '../utils/chunkLoadRecovery';

const RECOVERY_STORAGE_KEY = 'codebuddy2api:chunk-reload-attempted';

function recoveryRecord(target: string, mode: 'push' | 'replace' = 'push'): string {
  return JSON.stringify({ version: 1, target, mode });
}

function dispatchPreloadError(error = new Error('chunk 加载失败')): VitePreloadErrorEvent {
  const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), {
    payload: error,
  });
  window.dispatchEvent(event);
  return event;
}

function failingRoute(error: Error, preload = true): () => Promise<RouteComponent> {
  return () =>
    Promise.reject(error).catch((reason: Error) => {
      if (preload) dispatchPreloadError(reason);
      throw reason;
    });
}

function deferredRoute() {
  let resolve!: (component: RouteComponent) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RouteComponent>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { loader: vi.fn<() => Promise<RouteComponent>>(() => promise), promise, reject, resolve };
}

function makeRouter(extraRoutes: Parameters<typeof createRouter>[0]['routes']): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/source', component: {} }, ...extraRoutes],
  });
}

describe('chunk 页面加载恢复', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    sessionStorage.clear();
    vi.useRealTimers();
  });

  function install(
    recovery: ReturnType<typeof createChunkLoadRecovery>,
    router: Router,
    onUnexpectedNavigationError = vi.fn<(error: unknown) => void>(),
  ) {
    cleanups.push(recovery.install(router, { onUnexpectedNavigationError }));
    return onUnexpectedNavigationError;
  }

  it('显式 push 的首次 chunk 失败保留原始错误并只触发一次自动刷新', async () => {
    const error = new Error('旧版本 chunk 不存在');
    const events: VitePreloadErrorEvent[] = [];
    const loader = () =>
      Promise.reject(error).catch((reason: Error) => {
        events.push(dispatchPreloadError(reason));
        throw reason;
      });
    const router = makeRouter([{ path: '/target', component: loader }]);
    const originalPush = router.push;
    const originalReplace = router.replace;
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    const report = install(recovery, router);
    await router.push('/source');

    await expect(recovery.push('/target')).resolves.toBeUndefined();
    await expect(recovery.push('/target')).resolves.toBeUndefined();

    expect(events).toHaveLength(2);
    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target', 'push'));
    expect(report).not.toHaveBeenCalled();
    expect(router.push).toBe(originalPush);
    expect(router.replace).toBe(originalReplace);
  });

  it('非路由动态导入失败不触发恢复且原 Promise 继续拒绝', async () => {
    const error = new Error('普通动态导入失败');
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    const router = makeRouter([]);
    const report = install(recovery, router);

    let preloadEvent: VitePreloadErrorEvent | undefined;
    const load = Promise.reject(error).catch((reason: Error) => {
      preloadEvent = dispatchPreloadError(reason);
      throw reason;
    });

    await expect(load).rejects.toBe(error);
    expect(preloadEvent?.defaultPrevented).toBe(false);
    expect(recovery.failure.value).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('非 chunk 路由错误通知调用方并以原始错误拒绝导航', async () => {
    const error = new Error('路由组件代码错误');
    const router = makeRouter([{ path: '/broken', component: failingRoute(error, false) }]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    const report = install(recovery, router);
    await router.push('/source');

    await expect(recovery.push('/broken')).rejects.toBe(error);

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(error);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(recovery.failure.value).toBeNull();
  });

  it('错误通知回调自身失败时仍保留原始导航错误', async () => {
    const error = new Error('原始路由错误');
    const reportingError = new Error('错误提示失败');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = makeRouter([{ path: '/broken', component: failingRoute(error, false) }]);
    const recovery = createChunkLoadRecovery();
    cleanups.push(
      recovery.install(router, {
        onUnexpectedNavigationError: () => {
          throw reportingError;
        },
      }),
    );
    await router.push('/source');

    await expect(recovery.push('/broken')).rejects.toBe(error);
    expect(consoleError).toHaveBeenCalledWith(reportingError);
    consoleError.mockRestore();
  });

  it('同步解析或导航错误同样通知调用方并原样抛出', async () => {
    const resolveError = new Error('路由参数无效');
    const pushError = new Error('路由调用失败');
    const router = makeRouter([]);
    const originalResolve = router.resolve;
    const originalPush = router.push;
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    const report = install(recovery, router);

    router.resolve = vi.fn<Router['resolve']>(() => {
      throw resolveError;
    });
    expect(() => recovery.push('/broken')).toThrow(resolveError);

    router.resolve = originalResolve;
    router.push = vi.fn<Router['push']>(() => {
      throw pushError;
    });
    expect(() => recovery.push('/broken')).toThrow(pushError);

    router.push = originalPush;
    expect(report.mock.calls).toEqual([[resolveError], [pushError]]);
  });

  async function recoverAcrossReload(method: 'push' | 'replace') {
    const firstRouter = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const firstRecovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(firstRecovery, firstRouter);
    await firstRouter.push('/source');
    await expect(firstRecovery[method]('/target')).resolves.toBeUndefined();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target', method));
    cleanups.pop()!();

    const secondRouter = makeRouter([{ path: '/target', component: {} }]);
    const push = vi.spyOn(secondRouter, 'push');
    const replace = vi.spyOn(secondRouter, 'replace');
    const secondRecovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(secondRecovery, secondRouter);
    await secondRouter.push('/source');
    await vi.waitFor(() => expect(secondRouter.currentRoute.value.fullPath).toBe('/target'));

    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    return { push, replace };
  }

  it('刷新后按原 push 模式自动续接目标', async () => {
    const { push, replace } = await recoverAcrossReload('push');
    expect(push).toHaveBeenCalledWith('/target');
    expect(replace).not.toHaveBeenCalled();
  });

  it('刷新后按原 replace 模式自动续接目标', async () => {
    const { replace } = await recoverAcrossReload('replace');
    expect(replace).toHaveBeenCalledWith('/target');
  });

  it('push 中显式 replace 选项按 replace 语义续接', async () => {
    const router = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(recovery, router);
    await router.push('/source');

    await recovery.push({ path: '/target', replace: true });

    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target', 'replace'));
  });

  it('初始或浏览器历史导航缺少显式意图时使用 replace 语义', async () => {
    const error = new Error('初始 chunk 不存在');
    const router = makeRouter([{ path: '/target', component: failingRoute(error) }]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);

    await expect(router.push('/target')).rejects.toBe(error);

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target', 'replace'));
  });

  it('续接成功、重定向或守卫中止都会消费恢复记录', async () => {
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/legacy', 'replace'));
    const redirectRouter = makeRouter([
      { path: '/legacy', redirect: '/target' },
      { path: '/target', component: {} },
    ]);
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(recovery, redirectRouter);
    await redirectRouter.push('/source');
    await vi.waitFor(() => expect(redirectRouter.currentRoute.value.fullPath).toBe('/target'));
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    cleanups.pop()!();

    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/blocked'));
    const blockedRouter = makeRouter([{ path: '/blocked', component: {} }]);
    blockedRouter.beforeEach((to) => (to.fullPath === '/blocked' ? false : undefined));
    const blockedRecovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(blockedRecovery, blockedRouter);
    await blockedRouter.push('/source');
    await vi.waitFor(() => expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull());
    expect(blockedRouter.currentRoute.value.fullPath).toBe('/source');
  });

  it('刷新后来源路由被中止或已经到达目标时不再续接', async () => {
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const blockedRouter = makeRouter([{ path: '/target', component: {} }]);
    blockedRouter.beforeEach((to) => (to.fullPath === '/source' ? false : undefined));
    const blockedRecovery = createChunkLoadRecovery();
    install(blockedRecovery, blockedRouter);

    await blockedRouter.push('/source');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    cleanups.pop()!();

    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/source', 'replace'));
    const reachedRouter = makeRouter([]);
    const replace = vi.spyOn(reachedRouter, 'replace');
    const reachedRecovery = createChunkLoadRecovery();
    install(reachedRecovery, reachedRouter);
    await reachedRouter.push('/source');

    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('自动续接发生非 chunk 错误时报告错误并消费记录', async () => {
    const error = new Error('新版页面代码错误');
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const router = makeRouter([{ path: '/target', component: failingRoute(error, false) }]);
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    const report = install(recovery, router);

    await router.push('/source');
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(error));

    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
  });

  it('自动续接同步抛错时报告错误并消费记录', async () => {
    const error = new Error('路由同步失败');
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const router = makeRouter([{ path: '/target', component: {} }]);
    const originalPush = router.push;
    router.push = vi.fn<Router['push']>((to: RouteLocationRaw) => {
      if (to === '/target') throw error;
      return originalPush.call(router, to);
    });
    const recovery = createChunkLoadRecovery();
    const report = install(recovery, router);

    await router.push('/source');

    expect(report).toHaveBeenCalledWith(error);
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('更新的显式导航取代自动续接且旧 chunk 失败不会拉回旧目标', async () => {
    const deferred = deferredRoute();
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const router = makeRouter([
      { path: '/target', component: deferred.loader },
      { path: '/new-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');
    await vi.waitFor(() => expect(deferred.loader).toHaveBeenCalledOnce());

    await recovery.push('/new-target');
    const staleError = new Error('被取代的旧 chunk 失败');
    dispatchPreloadError(staleError);
    deferred.reject(staleError);
    await deferred.promise.catch(() => undefined);

    expect(router.currentRoute.value.fullPath).toBe('/new-target');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(recovery.failure.value).toBeNull();
  });

  it('被取代的自动续接发生普通错误时只报告错误，不恢复旧目标', async () => {
    const deferred = deferredRoute();
    const staleError = new Error('被取代页面的代码错误');
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const router = makeRouter([
      { path: '/target', component: deferred.loader },
      { path: '/new-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    const report = install(recovery, router);
    await router.push('/source');
    await vi.waitFor(() => expect(deferred.loader).toHaveBeenCalledOnce());

    await recovery.push('/new-target');
    deferred.reject(staleError);
    await deferred.promise.catch(() => undefined);
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(staleError));

    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe('/new-target');
  });

  it('浏览器历史导航同样能取代尚未完成的自动续接', async () => {
    const deferred = deferredRoute();
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const router = makeRouter([
      { path: '/target', component: deferred.loader },
      { path: '/history-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');
    await vi.waitFor(() => expect(deferred.loader).toHaveBeenCalledOnce());

    await router.push('/history-target');
    const staleError = new Error('旧目标 chunk 失败');
    dispatchPreloadError(staleError);
    deferred.reject(staleError);
    await deferred.promise.catch(() => undefined);

    expect(router.currentRoute.value.fullPath).toBe('/history-target');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('浏览器历史导航能取代尚未完成的普通主动导航', async () => {
    const deferred = deferredRoute();
    const router = makeRouter([
      { path: '/target', component: deferred.loader },
      { path: '/history-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');

    const abandonedNavigation = recovery.push('/target');
    await vi.waitFor(() => expect(deferred.loader).toHaveBeenCalledOnce());
    await router.push('/history-target');

    const staleError = new Error('被历史导航取代的旧 chunk 失败');
    dispatchPreloadError(staleError);
    deferred.reject(staleError);
    await expect(abandonedNavigation).resolves.toBeUndefined();

    expect(router.currentRoute.value.fullPath).toBe('/history-target');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(recovery.failure.value).toBeNull();
  });

  it('自动刷新后的重复 chunk 失败停止循环并允许留在来源页', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const router = makeRouter([
      { path: '/target', component: failingRoute(new Error('仍然失败')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);

    await router.push('/source');
    await vi.waitFor(() => expect(recovery.failure.value).toEqual({ canStay: true }));

    expect(reloadPage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toEqual({ canStay: true });
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target'));
    recovery.stayOnCurrentPage();
    expect(recovery.failure.value).toBeNull();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('带恢复记录直接着陆目标且新版 chunk 仍缺失时不会再次自动刷新', async () => {
    vi.useFakeTimers();
    const error = new Error('新版着陆 chunk 仍然缺失');
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target', 'replace'));
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/target', component: failingRoute(error) }],
    });
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);

    await expect(router.push('/target')).rejects.toBe(error);

    expect(reloadPage).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(recovery.failure.value).toEqual({ canStay: false });
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target', 'replace'));
  });

  it('留在当前页后同一文档的后续 chunk 失败只显示手动恢复入口', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/first', component: failingRoute(new Error('first')) },
      { path: '/second', component: failingRoute(new Error('second')) },
      { path: '/third', component: failingRoute(new Error('third')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/first');
    expect(reloadPage).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toEqual({ canStay: true });
    recovery.stayOnCurrentPage();

    await recovery.push('/second');
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(recovery.failure.value).toEqual({ canStay: true });

    await recovery.push('/source');
    expect(recovery.failure.value).toBeNull();
    await recovery.push('/third');
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(recovery.failure.value).toEqual({ canStay: true });

    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledTimes(2);
    vi.runOnlyPendingTimers();
    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledTimes(3);
  });

  it('初始路由失败时不能留在尚未成功加载的页面', async () => {
    vi.useFakeTimers();
    const error = new Error('初始路由失败');
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: failingRoute(error) }],
    });
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(recovery, router);

    await expect(router.push('/')).rejects.toBe(error);
    vi.runOnlyPendingTimers();

    expect(recovery.failure.value).toEqual({ canStay: false });
    recovery.stayOnCurrentPage();
    expect(recovery.failure.value).toEqual({ canStay: false });
  });

  it('刷新发生 pagehide 时不误报为刷新被取消', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');
    window.dispatchEvent(new Event('pagehide'));
    vi.runOnlyPendingTimers();

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(recovery.failure.value).toBeNull();
    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('刷新同步触发 pagehide 或抛错时均保持确定状态', async () => {
    vi.useFakeTimers();
    const firstRouter = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const firstRecovery = createChunkLoadRecovery({
      reloadPage: () => window.dispatchEvent(new Event('pagehide')),
    });
    install(firstRecovery, firstRouter);
    await firstRouter.push('/source');
    await firstRecovery.push('/target');
    vi.runOnlyPendingTimers();
    expect(firstRecovery.failure.value).toBeNull();
    cleanups.pop()!();
    sessionStorage.clear();

    const secondRouter = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const secondRecovery = createChunkLoadRecovery({
      reloadPage: () => {
        throw new Error('浏览器拒绝刷新');
      },
    });
    install(secondRecovery, secondRouter);
    await secondRouter.push('/source');
    await secondRecovery.push('/target');
    expect(secondRecovery.failure.value).toEqual({ canStay: true });
  });

  it('延迟租约合并自动与手动刷新，最后一个有效租约释放后执行', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');
    const releaseOuter = recovery.deferReload();
    const releaseInner = recovery.deferReload();

    await recovery.push('/target');
    recovery.retryReload();
    expect(reloadPage).not.toHaveBeenCalled();
    releaseOuter();
    releaseOuter();
    expect(reloadPage).not.toHaveBeenCalled();
    releaseInner();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('没有失败时释放延迟租约不会刷新', async () => {
    const reloadPage = vi.fn<() => void>();
    const router = makeRouter([]);
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');

    const release = recovery.deferReload();
    release();
    release();

    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('更新导航会取消尚未执行或已取消刷新的旧恢复', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(new Error('旧 chunk')) },
      { path: '/new-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');
    const release = recovery.deferReload();

    await recovery.push('/old-target');
    await recovery.push('/new-target');
    release();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();

    await recovery.push('/old-target');
    expect(reloadPage).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toEqual({ canStay: true });
    await recovery.push('/new-target');
    expect(recovery.failure.value).toBeNull();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('成功的浏览器历史导航会清理进行中的旧恢复状态', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/history-target', component: {} },
      { path: '/old-target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/history-target');
    await router.push('/source');

    await recovery.push('/old-target');
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/old-target'));

    router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/history-target'));

    expect(recovery.failure.value).toBeNull();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toBeNull();
    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('卸载会重置内存状态，旧租约不能影响重新安装', async () => {
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    const firstRouter = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const dispose = recovery.install(firstRouter, {
      onUnexpectedNavigationError: vi.fn<(error: unknown) => void>(),
    });
    await firstRouter.push('/source');
    const staleRelease = recovery.deferReload();
    await recovery.push('/target');
    dispose();
    dispose();
    sessionStorage.clear();

    const secondRouter = makeRouter([
      { path: '/target', component: failingRoute(new Error('新失败')) },
    ]);
    cleanups.push(
      recovery.install(secondRouter, {
        onUnexpectedNavigationError: vi.fn<(error: unknown) => void>(),
      }),
    );
    await secondRouter.push('/source');
    await recovery.push('/target');
    expect(reloadPage).toHaveBeenCalledOnce();
    staleRelease();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('重复安装快速失败', () => {
    const recovery = createChunkLoadRecovery();
    const router = makeRouter([]);
    const dispose = recovery.install(router, {
      onUnexpectedNavigationError: vi.fn<(error: unknown) => void>(),
    });
    cleanups.push(dispose);

    expect(() =>
      recovery.install(router, {
        onUnexpectedNavigationError: vi.fn<(error: unknown) => void>(),
      }),
    ).toThrow('chunk 加载恢复器已安装');
  });

  it('拒绝旧版、字段多余和目标非法的恢复记录', async () => {
    const invalidRecords = [
      '/target',
      'null',
      '[]',
      '1',
      '{}',
      JSON.stringify({ version: 1, target: '/target', mode: 'push', extra: true }),
      JSON.stringify({ version: 2, target: '/target', mode: 'push' }),
      JSON.stringify({ version: 1, target: '/target', mode: 'unknown' }),
      JSON.stringify({ version: 1, target: 1, mode: 'push' }),
      JSON.stringify({ version: 1, target: 'https://example.com', mode: 'push' }),
      JSON.stringify({ version: 1, target: '//example.com', mode: 'push' }),
      JSON.stringify({ version: 1, target: '/bad\npath', mode: 'push' }),
    ];

    for (const record of invalidRecords) {
      sessionStorage.setItem(RECOVERY_STORAGE_KEY, record);
      const router = makeRouter([{ path: '/target', component: {} }]);
      const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
      const dispose = recovery.install(router, {
        onUnexpectedNavigationError: vi.fn<(error: unknown) => void>(),
      });
      await router.push('/source');
      expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
      expect(router.currentRoute.value.fullPath).toBe('/source');
      dispose();
    }
  });

  it('存储不可用时禁止自动刷新，但允许手动刷新', async () => {
    const router = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getStorage: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      reloadPage,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');
    expect(reloadPage).not.toHaveBeenCalled();
    expect(recovery.failure.value).toEqual({ canStay: true });
    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('写入记录失败时禁止自动刷新', async () => {
    const storage = {
      ...sessionStorage,
      getItem: vi.fn<Storage['getItem']>(() => null),
      removeItem: vi.fn<Storage['removeItem']>(),
      setItem: vi.fn<Storage['setItem']>(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      }),
    } as Storage;
    const router = makeRouter([
      { path: '/target', component: failingRoute(new Error('旧 chunk')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ getStorage: () => storage, reloadPage });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');

    expect(reloadPage).not.toHaveBeenCalled();
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('接受字符串和命名路由目标并返回与 Router 一致的导航结果', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/source', name: 'source', component: {} },
        { path: '/target', name: 'target', component: {} },
      ],
    });
    const recovery = createChunkLoadRecovery();
    install(recovery, router);

    await expect(
      recovery.push({ name: 'source' } satisfies RouteLocationRaw),
    ).resolves.toBeUndefined();
    await expect(recovery.replace('/target')).resolves.toBeUndefined();
    expect(router.currentRoute.value.fullPath).toBe('/target');
  });

  it('未安装时主动导航和延迟租约快速失败，UI 操作保持幂等', () => {
    const recovery = createChunkLoadRecovery();

    expect(() => recovery.push('/source')).toThrow('chunk 加载恢复器尚未安装');
    expect(() => recovery.replace('/source')).toThrow('chunk 加载恢复器尚未安装');
    expect(() => recovery.deferReload()).toThrow('chunk 加载恢复器尚未安装');
    expect(() => recovery.retryReload()).not.toThrow();
    expect(() => recovery.stayOnCurrentPage()).not.toThrow();
  });
});
