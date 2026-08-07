import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

interface FixtureState {
  phase: 'a' | 'b';
  targetMissing: boolean;
  documentRequests: number;
}

async function state(request: APIRequestContext): Promise<FixtureState> {
  const response = await request.get('/__control/state');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<FixtureState>;
}

async function reset(request: APIRequestContext, page: Page, route = '/source'): Promise<void> {
  await page.goto('about:blank');
  const response = await request.post('/__control/reset');
  expect(response.ok()).toBe(true);
  await page.goto(`/#${route}`);
}

async function switchToB(request: APIRequestContext, targetMissing = false): Promise<void> {
  const response = await request.post(`/__control/switch${targetMissing ? '?missing=1' : ''}`);
  expect(response.ok()).toBe(true);
}

test.describe('生产构建的 chunk 恢复', () => {
  test('push 失败只刷新一次、续接 B 版本目标并保留来源历史', async ({ page, request }) => {
    await reset(request, page);
    await expect(page.getByRole('heading', { name: '来源页面 A' })).toBeVisible();
    await switchToB(request);

    await page.getByTestId('push-target').click();
    await expect(page.getByTestId('target-version')).toHaveText('目标页面 B');
    await expect.poll(async () => (await state(request)).documentRequests).toBe(2);

    await page.goBack();
    await expect(page.getByRole('heading', { name: '来源页面 B' })).toBeVisible();
  });

  test('replace 续接替换来源历史项', async ({ page, request }) => {
    await reset(request, page, '/before');
    await page.getByTestId('open-source').click();
    await expect(page.getByRole('heading', { name: '来源页面 A' })).toBeVisible();
    await switchToB(request);

    await page.getByTestId('replace-target').click();
    await expect(page.getByTestId('target-version')).toHaveText('目标页面 B');

    await page.goBack();
    await expect(page.getByRole('heading', { name: '前置页面 B' })).toBeVisible();
  });

  test('取消刷新后可保留输入，留在当前页后不再自动刷新', async ({ page, request }) => {
    await reset(request, page);
    await page.getByTestId('draft').fill('尚未保存的草稿');
    await page.getByTestId('protect-draft').check();
    await switchToB(request);
    let beforeUnloadDialogs = 0;
    const dismissed = new Promise<void>((resolvePromise) => {
      page.once('dialog', (dialog) => {
        beforeUnloadDialogs += 1;
        void dialog.dismiss().then(resolvePromise);
      });
    });

    await page.getByTestId('push-target').click();
    await dismissed;
    const recoveryDialog = page.getByRole('alertdialog');
    await expect(recoveryDialog).toBeVisible();
    await recoveryDialog.getByRole('button', { name: '留在当前页' }).click();
    await expect(page.getByTestId('draft')).toHaveValue('尚未保存的草稿');
    expect((await state(request)).documentRequests).toBe(1);

    await page.getByTestId('push-target').click();
    await expect(recoveryDialog).toBeVisible();
    await page.waitForTimeout(1_200);
    expect((await state(request)).documentRequests).toBe(1);
    expect(beforeUnloadDialogs).toBe(1);
  });

  test('取消刷新后浏览器历史导航会清理旧恢复状态', async ({ page, request }) => {
    await reset(request, page, '/before');
    await page.getByTestId('open-source').click();
    await page.getByTestId('protect-draft').check();
    await switchToB(request);
    const dismissed = new Promise<void>((resolvePromise) => {
      page.once('dialog', (dialog) => {
        void dialog.dismiss().then(resolvePromise);
      });
    });

    await page.getByTestId('push-target').click();
    await dismissed;
    const recoveryDialog = page.getByRole('alertdialog');
    await expect(recoveryDialog).toBeVisible();

    await page.goBack();

    await expect(recoveryDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: '前置页面 A' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => sessionStorage.getItem('codebuddy2api:chunk-reload-attempted')),
      )
      .toBeNull();
    expect((await state(request)).documentRequests).toBe(1);
  });

  test('纯 hash 着陆的新版 chunk 持续缺失时只自动刷新一次', async ({ page, request }) => {
    await page.goto('about:blank');
    const resetResponse = await request.post('/__control/reset');
    expect(resetResponse.ok()).toBe(true);
    await switchToB(request, true);

    await page.goto('/#/target');

    const recoveryDialog = page.getByRole('alertdialog');
    await expect(recoveryDialog).toBeVisible();
    await expect(recoveryDialog.getByRole('button', { name: '留在当前页' })).toHaveCount(0);
    await page.waitForTimeout(1_200);
    expect(await state(request)).toMatchObject({
      phase: 'b',
      targetMissing: true,
      documentRequests: 2,
    });
  });

  test('B 版本目标仍缺失时显示手动恢复且不形成刷新循环', async ({ page, request }) => {
    await reset(request, page);
    await switchToB(request, true);

    await page.getByTestId('push-target').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByRole('button', { name: '留在当前页' })).toBeVisible();
    await page.waitForTimeout(1_200);

    const currentState = await state(request);
    expect(currentState).toMatchObject({
      phase: 'b',
      targetMissing: true,
      documentRequests: 2,
    });
  });
});
