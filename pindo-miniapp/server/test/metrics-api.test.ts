import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerOptions } from '../src/server';
import type { Moderation } from '../src/moderation';
import { MetricsStore } from '../src/metrics';
import { createSandboxPaymentProvider } from '../src/payment';
import { createFakeStyleProvider, type StyleProvider } from '../src/style';

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

async function startApp(options: Partial<ServerOptions> = {}): Promise<string> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  server = createServer({ moderation: allowAll, now: () => new Date(clock), ...options });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** 白底彩色方块；variant 让同一测试里的多张原图命中不同内容键。 */
async function subjectPng(variant = 0): Promise<Buffer> {
  const size = 48;
  const raw = Buffer.alloc(size * size * 3, 255);
  const start = 10 + (variant % 8);
  const square = 22;
  for (let y = start; y < start + square; y++) {
    for (let x = start; x < start + square; x++) {
      const i = (y * size + x) * 3;
      raw[i] = 170 + variant * 5;
      raw[i + 1] = 40 + variant * 3;
      raw[i + 2] = 60;
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
  return ((await response.json()) as { token: string }).token;
}

async function waitForTask(baseUrl: string, taskId: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
    const body = (await response.json()) as Record<string, any>;
    if (body.status === 'completed' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} did not finish in time`);
}

async function generate(
  baseUrl: string,
  token?: string,
  channel?: string,
  variant = 0,
  style?: string,
): Promise<Record<string, any>> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-size-tier': 'small',
    'x-palette-tier': 'basic',
  };
  if (token) headers['x-session-token'] = token;
  if (channel) headers['x-channel'] = channel;
  if (style) headers['x-style'] = style;
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers,
    body: await subjectPng(variant),
  });
  expect(response.status).toBe(202);
  const { taskId } = (await response.json()) as { taskId: string };
  return waitForTask(baseUrl, taskId);
}

async function acceptFirst(baseUrl: string, token: string, task: Record<string, any>): Promise<void> {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({
      name: 'first_pattern_accepted',
      taskId: task.taskId,
      candidateId: task.candidates[0].id,
      index: 0,
    }),
  });
  expect(response.status).toBe(200);
}

async function createExport(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify(body),
  });
}

function createOrder(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/membership/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-platform': 'android', 'x-session-token': token },
    body: JSON.stringify({ plan: 'monthly' }),
  });
}

function notify(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/membership/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function summary(
  baseUrl: string,
  adminToken: string,
  query: { from?: Date; to?: Date; channel?: string } = {},
): Promise<Record<string, any>> {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from.toISOString());
  if (query.to) params.set('to', query.to.toISOString());
  if (query.channel) params.set('channel', query.channel);
  const response = await fetch(`${baseUrl}/api/metrics/summary?${params.toString()}`, {
    headers: { 'x-admin-token': adminToken },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

function styleEntry(body: Record<string, any>, style: string): Record<string, any> {
  return body.byStyle.find((entry: any) => entry.style === style);
}

function blindTest(baseUrl: string, adminToken: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/metrics/blind-tests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
    body: JSON.stringify(body),
  });
}

async function getBlindTests(
  baseUrl: string,
  adminToken: string,
): Promise<Record<string, any>> {
  const response = await fetch(`${baseUrl}/api/metrics/blind-tests`, {
    headers: { 'x-admin-token': adminToken },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

async function reportFailureSample(
  baseUrl: string,
  token: string,
  taskId: string,
  image: Buffer,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/failure-samples`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-task-id': taskId, 'x-session-token': token },
    body: image,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { sampleId: string }).sampleId;
}

describe('埋点与验证看板', () => {
  it('首图接受率可按时间与渠道统计，非法渠道归入直接访问', async () => {
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({ adminToken });
    const xhsToken = await login(baseUrl, 'metrics-xhs');
    const dyToken = await login(baseUrl, 'metrics-douyin');

    const xhsTask = await generate(baseUrl, xhsToken, 'xiaohongshu', 0);
    await generate(baseUrl, dyToken, 'douyin', 1);
    await generate(baseUrl, undefined, 'Bad Channel!', 2);
    await acceptFirst(baseUrl, xhsToken, xhsTask);

    const xhs = await summary(baseUrl, adminToken, { channel: 'xiaohongshu' });
    expect(xhs.generation).toEqual({ tasks: 1, users: 1 });
    expect(xhs.firstAcceptance).toEqual({ count: 1, rate: 1 });

    const douyin = await summary(baseUrl, adminToken, { channel: 'douyin' });
    expect(douyin.generation).toEqual({ tasks: 1, users: 1 });
    expect(douyin.firstAcceptance).toEqual({ count: 0, rate: 0 });

    const direct = await summary(baseUrl, adminToken, { channel: 'direct' });
    expect(direct.generation).toEqual({ tasks: 1, users: 0 });

    const all = await summary(baseUrl, adminToken);
    expect(all.generation).toEqual({ tasks: 3, users: 2 });
    expect(all.firstAcceptance.count).toBe(1);
    expect(all.firstAcceptance.rate).toBeCloseTo(1 / 3, 10);

    const future = await summary(baseUrl, adminToken, { from: new Date(clock + DAY) });
    expect(future.generation.tasks).toBe(0);
    expect(future.firstAcceptance.rate).toBeNull();
  });

  it('生成到付费漏斗可查，含免费额度耗尽到会员开通的转化', async () => {
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({ adminToken, payment: createSandboxPaymentProvider() });
    const token = await login(baseUrl, 'funnel-user');

    const firstTask = await generate(baseUrl, token, 'xiaohongshu', 0);
    await generate(baseUrl, token, 'xiaohongshu', 1);

    expect(
      (await createExport(baseUrl, token, { taskId: firstTask.taskId, candidateId: 'detail' })).status,
    ).toBe(200);
    const second = await generate(baseUrl, token, 'xiaohongshu', 2);
    expect(
      (await createExport(baseUrl, token, { taskId: second.taskId, candidateId: 'detail' })).status,
    ).toBe(429);

    const orderResponse = await createOrder(baseUrl, token);
    expect(orderResponse.status).toBe(200);
    const order = (await orderResponse.json()) as { orderId: string };
    expect(
      (await notify(baseUrl, { orderId: order.orderId, outcome: 'success', transactionId: 'wx-funnel' }))
        .status,
    ).toBe(200);

    const funnel = (await summary(baseUrl, adminToken, { channel: 'xiaohongshu' })).funnel;
    expect(funnel.generatedUsers).toBe(1);
    expect(funnel.quotaExhaustedUsers).toBe(1);
    expect(funnel.paidUsers).toBe(1);
    expect(funnel.quotaToPaidUsers).toBe(1);
    expect(funnel.quotaToPaidRate).toBe(1);
  });

  it('7 日内二次生成按同一用户计算，匿名生成不计入用户', async () => {
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({ adminToken });
    const repeatUser = await login(baseUrl, 'retention-repeat');
    const slowUser = await login(baseUrl, 'retention-slow');

    await generate(baseUrl, repeatUser, 'direct', 0);
    await generate(baseUrl, slowUser, 'direct', 1);
    clock += 3 * DAY;
    await generate(baseUrl, repeatUser, 'direct', 2);
    clock += 5 * DAY;
    await generate(baseUrl, slowUser, 'direct', 3);
    await generate(baseUrl, undefined, 'direct', 4);

    const view = await summary(baseUrl, adminToken, {
      from: new Date(Date.parse('2026-11-09T02:00:00.000Z')),
      to: new Date(Date.parse('2026-11-09T02:00:00.000Z') + DAY),
    });
    expect(view.retention).toMatchObject({ windowDays: 7, eligibleUsers: 2, repeatUsers: 1 });
    expect(view.retention.rate).toBe(0.5);
  });

  it('盲测记录可录入并自动计算 pairwise 胜率', async () => {
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({ adminToken });

    for (const [testerId, winner] of [
      ['t1', 'ours'],
      ['t2', 'ours'],
      ['t3', 'competitor'],
      ['t4', 'tie'],
    ] as const) {
      expect(
        (await blindTest(baseUrl, adminToken, { testerId, group: 'g1', competitor: 'baseline', winner }))
          .status,
      ).toBe(201);
    }

    const first = await getBlindTests(baseUrl, adminToken);
    expect(first.total).toBe(4);
    expect(first.testers).toBe(4);
    expect(first.groups).toBe(1);
    expect(first.competitors).toEqual([
      { competitor: 'baseline', wins: 2, losses: 1, ties: 1, winRate: 2 / 3 },
    ]);

    // 同一测试者对同一组同一对比项重复提交按覆盖处理，不重复计数。
    expect(
      (await blindTest(baseUrl, adminToken, {
        testerId: 't3',
        group: 'g1',
        competitor: 'baseline',
        winner: 'ours',
      })).status,
    ).toBe(201);
    const updated = await getBlindTests(baseUrl, adminToken);
    expect(updated.total).toBe(4);
    expect(updated.competitors[0]).toMatchObject({ wins: 3, losses: 0, ties: 1, winRate: 1 });

    const invalid = await blindTest(baseUrl, adminToken, {
      testerId: 't5',
      group: 'g1',
      competitor: 'baseline',
      winner: 'maybe',
    });
    expect(invalid.status).toBe(400);
  });

  it('看板按风格拆分生成量、用户数与接受率，并叠加时间与渠道过滤', async () => {
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({ adminToken, style: createFakeStyleProvider() });
    const token = await login(baseUrl, 'style-viewer');

    await generate(baseUrl, token, 'xiaohongshu', 0);
    const animeTask = await generate(baseUrl, token, 'xiaohongshu', 1, 'anime');
    await generate(baseUrl, token, 'douyin', 2, 'chibi');
    await acceptFirst(baseUrl, token, animeTask);

    const xhs = await summary(baseUrl, adminToken, { channel: 'xiaohongshu' });
    expect(styleEntry(xhs, 'original')).toMatchObject({
      generation: { tasks: 1, users: 1 },
      firstAcceptance: { count: 0, rate: 0 },
      styleFailure: { count: 0, rate: 0 },
    });
    expect(styleEntry(xhs, 'anime')).toMatchObject({
      generation: { tasks: 1, users: 1 },
      firstAcceptance: { count: 1, rate: 1 },
      styleFailure: { count: 0, rate: 0 },
    });
    expect(styleEntry(xhs, 'chibi')).toMatchObject({
      generation: { tasks: 0, users: 0 },
      firstAcceptance: { count: 0, rate: null },
      styleFailure: { count: 0, rate: null },
    });

    const douyin = await summary(baseUrl, adminToken, { channel: 'douyin' });
    expect(styleEntry(douyin, 'chibi')).toMatchObject({ generation: { tasks: 1, users: 1 } });
    expect(styleEntry(douyin, 'anime')).toMatchObject({ generation: { tasks: 0, users: 0 } });

    // 时间与渠道同时生效时仍按风格拆分。
    const combined = await summary(baseUrl, adminToken, {
      channel: 'xiaohongshu',
      from: new Date(clock - 60_000),
    });
    expect(styleEntry(combined, 'anime')).toMatchObject({
      generation: { tasks: 1, users: 1 },
      firstAcceptance: { count: 1, rate: 1 },
      styleFailure: { count: 0, rate: 0 },
    });
    expect(styleEntry(combined, 'chibi')).toMatchObject({ generation: { tasks: 0, users: 0 } });

    const future = await summary(baseUrl, adminToken, {
      channel: 'xiaohongshu',
      from: new Date(clock + DAY),
    });
    for (const entry of future.byStyle) {
      expect(entry.generation.tasks).toBe(0);
      expect(entry.firstAcceptance.rate).toBeNull();
      expect(entry.styleFailure.rate).toBeNull();
    }
  });

  it('看板按风格统计风格化失败次数与失败率，同一任务只计一次', async () => {
    const base = createFakeStyleProvider();
    const flaky: StyleProvider = {
      available: true,
      version: 'flaky-v1',
      async stylize(input) {
        if (input.style === 'chibi') throw new Error('provider down');
        return base.stylize(input);
      },
    };
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({ adminToken, style: flaky });
    const token = await login(baseUrl, 'style-failure');

    await generate(baseUrl, token, 'xiaohongshu', 0, 'anime');
    const failed = await generate(baseUrl, token, 'xiaohongshu', 1, 'chibi');
    expect(failed.status).toBe('failed');
    expect(failed.failure.code).toBe('style-failed');

    const xhs = await summary(baseUrl, adminToken, { channel: 'xiaohongshu' });
    expect(styleEntry(xhs, 'anime')).toMatchObject({
      generation: { tasks: 1, users: 1 },
      styleFailure: { count: 0, rate: 0 },
    });
    expect(styleEntry(xhs, 'chibi')).toMatchObject({
      generation: { tasks: 0, users: 0 },
      styleFailure: { count: 1, rate: 1 },
    });

    const douyin = await summary(baseUrl, adminToken, { channel: 'douyin' });
    expect(styleEntry(douyin, 'chibi')).toMatchObject({ styleFailure: { count: 0, rate: null } });

    // 时间与渠道同时生效时仍按风格统计失败。
    const combined = await summary(baseUrl, adminToken, {
      channel: 'xiaohongshu',
      from: new Date(clock - 60_000),
    });
    expect(styleEntry(combined, 'chibi')).toMatchObject({ styleFailure: { count: 1, rate: 1 } });

    // 同一任务重复上报只计一次。
    const store = new MetricsStore();
    store.recordStyleFailure({ taskId: 'style-task', channel: 'direct', style: 'chibi', at: clock });
    store.recordStyleFailure({ taskId: 'style-task', channel: 'direct', style: 'chibi', at: clock });
    expect(styleEntry(store.summary(), 'chibi')!.styleFailure.count).toBe(1);
  });

  it('风格化内容不合规按独立失败原因结束，不混入风格化失败次数', async () => {
    // 只在风格图（PNG）复核时拦截，原图上传仍放行。
    const blockStyledOutput: Moderation = {
      check: async ({ contentType }) => (contentType === 'image/png' ? 'block' : 'pass'),
    };
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({
      adminToken,
      style: createFakeStyleProvider(),
      moderation: blockStyledOutput,
    });
    const token = await login(baseUrl, 'style-blocked');

    await generate(baseUrl, token, 'xiaohongshu', 0);
    const blocked = await generate(baseUrl, token, 'xiaohongshu', 1, 'anime');
    expect(blocked.status).toBe('failed');
    expect(blocked.failure.code).toBe('style-blocked');

    const view = await summary(baseUrl, adminToken, { channel: 'xiaohongshu' });
    expect(styleEntry(view, 'original')).toMatchObject({ generation: { tasks: 1, users: 1 } });
    expect(styleEntry(view, 'anime')).toMatchObject({
      generation: { tasks: 0, users: 0 },
      styleFailure: { count: 0, rate: null },
    });
  });

  it('失败样本可按时间导出 CSV', async () => {
    const adminToken = 'metrics-admin';
    const baseUrl = await startApp({ adminToken, style: createFakeStyleProvider() });
    const token = await login(baseUrl, 'failure-owner');
    const task = await generate(baseUrl, token, 'xiaohongshu', 0, 'anime');
    const sampleId = await reportFailureSample(baseUrl, token, task.taskId, await subjectPng(0));

    const listResponse = await fetch(`${baseUrl}/api/failure-samples?limit=20`, {
      headers: { 'x-admin-token': adminToken },
    });
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as { samples: Array<Record<string, any>> };
    expect(list.samples[0]).toMatchObject({
      taskId: task.taskId,
      style: 'anime',
    });

    const from = new Date(clock - 60_000);
    const to = new Date(clock + 60_000);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    const response = await fetch(`${baseUrl}/api/failure-samples/export?${params.toString()}`, {
      headers: { 'x-admin-token': adminToken },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');

    const lines = (await response.text()).trim().split('\n');
    expect(lines[0]).toBe(
      'sampleId,taskId,openId,sizeTier,paletteTier,settings,createdAt,imageUrl,style',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(sampleId);
    expect(lines[1]).toContain(task.taskId);
    expect(lines[1]).toContain(`/api/failure-samples/${sampleId}/image`);
    expect(lines[1]).toContain('""dithering"":');
    expect(lines[1].endsWith(',anime')).toBe(true);

    const future = new URLSearchParams({
      from: new Date(clock + DAY).toISOString(),
      to: new Date(clock + 2 * DAY).toISOString(),
    });
    const empty = await fetch(`${baseUrl}/api/failure-samples/export?${future.toString()}`, {
      headers: { 'x-admin-token': adminToken },
    });
    expect(empty.status).toBe(200);
    expect((await empty.text()).trim().split('\n')).toHaveLength(1);
  });

  it('看板接口仅在配置后台口令后开放', async () => {
    const disabled = await startApp();
    for (const path of [
      '/api/metrics/summary',
      '/api/metrics/blind-tests',
      '/api/failure-samples/export',
    ]) {
      expect((await fetch(`${disabled}${path}`)).status).toBe(404);
    }

    const adminToken = 'metrics-secret';
    const baseUrl = await startApp({ adminToken });
    expect((await fetch(`${baseUrl}/api/metrics/summary`)).status).toBe(403);
    expect(
      (await fetch(`${baseUrl}/api/metrics/summary`, {
        headers: { 'x-admin-token': 'wrong' },
      })).status,
    ).toBe(403);
    expect(
      (await fetch(`${baseUrl}/api/metrics/summary`, {
        headers: { 'x-admin-token': adminToken },
      })).status,
    ).toBe(200);
  });
});
