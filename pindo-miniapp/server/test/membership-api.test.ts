import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer } from '../src/server';
import { listenOnRandomPort } from './support/listen';
import type { Moderation } from '../src/moderation';
import type { PaymentProvider } from '../src/payment';
import { createSandboxPaymentProvider } from '../src/payment';

const DAY = 24 * 60 * 60 * 1000;
const allowAll: Moderation = { check: async () => 'pass' };

let server: Server | undefined;
let clock = 0;

beforeEach(() => {
  clock = Date.parse('2026-11-09T02:00:00.000Z');
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startApp(options: { payment?: PaymentProvider; now?: () => Date } = {}): Promise<string> {
  server = createServer({
    moderation: allowAll,
    payment: options.payment,
    now: options.now ?? (() => new Date(clock)),
  });
  await listenOnRandomPort(server!);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** 白底中央红色方块，用一张稳定的小图完成生成。 */
async function redSquarePng(size = 64, square = 24): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3, 255);
  const start = Math.floor((size - square) / 2);
  for (let y = start; y < start + square; y++) {
    for (let x = start; x < start + square; x++) {
      const i = (y * size + x) * 3;
      raw[i] = 200;
      raw[i + 1] = 30;
      raw[i + 2] = 40;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

async function login(baseUrl: string, code: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

async function getMembership(
  baseUrl: string,
  platform: string,
  token?: string,
): Promise<Record<string, any>> {
  const headers: Record<string, string> = { 'x-platform': platform };
  if (token) headers['x-session-token'] = token;
  const response = await fetch(`${baseUrl}/api/membership`, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

function createOrder(
  baseUrl: string,
  platform: string,
  token: string | undefined,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-platform': platform,
  };
  if (token) headers['x-session-token'] = token;
  return fetch(`${baseUrl}/api/membership/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function notify(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/membership/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createTask(baseUrl: string, token?: string): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-size-tier': 'small',
    'x-palette-tier': 'basic',
  };
  if (token) headers['x-session-token'] = token;
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers,
    body: await redSquarePng(),
  });
  expect(response.status).toBe(202);
  const { taskId } = (await response.json()) as { taskId: string };
  return taskId;
}

async function waitForTask(baseUrl: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
    const body = (await response.json()) as Record<string, any>;
    if (body.status === 'completed' || body.status === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} did not finish in time`);
}

function createExport(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify(body),
  });
}

async function uploadAdvanced(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-size-tier': 'small',
      'x-palette-tier': 'advanced',
      'x-session-token': token,
    },
    body: await redSquarePng(),
  });
}

describe('会员开通与权益', () => {
  it('Android 端支付成功后权益即时生效：291 可用且导出不再受每日额度限制', async () => {
    const baseUrl = await startApp({ payment: createSandboxPaymentProvider() });
    const token = await login(baseUrl, 'android-payer');

    const before = await getMembership(baseUrl, 'android', token);
    expect(before.purchaseAvailable).toBe(true);
    expect(before.membership).toBeNull();
    expect(before.plans).toEqual([
      expect.objectContaining({ id: 'monthly', priceFen: 990 }),
      expect.objectContaining({ id: 'yearly', priceFen: 6900 }),
    ]);

    const orderResponse = await createOrder(baseUrl, 'android', token, { plan: 'monthly' });
    expect(orderResponse.status).toBe(200);
    const order = (await orderResponse.json()) as Record<string, any>;
    expect(order.plan).toBe('monthly');
    expect(order.amountFen).toBe(990);
    expect(order.payment).toMatchObject({ sandbox: true, orderId: order.orderId });

    const accepted = await notify(baseUrl, {
      orderId: order.orderId,
      outcome: 'success',
      transactionId: 'wx-tx-1',
    });
    expect(accepted.status).toBe(200);

    const after = await getMembership(baseUrl, 'android', token);
    expect(after.membership).toMatchObject({ active: true, plan: 'monthly' });
    expect(Date.parse(after.membership.expiresAt)).toBe(clock + 30 * DAY);

    const advanced = await uploadAdvanced(baseUrl, token);
    expect(advanced.status).toBe(202);

    const taskId = await createTask(baseUrl, token);
    await waitForTask(baseUrl, taskId);
    const first = await createExport(baseUrl, token, { taskId, candidateId: 'detail' });
    const second = await createExport(baseUrl, token, { taskId, candidateId: 'color' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, any>;
    expect(secondBody.quota).toEqual({ limit: null, used: 0, remaining: null });
  });

  it('iOS 端只展示权益：不下发价格，也不能下单', async () => {
    const baseUrl = await startApp({ payment: createSandboxPaymentProvider() });
    const token = await login(baseUrl, 'ios-user');

    const view = await getMembership(baseUrl, 'ios', token);
    expect(view.purchaseAvailable).toBe(false);
    expect(view.plans).toEqual([]);
    expect(view.membership).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/9\.9|69|月卡|年卡/);

    const order = await createOrder(baseUrl, 'ios', token, { plan: 'monthly' });
    expect(order.status).toBe(403);
    const body = (await order.json()) as { error: { code: string } };
    expect(body.error.code).toBe('purchase-not-allowed');
  });

  it('会员到期后权益收回，已保存图纸仍可下载，导出回到免费额度', async () => {
    const baseUrl = await startApp({ payment: createSandboxPaymentProvider() });
    const token = await login(baseUrl, 'expiring-member');

    const order = (await (
      await createOrder(baseUrl, 'android', token, { plan: 'monthly' })
    ).json()) as Record<string, any>;
    await notify(baseUrl, { orderId: order.orderId, outcome: 'success', transactionId: 'wx-tx-2' });

    const taskId = await createTask(baseUrl, token);
    await waitForTask(baseUrl, taskId);
    const saved = await createExport(baseUrl, token, { taskId, candidateId: 'detail' });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { url: string };

    clock += 30 * DAY;
    const after = await getMembership(baseUrl, 'android', token);
    expect(after.membership.active).toBe(false);

    const advanced = await uploadAdvanced(baseUrl, token);
    expect(advanced.status).toBe(403);
    const blocked = (await advanced.json()) as { error: { code: string } };
    expect(blocked.error.code).toBe('advanced-not-allowed');

    const download = await fetch(`${baseUrl}${savedBody.url}`, {
      headers: { 'x-session-token': token },
    });
    expect(download.status).toBe(200);

    const first = await createExport(baseUrl, token, { taskId, candidateId: 'color' });
    expect(first.status).toBe(200);
    const second = await createExport(baseUrl, token, { taskId, candidateId: 'few' });
    expect(second.status).toBe(429);
  });

  it('支付取消或失败不改变会员状态，重复成功通知不重复延长', async () => {
    const baseUrl = await startApp({ payment: createSandboxPaymentProvider() });
    const token = await login(baseUrl, 'cancelling-payer');

    const cancelledOrder = (await (
      await createOrder(baseUrl, 'android', token, { plan: 'monthly' })
    ).json()) as Record<string, any>;
    const cancelled = await notify(baseUrl, { orderId: cancelledOrder.orderId, outcome: 'cancelled' });
    expect(cancelled.status).toBe(200);
    expect((await getMembership(baseUrl, 'android', token)).membership).toBeNull();

    // 取消后迟到的成功通知不应把已关闭订单变成有效会员。
    await notify(baseUrl, {
      orderId: cancelledOrder.orderId,
      outcome: 'success',
      transactionId: 'wx-late',
    });
    expect((await getMembership(baseUrl, 'android', token)).membership).toBeNull();

    const paidOrder = (await (
      await createOrder(baseUrl, 'android', token, { plan: 'yearly' })
    ).json()) as Record<string, any>;
    await notify(baseUrl, { orderId: paidOrder.orderId, outcome: 'success', transactionId: 'wx-tx-3' });
    const paidView = await getMembership(baseUrl, 'android', token);
    const firstExpiresAt = paidView.membership.expiresAt;

    await notify(baseUrl, { orderId: paidOrder.orderId, outcome: 'success', transactionId: 'wx-tx-3' });
    const repeated = await getMembership(baseUrl, 'android', token);
    expect(repeated.membership.expiresAt).toBe(firstExpiresAt);

    const unknown = await notify(baseUrl, { orderId: 'missing-order', outcome: 'success' });
    expect(unknown.status).toBe(400);
  });

  it('权益以服务端为准：换设备后状态一致，不同账号不串号', async () => {
    const baseUrl = await startApp({ payment: createSandboxPaymentProvider() });
    const firstDevice = await login(baseUrl, 'shared-account');
    const order = (await (
      await createOrder(baseUrl, 'android', firstDevice, { plan: 'monthly' })
    ).json()) as Record<string, any>;
    await notify(baseUrl, { orderId: order.orderId, outcome: 'success', transactionId: 'wx-tx-4' });

    const secondDevice = await login(baseUrl, 'shared-account');
    expect(secondDevice).not.toBe(firstDevice);
    const view = await getMembership(baseUrl, 'android', secondDevice);
    expect(view.membership.active).toBe(true);

    const taskId = await createTask(baseUrl, secondDevice);
    await waitForTask(baseUrl, taskId);
    expect((await createExport(baseUrl, secondDevice, { taskId, candidateId: 'detail' })).status).toBe(200);
    expect((await createExport(baseUrl, secondDevice, { taskId, candidateId: 'color' })).status).toBe(200);

    const other = await login(baseUrl, 'other-account');
    expect((await getMembership(baseUrl, 'android', other)).membership).toBeNull();
    expect((await uploadAdvanced(baseUrl, other)).status).toBe(403);
  });

  it('未配置支付渠道时不下发价格、不接受下单，也不会伪造开通', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'no-payment');

    const view = await getMembership(baseUrl, 'android', token);
    expect(view.purchaseAvailable).toBe(false);
    expect(view.plans).toEqual([]);

    const order = await createOrder(baseUrl, 'android', token, { plan: 'monthly' });
    expect(order.status).toBe(503);
    const body = (await order.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('payment-unavailable');
    expect(body.error.message).toContain('暂未开通');

    expect((await getMembership(baseUrl, 'android', token)).membership).toBeNull();
  });

  it('下单需要登录，未知套餐被拒绝', async () => {
    const baseUrl = await startApp({ payment: createSandboxPaymentProvider() });

    const anonymous = await createOrder(baseUrl, 'android', undefined, { plan: 'monthly' });
    expect(anonymous.status).toBe(401);

    const token = await login(baseUrl, 'bad-plan');
    const unknown = await createOrder(baseUrl, 'android', token, { plan: 'weekly' });
    expect(unknown.status).toBe(400);
    const body = (await unknown.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid-plan');
  });
});
