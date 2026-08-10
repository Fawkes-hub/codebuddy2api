import type { NavigationGuard, RouteComponent, RouteLocationRaw, Router } from 'vue-router';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChunkLoadRecovery } from '../utils/chunkLoadRecovery';

const RECOVERY_STORAGE_KEY = 'codebuddy2api:chunk-reload-attempted';

function chunkLoadError(target = '/assets/TargetPage-old.js'): TypeError {
  return new TypeError(`Failed to fetch dynamically imported module: ${target}`);
}

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
    const error = chunkLoadError();
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

  it('模块初始化异常即使触发 preload 事件也会报告并保留导航拒绝', async () => {
    for (const error of [
      new ReferenceError('路由模块初始化失败'),
      new TypeError('路由模块顶层调用失败'),
    ]) {
      const router = makeRouter([{ path: '/broken', component: failingRoute(error) }]);
      const reloadPage = vi.fn<() => void>();
      const recovery = createChunkLoadRecovery({ reloadPage });
      const report = vi.fn<(error: unknown) => void>();
      const dispose = recovery.install(router, { onUnexpectedNavigationError: report });
      await router.push('/source');

      await expect(recovery.push('/broken')).rejects.toBe(error);

      expect(report).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(error);
      expect(reloadPage).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
      expect(recovery.failure.value).toBeNull();
      dispose();
    }
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
      { path: '/target', component: failingRoute(chunkLoadError()) },
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
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(recovery, router);
    await router.push('/source');

    await recovery.push({ path: '/target', replace: true });

    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target', 'replace'));
  });

  it('初始或浏览器历史导航缺少显式意图时使用 replace 语义', async () => {
    const error = new Error('Unable to preload CSS for /assets/TargetPage-old.css');
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
    const staleError = chunkLoadError('/assets/superseded-old.js');
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
    const staleError = chunkLoadError('/assets/history-old.js');
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

    const staleError = chunkLoadError('/assets/abandoned-old.js');
    dispatchPreloadError(staleError);
    deferred.reject(staleError);
    await expect(abandonedNavigation).resolves.toBeUndefined();

    expect(router.currentRoute.value.fullPath).toBe('/history-target');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(recovery.failure.value).toBeNull();
  });

  it('较早的无 intent chunk 错误不会覆盖后发显式恢复目标', async () => {
    const staleRoute = deferredRoute();
    const router = makeRouter([
      { path: '/stale-target', component: staleRoute.loader },
      {
        path: '/latest-target',
        component: failingRoute(chunkLoadError('/assets/latest-old.js')),
      },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');

    const staleNavigation = router.push('/stale-target').catch(() => undefined);
    await vi.waitFor(() => expect(staleRoute.loader).toHaveBeenCalledOnce());
    await recovery.push('/latest-target');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/latest-target'));

    const staleError = chunkLoadError('/assets/stale-old.js');
    dispatchPreloadError(staleError);
    staleRoute.reject(staleError);
    await Promise.all([staleRoute.promise.catch(() => undefined), staleNavigation]);

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/latest-target'));
    expect(recovery.failure.value).toBeNull();
  });

  it('后发重复导航会使较早的无 intent chunk 错误失效', async () => {
    const staleRoute = deferredRoute();
    const router = makeRouter([{ path: '/stale-target', component: staleRoute.loader }]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');

    const staleNavigation = router.push('/stale-target').catch(() => undefined);
    await vi.waitFor(() => expect(staleRoute.loader).toHaveBeenCalledOnce());
    await recovery.push('/source');

    const staleError = chunkLoadError('/assets/stale-duplicated-old.js');
    dispatchPreloadError(staleError);
    staleRoute.reject(staleError);
    await Promise.all([staleRoute.promise.catch(() => undefined), staleNavigation]);

    expect(router.currentRoute.value.fullPath).toBe('/source');
    expect(reloadPage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
  });

  it('后发导航在全局守卫前中止也会使较早的无 intent chunk 错误失效', async () => {
    const staleRoute = deferredRoute();
    const router = makeRouter([
      { path: '/stale-target', component: staleRoute.loader },
      { path: '/blocked-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');

    const staleNavigation = router.push('/stale-target').catch(() => undefined);
    await vi.waitFor(() => expect(staleRoute.loader).toHaveBeenCalledOnce());
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const leaveGuard = vi.fn<NavigationGuard>((to) =>
      to.fullPath === '/blocked-target' ? false : undefined,
    );
    sourceRecord.leaveGuards.add(leaveGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(leaveGuard));

    await recovery.push('/blocked-target');
    expect(leaveGuard).toHaveBeenCalledOnce();

    const staleError = chunkLoadError('/assets/stale-aborted-old.js');
    dispatchPreloadError(staleError);
    staleRoute.reject(staleError);
    await Promise.all([staleRoute.promise.catch(() => undefined), staleNavigation]);

    expect(router.currentRoute.value.fullPath).toBe('/source');
    expect(reloadPage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
  });

  it('自动刷新后的重复 chunk 失败停止循环并允许留在来源页', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/target'));
    const router = makeRouter([
      { path: '/target', component: failingRoute(chunkLoadError('/assets/target-new.js')) },
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
    const error = chunkLoadError('/assets/landing-new.js');
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
      { path: '/first', component: failingRoute(chunkLoadError('/assets/first.js')) },
      { path: '/second', component: failingRoute(chunkLoadError('/assets/second.js')) },
      { path: '/third', component: failingRoute(chunkLoadError('/assets/third.js')) },
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
    const error = chunkLoadError('/assets/initial.js');
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
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
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

  it('回退刷新发生 pagehide 后忽略已经排队的迟到状态检查', async () => {
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    const recovery = createChunkLoadRecovery({ reloadPage: vi.fn<() => void>() });
    install(recovery, router);
    await router.push('/source');
    let staleStatusCheck!: () => void;
    const placeholderTimer = globalThis.setTimeout(() => undefined, 60_000);
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((handler, delay) => {
      if (delay === 1_000) staleStatusCheck = handler as () => void;
      return placeholderTimer;
    });

    await recovery.push('/target');
    expect(staleStatusCheck).toBeTypeOf('function');
    setTimeoutSpy.mockRestore();
    window.dispatchEvent(new Event('pagehide'));
    staleStatusCheck();

    expect(recovery.failure.value).toBeNull();
  });

  it('回退刷新超时只显示恢复入口，用户选择留页时才停止待处理导航', async () => {
    vi.useFakeTimers();
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    const reloadPage = vi.fn<() => void>();
    let recovery!: ReturnType<typeof createChunkLoadRecovery>;
    const stopPageLoading = vi.fn<() => void>(() => {
      expect(recovery.failure.value).toEqual({ canStay: true });
      expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target'));
    });
    recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');
    vi.advanceTimersByTime(999);
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(recovery.failure.value).toBeNull();

    vi.advanceTimersByTime(1);
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(recovery.failure.value).toEqual({ canStay: true });

    recovery.stayOnCurrentPage();
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
  });

  it('Navigation API 刷新响应缓慢时不会按固定时间误报失败', async () => {
    vi.useFakeTimers();
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    const pending = new Promise<NavigationHistoryEntry>(() => undefined);
    const reloadNavigation = vi.fn<() => NavigationResult>(() => ({
      committed: pending,
      finished: pending,
    }));
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: reloadNavigation,
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');
    vi.advanceTimersByTime(60_000);

    expect(reloadNavigation).toHaveBeenCalledOnce();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(recovery.failure.value).toBeNull();
  });

  it('成功的更新导航会终止仍在等待提交的 Navigation API 刷新', async () => {
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
      { path: '/new-target', component: {} },
    ]);
    let rejectCommitted!: (error: unknown) => void;
    const committed = new Promise<NavigationHistoryEntry>((_resolve, reject) => {
      rejectCommitted = reject;
    });
    const finished = new Promise<NavigationHistoryEntry>(() => undefined);
    const reloadNavigation = vi.fn<() => NavigationResult>(() => ({ committed, finished }));
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: reloadNavigation,
      }),
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    await recovery.push('/new-target');

    expect(router.currentRoute.value.fullPath).toBe('/new-target');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();

    rejectCommitted(new DOMException('刷新已终止', 'AbortError'));
    await Promise.resolve();
    expect(recovery.failure.value).toBeNull();
  });

  it('Navigation API 明确拒绝刷新后才显示手动恢复入口', async () => {
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    let rejectCommitted!: (error: unknown) => void;
    const committed = new Promise<NavigationHistoryEntry>((_resolve, reject) => {
      rejectCommitted = reject;
    });
    const reloadNavigation = vi.fn<() => NavigationResult>(() => ({
      committed,
      finished: new Promise<NavigationHistoryEntry>(() => undefined),
    }));
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: reloadNavigation,
      }),
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');
    expect(recovery.failure.value).toBeNull();

    rejectCommitted(new DOMException('刷新已取消', 'AbortError'));
    await Promise.resolve();
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('Navigation API 会消费 finished 拒绝且只用 committed 判断刷新是否提交', async () => {
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    const committed = new Promise<NavigationHistoryEntry>(() => undefined);
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<NavigationHistoryEntry>((_resolve, reject) => {
      rejectFinished = reject;
    });
    const finishedCatch = vi.spyOn(finished, 'catch');
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: () => ({ committed, finished }),
      }),
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');

    expect(finishedCatch).toHaveBeenCalledOnce();
    rejectFinished(new DOMException('刷新未完成', 'AbortError'));
    await Promise.resolve();
    expect(recovery.failure.value).toBeNull();
  });

  it('Navigation API 异步失败后的重试沿用后发 chunk 目标', async () => {
    const router = makeRouter([
      { path: '/first-target', component: failingRoute(chunkLoadError('/assets/first-old.js')) },
      { path: '/second-target', component: failingRoute(chunkLoadError('/assets/second-old.js')) },
    ]);
    let rejectFirstCommit!: (error: unknown) => void;
    const firstCommit = new Promise<NavigationHistoryEntry>((_resolve, reject) => {
      rejectFirstCommit = reject;
    });
    const secondCommit = new Promise<NavigationHistoryEntry>(() => undefined);
    const reloadNavigation = vi
      .fn<() => NavigationResult>()
      .mockReturnValueOnce({ committed: firstCommit, finished: firstCommit })
      .mockReturnValue({ committed: secondCommit, finished: secondCommit });
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: reloadNavigation,
      }),
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/first-target');
    await recovery.push('/second-target');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));

    rejectFirstCommit(new DOMException('刷新已取消', 'AbortError'));
    await Promise.resolve();
    expect(recovery.failure.value).toEqual({ canStay: true });

    recovery.retryReload();
    expect(reloadNavigation).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
  });

  it('Navigation API 刷新已触发 pagehide 时忽略迟到的拒绝', async () => {
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    let rejectCommitted!: (error: unknown) => void;
    const committed = new Promise<NavigationHistoryEntry>((_resolve, reject) => {
      rejectCommitted = reject;
    });
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: () => ({ committed }),
      }),
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');
    window.dispatchEvent(new Event('pagehide'));
    rejectCommitted(new DOMException('旧文档已卸载', 'AbortError'));
    await Promise.resolve();

    expect(recovery.failure.value).toBeNull();
  });

  it('用户留在当前页并停止回退刷新时即使同步发生 pagehide 也能完成清理', async () => {
    vi.useFakeTimers();
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
    const recovery = createChunkLoadRecovery({
      reloadPage: vi.fn<() => void>(),
      stopPageLoading: () => window.dispatchEvent(new Event('pagehide')),
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/target');
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toEqual({ canStay: true });
    recovery.stayOnCurrentPage();

    expect(recovery.failure.value).toBeNull();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('刷新同步触发 pagehide、抛错或返回无效结果时均保持确定状态', async () => {
    vi.useFakeTimers();
    const firstRouter = makeRouter([
      { path: '/target', component: failingRoute(chunkLoadError()) },
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
      { path: '/target', component: failingRoute(chunkLoadError()) },
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
    cleanups.pop()!();
    sessionStorage.clear();

    const thirdRouter = makeRouter([
      { path: '/target', component: failingRoute(chunkLoadError()) },
    ]);
    const stopPageLoading = vi.fn<() => void>();
    const reloadNavigation = vi.fn<() => NavigationResult>(() => ({}));
    const thirdRecovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: reloadNavigation,
      }),
      stopPageLoading,
    });
    install(thirdRecovery, thirdRouter);
    await thirdRouter.push('/source');
    await thirdRecovery.push('/target');
    expect(thirdRecovery.failure.value).toBeNull();
    vi.runOnlyPendingTimers();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(thirdRecovery.failure.value).toEqual({ canStay: true });
    thirdRecovery.retryReload();
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(reloadNavigation).toHaveBeenCalledTimes(2);
  });

  it('延迟租约合并自动与手动刷新，最后一个有效租约释放后执行', async () => {
    vi.useFakeTimers();
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
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

  it('首个延迟租约会暂停已启动的回退刷新并在最后释放后重启', async () => {
    vi.useFakeTimers();
    const router = makeRouter([{ path: '/old-target', component: failingRoute(chunkLoadError()) }]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    expect(reloadPage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    const releaseOuter = recovery.deferReload();
    const releaseInner = recovery.deferReload();

    expect(stopPageLoading).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toBeNull();
    releaseOuter();
    expect(reloadPage).toHaveBeenCalledOnce();
    releaseInner();
    expect(reloadPage).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/old-target'));
  });

  it('已明确失败且没有在途刷新时延迟租约不会自动重试', async () => {
    const router = makeRouter([{ path: '/old-target', component: failingRoute(chunkLoadError()) }]);
    let rejectCommitted!: (error: unknown) => void;
    const committed = new Promise<NavigationHistoryEntry>((_resolve, reject) => {
      rejectCommitted = reject;
    });
    const reloadNavigation = vi.fn<() => NavigationResult>(() => ({ committed }));
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: reloadNavigation,
      }),
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');
    await recovery.push('/old-target');
    rejectCommitted(new DOMException('刷新已取消', 'AbortError'));
    await Promise.resolve();
    expect(recovery.failure.value).toEqual({ canStay: true });

    const release = recovery.deferReload();
    release();

    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(reloadNavigation).toHaveBeenCalledOnce();
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('延迟租约会暂停已启动的 Navigation API 刷新并忽略旧尝试拒绝', async () => {
    const router = makeRouter([{ path: '/old-target', component: failingRoute(chunkLoadError()) }]);
    let rejectFirstCommit!: (error: unknown) => void;
    const firstCommit = new Promise<NavigationHistoryEntry>((_resolve, reject) => {
      rejectFirstCommit = reject;
    });
    const secondCommit = new Promise<NavigationHistoryEntry>(() => undefined);
    const reloadNavigation = vi
      .fn<() => NavigationResult>()
      .mockReturnValueOnce({ committed: firstCommit, finished: firstCommit })
      .mockReturnValue({ committed: secondCommit, finished: secondCommit });
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: {} as NavigationHistoryEntry,
        reload: reloadNavigation,
      }),
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    expect(reloadNavigation).toHaveBeenCalledOnce();

    const release = recovery.deferReload();

    expect(stopPageLoading).toHaveBeenCalledOnce();
    rejectFirstCommit(new DOMException('刷新已终止', 'AbortError'));
    await Promise.resolve();
    expect(recovery.failure.value).toBeNull();
    release();
    expect(reloadNavigation).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/old-target'));
  });

  it('重定向到当前路由的 duplicated 导航会终止旧刷新并消费记录', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/', redirect: '/source' },
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage, stopPageLoading });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    expect(reloadPage).toHaveBeenCalledOnce();

    const result = await recovery.push('/');

    expect(result).toBeDefined();
    expect(router.currentRoute.value.fullPath).toBe('/source');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toBeNull();
  });

  it('回退刷新超时后的导航异常会终止旧刷新并消费记录', async () => {
    vi.useFakeTimers();
    const navigationError = new Error('后发路由异常');
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
      { path: '/broken', component: failingRoute(navigationError, false) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    const report = install(recovery, router);
    await router.push('/source');
    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    await expect(recovery.push('/broken')).rejects.toBe(navigationError);

    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
    expect(report).toHaveBeenCalledWith(navigationError);
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

  it('延迟刷新期间后发的无 intent chunk 失败会更新目标再等待释放', async () => {
    const secondError = chunkLoadError('/assets/second-old.js');
    const router = makeRouter([
      { path: '/first-target', component: failingRoute(chunkLoadError('/assets/first-old.js')) },
      { path: '/second-target', component: failingRoute(secondError) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    install(recovery, router);
    await router.push('/source');
    const release = recovery.deferReload();

    await recovery.push('/first-target');
    await expect(router.push('/second-target')).rejects.toBe(secondError);

    expect(reloadPage).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(
      recoveryRecord('/second-target', 'replace'),
    );

    release();
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(
      recoveryRecord('/second-target', 'replace'),
    );
  });

  it('更新导航会取消尚未执行或已取消刷新的旧恢复', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
      { path: '/new-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage, stopPageLoading });
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
    expect(stopPageLoading).not.toHaveBeenCalled();
    await recovery.push('/new-target');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(recovery.failure.value).toBeNull();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('回退刷新状态检查前成功的更新导航会终止旧刷新并消费记录', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
      { path: '/new-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(recovery.failure.value).toBeNull();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/old-target'));

    await recovery.push('/new-target');

    expect(router.currentRoute.value.fullPath).toBe('/new-target');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(recovery.failure.value).toBeNull();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toBeNull();
  });

  it('最新主动导航在全局守卫前被中止会终止旧刷新并消费记录', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
      { path: '/new-target', component: {} },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/old-target'));

    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const leaveGuard = vi.fn<NavigationGuard>(() => false);
    sourceRecord.leaveGuards.add(leaveGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(leaveGuard));
    const globalGuard = vi.fn<NavigationGuard>();
    cleanups.push(router.beforeEach(globalGuard));

    await recovery.push('/new-target');

    expect(leaveGuard).toHaveBeenCalledOnce();
    expect(globalGuard).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe('/source');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
    vi.runOnlyPendingTimers();
    expect(recovery.failure.value).toBeNull();
    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('回退刷新等待期间后发的 chunk 失败会替换恢复目标', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/first-target', component: failingRoute(chunkLoadError('/assets/first-old.js')) },
      { path: '/second-target', component: failingRoute(chunkLoadError('/assets/second-old.js')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/first-target');
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/first-target'));

    await recovery.push('/second-target');

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
    expect(recovery.failure.value).toBeNull();

    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });
    recovery.retryReload();

    expect(reloadPage).toHaveBeenCalledTimes(2);
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
  });

  it('回退刷新超时后的后发 chunk 失败只更新目标而不启动第二次刷新', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/first-target', component: failingRoute(chunkLoadError('/assets/first-old.js')) },
      { path: '/second-target', component: failingRoute(chunkLoadError('/assets/second-old.js')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/first-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    await recovery.push('/second-target');

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(recovery.failure.value).toEqual({ canStay: true });
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));

    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledTimes(2);
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
  });

  it('后发 chunk 目标无法持久化时移除旧记录并允许留页', async () => {
    let storedRecord: string | null = null;
    let writes = 0;
    const storage = {
      getItem: vi.fn<Storage['getItem']>(() => storedRecord),
      setItem: vi.fn<Storage['setItem']>((_key, value) => {
        writes += 1;
        if (writes === 2) throw new DOMException('quota', 'QuotaExceededError');
        storedRecord = value;
      }),
      removeItem: vi.fn<Storage['removeItem']>(() => {
        storedRecord = null;
      }),
    } as unknown as Storage;
    const router = makeRouter([
      { path: '/first-target', component: failingRoute(chunkLoadError('/assets/first-old.js')) },
      { path: '/second-target', component: failingRoute(chunkLoadError('/assets/second-old.js')) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getStorage: () => storage,
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/first-target');
    await recovery.push('/second-target');

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(storedRecord).toBeNull();
    expect(recovery.failure.value).toEqual({ canStay: true });
    expect(stopPageLoading).toHaveBeenCalledOnce();
    recovery.stayOnCurrentPage();
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(recovery.failure.value).toBeNull();
  });

  it('成功的浏览器历史导航会清理进行中的旧恢复状态', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/history-target', component: {} },
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
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

  it('取代主动导航的历史导航被守卫中止时仍会清理旧恢复状态', async () => {
    vi.useFakeTimers();
    const pendingRoute = deferredRoute();
    const router = makeRouter([
      { path: '/history-target', component: {} },
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
      { path: '/pending-target', component: pendingRoute.loader },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/history-target');
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    const pendingNavigation = recovery.push('/pending-target');
    await vi.waitFor(() => expect(pendingRoute.loader).toHaveBeenCalledOnce());
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const historyGuard = vi.fn<NavigationGuard>(() => false);
    sourceRecord.leaveGuards.add(historyGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(historyGuard));
    let historySettled = false;
    const removeAfterEach = router.afterEach((to, _from, failure) => {
      if (to.fullPath === '/history-target' && failure) historySettled = true;
    });
    cleanups.push(removeAfterEach);

    router.back();
    await vi.waitFor(() => expect(historyGuard).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(historySettled).toBe(true));

    expect(router.currentRoute.value.fullPath).toBe('/source');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
    pendingRoute.resolve({});
    await pendingNavigation;
    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('连续 pop 时最新历史导航被守卫中止仍会清理旧恢复状态', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/first-history-target', component: {} },
      { path: '/second-history-target', component: {} },
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/first-history-target');
    await router.push('/second-history-target');
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    let abortFirstHistoryNavigation!: () => void;
    const firstHistoryGuardResult = new Promise<boolean>((resolve) => {
      abortFirstHistoryNavigation = () => resolve(false);
    });
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const historyGuard = vi.fn<NavigationGuard>((to) => {
      if (to.fullPath === '/second-history-target') return firstHistoryGuardResult;
      if (to.fullPath === '/first-history-target') return false;
      return undefined;
    });
    sourceRecord.leaveGuards.add(historyGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(historyGuard));
    let latestHistorySettled = false;
    let firstHistorySettled = false;
    const removeAfterEach = router.afterEach((to, _from, failure) => {
      if (!failure) return;
      if (to.fullPath === '/first-history-target') latestHistorySettled = true;
      if (to.fullPath === '/second-history-target') firstHistorySettled = true;
    });
    cleanups.push(removeAfterEach);

    router.back();
    await vi.waitFor(() =>
      expect(historyGuard).toHaveBeenCalledWith(
        expect.objectContaining({ fullPath: '/second-history-target' }),
        expect.anything(),
        expect.anything(),
      ),
    );
    router.back();
    await vi.waitFor(() => expect(latestHistorySettled).toBe(true));

    expect(router.currentRoute.value.fullPath).toBe('/source');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();

    abortFirstHistoryNavigation();
    await vi.waitFor(() => expect(firstHistorySettled).toBe(true));
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('已绑定身份的最新 history 被后续守卫中止仍会清理旧恢复状态', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/history-target', component: {} },
      { path: '/old-target', component: failingRoute(chunkLoadError()) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/history-target');
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    const laterGuard = vi.fn<NavigationGuard>((to) =>
      to.fullPath === '/history-target' ? false : undefined,
    );
    cleanups.push(router.beforeResolve(laterGuard));
    let historySettled = false;
    const removeAfterEach = router.afterEach((to, _from, failure) => {
      if (to.fullPath === '/history-target' && failure) historySettled = true;
    });
    cleanups.push(removeAfterEach);

    router.back();
    await vi.waitFor(() => expect(laterGuard).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(historySettled).toBe(true));

    expect(router.currentRoute.value.fullPath).toBe('/source');
    expect(stopPageLoading).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovery.failure.value).toBeNull();
    recovery.retryReload();
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('同 URL 旧 history 的迟到中止不会清理后发 chunk 恢复状态', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      {
        path: '/history-target',
        component: failingRoute(chunkLoadError('/assets/history-target-old.js')),
      },
      { path: '/old-target', component: failingRoute(chunkLoadError('/assets/old.js')) },
    ]);
    router.options.history.push('/history-target');
    router.options.history.push('/history-target');
    router.options.history.push('/source');
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    let abortFirstHistoryNavigation!: () => void;
    const firstHistoryGuardResult = new Promise<boolean>((resolve) => {
      abortFirstHistoryNavigation = () => resolve(false);
    });
    let historyGuardCalls = 0;
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const historyGuard = vi.fn<NavigationGuard>((to) => {
      if (to.fullPath !== '/history-target') return undefined;
      historyGuardCalls += 1;
      return historyGuardCalls === 1 ? firstHistoryGuardResult : undefined;
    });
    sourceRecord.leaveGuards.add(historyGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(historyGuard));
    let firstHistorySettled = false;
    const removeAfterEach = router.afterEach((to, _from, failure) => {
      if (to.fullPath === '/history-target' && failure) firstHistorySettled = true;
    });
    cleanups.push(removeAfterEach);

    router.back();
    await vi.waitFor(() => expect(historyGuardCalls).toBe(1));
    router.back();
    await vi.waitFor(() => expect(historyGuardCalls).toBe(2));
    await vi.waitFor(() =>
      expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(
        recoveryRecord('/history-target', 'replace'),
      ),
    );

    abortFirstHistoryNavigation();
    await vi.waitFor(() => expect(firstHistorySettled).toBe(true));

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(
      recoveryRecord('/history-target', 'replace'),
    );
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('旧导航的 cancelled 回调不会清理正在等待早期守卫的后发恢复目标', async () => {
    vi.useFakeTimers();
    const firstRoute = deferredRoute();
    const secondError = chunkLoadError('/assets/second-old.js');
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError('/assets/old.js')) },
      { path: '/first-target', component: firstRoute.loader },
      { path: '/second-target', component: failingRoute(secondError) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    let releaseSecondGuard!: () => void;
    const secondGuard = new Promise<void>((resolve) => {
      releaseSecondGuard = resolve;
    });
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const leaveGuard = vi.fn<NavigationGuard>((to) =>
      to.fullPath === '/second-target' ? secondGuard : undefined,
    );
    sourceRecord.leaveGuards.add(leaveGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(leaveGuard));

    const firstNavigation = recovery.push('/first-target');
    await vi.waitFor(() => expect(firstRoute.loader).toHaveBeenCalledOnce());
    const secondNavigation = recovery.push('/second-target');
    await vi.waitFor(() =>
      expect(leaveGuard).toHaveBeenCalledWith(
        expect.objectContaining({ fullPath: '/second-target' }),
        expect.anything(),
        expect.anything(),
      ),
    );

    firstRoute.resolve({});
    await firstNavigation;
    releaseSecondGuard();
    await expect(secondNavigation).resolves.toBeUndefined();

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('被取代导航迟到的 aborted 回调不会清理后发 chunk 恢复目标', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError('/assets/old.js')) },
      { path: '/first-target', component: {} },
      {
        path: '/second-target',
        component: failingRoute(chunkLoadError('/assets/second-old.js')),
      },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    let abortFirstGuard!: () => void;
    const firstGuardResult = new Promise<boolean>((resolve) => {
      abortFirstGuard = () => resolve(false);
    });
    const firstGuard = vi.fn<NavigationGuard>((to) =>
      to.fullPath === '/first-target' ? firstGuardResult : undefined,
    );
    cleanups.push(router.beforeResolve(firstGuard));

    const firstNavigation = recovery.push('/first-target');
    await vi.waitFor(() =>
      expect(firstGuard).toHaveBeenCalledWith(
        expect.objectContaining({ fullPath: '/first-target' }),
        expect.anything(),
        expect.anything(),
      ),
    );
    await expect(recovery.push('/second-target')).resolves.toBeUndefined();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));

    abortFirstGuard();
    await firstNavigation;

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('未进入全局守卫的过期 aborted 回调也不会清理后发 chunk 恢复目标', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError('/assets/old.js')) },
      { path: '/first-target', component: {} },
      {
        path: '/second-target',
        component: failingRoute(chunkLoadError('/assets/second-old.js')),
      },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    let abortFirstGuard!: () => void;
    const firstGuardResult = new Promise<boolean>((resolve) => {
      abortFirstGuard = () => resolve(false);
    });
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const firstGuard = vi.fn<NavigationGuard>((to) =>
      to.fullPath === '/first-target' ? firstGuardResult : undefined,
    );
    sourceRecord.leaveGuards.add(firstGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(firstGuard));

    const firstNavigation = recovery.push('/first-target');
    await vi.waitFor(() =>
      expect(firstGuard).toHaveBeenCalledWith(
        expect.objectContaining({ fullPath: '/first-target' }),
        expect.anything(),
        expect.anything(),
      ),
    );
    await expect(recovery.push('/second-target')).resolves.toBeUndefined();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));

    abortFirstGuard();
    await firstNavigation;

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('过期历史导航的 aborted 回调不会清理后发 chunk 恢复目标', async () => {
    vi.useFakeTimers();
    const router = makeRouter([
      { path: '/history-target', component: {} },
      { path: '/old-target', component: failingRoute(chunkLoadError('/assets/old.js')) },
      {
        path: '/second-target',
        component: failingRoute(chunkLoadError('/assets/second-old.js')),
      },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/history-target');
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    let abortHistoryGuard!: () => void;
    const historyGuardResult = new Promise<boolean>((resolve) => {
      abortHistoryGuard = () => resolve(false);
    });
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const historyGuard = vi.fn<NavigationGuard>((to) =>
      to.fullPath === '/history-target' ? historyGuardResult : undefined,
    );
    sourceRecord.leaveGuards.add(historyGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(historyGuard));
    let historySettled = false;
    const removeAfterEach = router.afterEach((to, _from, failure) => {
      if (to.fullPath === '/history-target' && failure) historySettled = true;
    });
    cleanups.push(removeAfterEach);

    router.back();
    await vi.waitFor(() => expect(historyGuard).toHaveBeenCalledOnce());
    await expect(recovery.push('/second-target')).resolves.toBeUndefined();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));

    abortHistoryGuard();
    await vi.waitFor(() => expect(historySettled).toBe(true));

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/second-target'));
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('同目标旧导航的 aborted 回调不会匹配后发 intent 并清理恢复状态', async () => {
    vi.useFakeTimers();
    const targetError = chunkLoadError('/assets/target-old.js');
    const router = makeRouter([
      { path: '/old-target', component: failingRoute(chunkLoadError('/assets/old.js')) },
      { path: '/target', component: failingRoute(targetError) },
    ]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    install(recovery, router);
    await router.push('/source');

    await recovery.push('/old-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });

    let abortFirstGuard!: () => void;
    const firstGuardResult = new Promise<boolean>((resolve) => {
      abortFirstGuard = () => resolve(false);
    });
    let targetGuardCalls = 0;
    const sourceRecord = router.currentRoute.value.matched.at(-1);
    if (sourceRecord === undefined) throw new Error('未找到来源路由记录');
    const targetGuard = vi.fn<NavigationGuard>((to) => {
      if (to.fullPath !== '/target') return undefined;
      targetGuardCalls += 1;
      return targetGuardCalls === 1 ? firstGuardResult : undefined;
    });
    sourceRecord.leaveGuards.add(targetGuard);
    cleanups.push(() => sourceRecord.leaveGuards.delete(targetGuard));

    const firstNavigation = recovery.push('/target');
    await vi.waitFor(() => expect(targetGuardCalls).toBe(1));
    let releaseSecondSettlement!: () => void;
    const secondSettlement = new Promise<void>((resolve) => {
      releaseSecondSettlement = resolve;
    });
    const originalPush = router.push;
    router.push = vi.fn<Router['push']>((to) => {
      const navigation = originalPush.call(router, to);
      return navigation.then(
        async (result) => {
          await secondSettlement;
          return result;
        },
        async (error: unknown) => {
          await secondSettlement;
          throw error;
        },
      );
    });
    const removeError = router.onError((error, to) => {
      if (error === targetError && to.fullPath === '/target') abortFirstGuard();
    });
    cleanups.push(removeError);
    const secondNavigation = recovery.push('/target');
    await firstNavigation;

    expect(targetGuardCalls).toBe(2);
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/target'));
    expect(recovery.failure.value).toEqual({ canStay: true });
    releaseSecondSettlement();
    await expect(secondNavigation).resolves.toBeUndefined();
  });

  it('旧安装迟到的 aborted 回调不会清理重新安装后的恢复状态', async () => {
    vi.useFakeTimers();
    const firstRouter = makeRouter([{ path: '/pending-target', component: {} }]);
    const reloadPage = vi.fn<() => void>();
    const stopPageLoading = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({
      getNavigation: () => ({
        currentEntry: null,
        reload: vi.fn<() => NavigationResult>(),
      }),
      reloadPage,
      stopPageLoading,
    });
    const disposeFirst = recovery.install(firstRouter, {
      onUnexpectedNavigationError: vi.fn<(error: unknown) => void>(),
    });
    cleanups.push(disposeFirst);
    await firstRouter.push('/source');

    let abortOldNavigation!: () => void;
    const oldGuardResult = new Promise<boolean>((resolve) => {
      abortOldNavigation = () => resolve(false);
    });
    const firstSourceRecord = firstRouter.currentRoute.value.matched.at(-1);
    if (firstSourceRecord === undefined) throw new Error('未找到旧安装来源路由记录');
    const oldGuard = vi.fn<NavigationGuard>((to) =>
      to.fullPath === '/pending-target' ? oldGuardResult : undefined,
    );
    firstSourceRecord.leaveGuards.add(oldGuard);
    cleanups.push(() => firstSourceRecord.leaveGuards.delete(oldGuard));
    const oldNavigation = recovery.push('/pending-target');
    await vi.waitFor(() => expect(oldGuard).toHaveBeenCalledOnce());

    disposeFirst();
    const secondRouter = makeRouter([
      {
        path: '/new-target',
        component: failingRoute(chunkLoadError('/assets/new-target-old.js')),
      },
    ]);
    install(recovery, secondRouter);
    await secondRouter.push('/source');
    await recovery.push('/new-target');
    vi.advanceTimersByTime(1_000);
    expect(recovery.failure.value).toEqual({ canStay: true });
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/new-target'));

    abortOldNavigation();
    await oldNavigation;

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(stopPageLoading).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/new-target'));
    expect(recovery.failure.value).toEqual({ canStay: true });
  });

  it('旧安装迟到完成的自动续接不会消费重新安装后的恢复记录', async () => {
    const staleResumeRoute = deferredRoute();
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, recoveryRecord('/stale-resume'));
    const firstRouter = makeRouter([{ path: '/stale-resume', component: staleResumeRoute.loader }]);
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    const disposeFirst = recovery.install(firstRouter, {
      onUnexpectedNavigationError: vi.fn<(error: unknown) => void>(),
    });
    cleanups.push(disposeFirst);
    await firstRouter.push('/source');
    await vi.waitFor(() => expect(staleResumeRoute.loader).toHaveBeenCalledOnce());

    disposeFirst();
    sessionStorage.clear();
    const secondRouter = makeRouter([
      {
        path: '/new-target',
        component: failingRoute(chunkLoadError('/assets/new-target-old.js')),
      },
    ]);
    install(recovery, secondRouter);
    await secondRouter.push('/source');
    await recovery.push('/new-target');
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/new-target'));

    staleResumeRoute.resolve({});
    await vi.waitFor(() => expect(firstRouter.currentRoute.value.fullPath).toBe('/stale-resume'));

    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(recoveryRecord('/new-target'));
  });

  it('卸载会重置内存状态，旧租约不能影响重新安装', async () => {
    const reloadPage = vi.fn<() => void>();
    const recovery = createChunkLoadRecovery({ reloadPage });
    const firstRouter = makeRouter([
      { path: '/target', component: failingRoute(chunkLoadError()) },
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
      { path: '/target', component: failingRoute(chunkLoadError('/assets/target-new.js')) },
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
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
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
    const router = makeRouter([{ path: '/target', component: failingRoute(chunkLoadError()) }]);
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
