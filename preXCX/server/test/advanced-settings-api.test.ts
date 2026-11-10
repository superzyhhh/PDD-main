import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer, type ServerOptions } from '../src/server';
import { listenOnRandomPort } from './support/listen';
import type { Moderation } from '../src/moderation';

const allowAll: Moderation = { check: async () => 'pass' };

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startApp(options: Partial<ServerOptions> = {}): Promise<string> {
  server = createServer({ moderation: allowAll, ...options });
  await listenOnRandomPort(server!);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** 有明暗渐变的图，高级参数才有可见差异。 */
async function detailedPng(variant = 0): Promise<Buffer> {
  const size = 64;
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      raw[i] = (x * 4 + variant * 17) % 256;
      raw[i + 1] = (y * 4 + variant * 9) % 256;
      raw[i + 2] = ((x + y) * 2 + variant * 5) % 256;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/** 白底红方块：背景处理会改变裁切范围，结果必然不同。 */
async function subjectPng(): Promise<Buffer> {
  const size = 64;
  const raw = Buffer.alloc(size * size * 3, 255);
  for (let y = 20; y < 44; y++) {
    for (let x = 20; x < 44; x++) {
      const i = (y * size + x) * 3;
      raw[i] = 200;
      raw[i + 1] = 30;
      raw[i + 2] = 30;
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

async function submit(
  baseUrl: string,
  token: string | undefined,
  image: Buffer,
  settings?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-size-tier': 'small',
  };
  if (token) headers['x-session-token'] = token;
  if (settings !== undefined) {
    headers['x-advanced-settings'] = typeof settings === 'string' ? settings : JSON.stringify(settings);
  }
  return fetch(`${baseUrl}/api/generate`, { method: 'POST', headers, body: image });
}

async function generate(
  baseUrl: string,
  token: string | undefined,
  image: Buffer,
  settings?: unknown,
): Promise<Record<string, any>> {
  const response = await submit(baseUrl, token, image, settings);
  expect(response.status).toBe(202);
  const { taskId } = (await response.json()) as { taskId: string };
  return waitForTask(baseUrl, taskId);
}

function reportSample(
  baseUrl: string,
  token: string | undefined,
  taskId: string,
  image: Buffer,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'image/png',
    'x-task-id': taskId,
  };
  if (token) headers['x-session-token'] = token;
  return fetch(`${baseUrl}/api/failure-samples`, { method: 'POST', headers, body: image });
}

async function listSamples(baseUrl: string, adminToken?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/failure-samples?limit=20`, {
    headers: adminToken ? { 'x-admin-token': adminToken } : {},
  });
}

describe('高级设置', () => {
  it('默认全自动并随任务回显，客户端可确认本次生成用了什么设置', async () => {
    const baseUrl = await startApp();
    const task = await generate(baseUrl, undefined, await detailedPng());
    expect(task.settings).toEqual({
      dithering: 'auto',
      background: 'auto',
      maxColors: 'auto',
      downscale: 'auto',
      series: [],
    });
  });

  it('色号上限生效，同图同参复用任务，换参数重新生成', async () => {
    const baseUrl = await startApp();
    const image = await detailedPng(1);

    const plain = await generate(baseUrl, undefined, image);
    const capped = await generate(baseUrl, undefined, image, { maxColors: 8 });
    expect(capped.taskId).not.toBe(plain.taskId);
    expect(capped.settings.maxColors).toBe(8);
    for (const candidate of capped.candidates) {
      expect(candidate.colors.length).toBeLessThanOrEqual(8);
    }

    const repeated = await generate(baseUrl, undefined, image, { maxColors: 8 });
    expect(repeated.taskId).toBe(capped.taskId);

    const dithered = await generate(baseUrl, undefined, image, { dithering: 'none' });
    expect(dithered.taskId).not.toBe(capped.taskId);
  });

  it('背景处理改变裁切范围，生成结果随之不同', async () => {
    const baseUrl = await startApp();
    const image = await subjectPng();

    const auto = await generate(baseUrl, undefined, image);
    const keep = await generate(baseUrl, undefined, image, { background: 'keep' });
    expect(keep.taskId).not.toBe(auto.taskId);
    expect(keep.candidates[0].grid).not.toEqual(auto.candidates[0].grid);
  });

  it('系列色过滤只保留所选系列', async () => {
    const baseUrl = await startApp();
    const task = await generate(baseUrl, undefined, await detailedPng(2), { series: ['A'] });

    expect(task.settings.series).toEqual(['A']);
    for (const candidate of task.candidates) {
      for (const color of candidate.colors) {
        expect(color.code.startsWith('A')).toBe(true);
      }
    }
  });

  it('非法高级设置返回 400，不影响已有图纸', async () => {
    const baseUrl = await startApp();
    const image = await detailedPng(3);

    const badDithering = await submit(baseUrl, undefined, image, '{"dithering":"bogus"}');
    expect(badDithering.status).toBe(400);
    expect(((await badDithering.json()) as any).error.code).toBe('invalid-settings');

    const badMaxColors = await submit(baseUrl, undefined, image, { maxColors: 2 });
    expect(badMaxColors.status).toBe(400);

    const badSeries = await submit(baseUrl, undefined, image, { series: ['ZZ'] });
    expect(badSeries.status).toBe(400);
    expect(((await badSeries.json()) as any).error.code).toBe('invalid-settings');
  });
});

describe('失败样本', () => {
  it('三候选全不满意时留档原图、参数与三候选，后台可按时间倒序查询', async () => {
    const adminToken = 'test-admin-token';
    const baseUrl = await startApp({ adminToken });
    const token = await login(baseUrl, 'sample-user');
    const otherToken = await login(baseUrl, 'sample-other');

    const firstImage = await detailedPng(4);
    const secondImage = await detailedPng(5);
    const anonymousImage = await detailedPng(6);

    const first = await generate(baseUrl, token, firstImage, { maxColors: 16 });
    const second = await generate(baseUrl, token, secondImage, { series: ['A'] });
    const anonymous = await generate(baseUrl, undefined, anonymousImage);

    expect((await reportSample(baseUrl, token, first.taskId, firstImage)).status).toBe(201);
    expect((await reportSample(baseUrl, token, second.taskId, secondImage)).status).toBe(201);
    expect((await reportSample(baseUrl, undefined, anonymous.taskId, anonymousImage)).status).toBe(201);

    // 不能替别人的图纸提交反馈。
    const forbidden = await reportSample(baseUrl, otherToken, first.taskId, firstImage);
    expect(forbidden.status).toBe(403);

    const noToken = await listSamples(baseUrl);
    expect(noToken.status).toBe(403);
    const wrongToken = await listSamples(baseUrl, 'wrong-token');
    expect(wrongToken.status).toBe(403);

    const response = await listSamples(baseUrl, adminToken);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { samples: Array<Record<string, any>> };
    expect(body.samples).toHaveLength(3);
    expect(body.samples[0].taskId).toBe(anonymous.taskId);

    const firstSample = body.samples.find((sample) => sample.taskId === first.taskId);
    expect(firstSample).toBeTruthy();
    expect(firstSample!.settings.maxColors).toBe(16);
    expect(firstSample!.candidates).toHaveLength(3);
    expect(firstSample!.sizeTier).toBe('small');
    expect(typeof firstSample!.imageUrl).toBe('string');

    const download = await fetch(`${baseUrl}${firstSample!.imageUrl}`, {
      headers: { 'x-admin-token': adminToken },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(firstImage)).toBe(true);

    const withoutAdmin = await fetch(`${baseUrl}${firstSample!.imageUrl}`);
    expect(withoutAdmin.status).toBe(403);
  });

  it('后台口令未配置时不开放失败样本查询', async () => {
    const baseUrl = await startApp();
    const response = await listSamples(baseUrl, 'anything');
    expect(response.status).toBe(404);
  });

  it('同一任务重复进入不满意只留档一份', async () => {
    const adminToken = 'dedupe-admin';
    const baseUrl = await startApp({ adminToken });
    const token = await login(baseUrl, 'dedupe-user');
    const image = await detailedPng(3);
    const task = await generate(baseUrl, token, image);

    const first = await reportSample(baseUrl, token, task.taskId, image);
    const second = await reportSample(baseUrl, token, task.taskId, image);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { sampleId: string };
    const secondBody = (await second.json()) as { sampleId: string };
    expect(secondBody.sampleId).toBe(firstBody.sampleId);

    const body = (await (await listSamples(baseUrl, adminToken)).json()) as {
      samples: Array<Record<string, any>>;
    };
    expect(body.samples).toHaveLength(1);
  });

  it('图纸未完成或不存在时不能提交失败样本', async () => {
    const baseUrl = await startApp();
    const missing = await reportSample(baseUrl, undefined, 'missing-task', await detailedPng(7));
    expect(missing.status).toBe(404);
  });
});
