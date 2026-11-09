import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer } from '../src/server';
import type { Moderation } from '../src/moderation';
import type { Logger } from '../src/logger';
import mardPalette from '../src/data/mard.json';
import { getAdvancedPalette } from '../src/palette';
import type { PaletteTier, SizeTier } from '../src/types';

const BASE_CODE = /^(?:[A-H]|M)\d{2}$/;
const ADVANCED_CODES = new Set(getAdvancedPalette().map((color) => color.code));

const allowAll: Moderation = { check: async () => 'pass' };

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startApp(
  moderation: Moderation = allowAll,
  logger?: Logger,
  isAdvancedPaletteAllowed?: (openId?: string) => boolean,
): Promise<string> {
  server = createServer({ moderation, logger, isAdvancedPaletteAllowed });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** 白底中央红色方块，用来验证「主体可辨识」。 */
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

/** 连续渐变色块，用于验证三候选的色号数差异。 */
async function gradientPng(size = 256): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      raw[i] = Math.round((255 * x) / (size - 1));
      raw[i + 1] = Math.round((255 * y) / (size - 1));
      raw[i + 2] = (x * 7 + y * 13) % 256;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

interface UploadOptions {
  sizeTier?: SizeTier;
  paletteTier?: PaletteTier;
  token?: string;
}

function upload(baseUrl: string, image: Buffer, options: UploadOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-size-tier': options.sizeTier ?? 'small',
    'x-palette-tier': options.paletteTier ?? 'basic',
  };
  if (options.token) headers['x-session-token'] = options.token;
  return fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers,
    body: image,
  });
}

async function submit(baseUrl: string, image: Buffer, options: UploadOptions = {}): Promise<string> {
  const response = await upload(baseUrl, image, options);
  expect(response.status).toBe(202);
  const body = (await response.json()) as { taskId: string };
  expect(body.taskId).toBeTruthy();
  return body.taskId;
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

function paletteHex(code: string): string | undefined {
  return mardPalette.find((color) => color.code === code)?.hex;
}

function postEvent(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('云端生成接口', () => {
  it('一次生成返回三张 29×29 的基础档图纸，顺序固定且色号全部落在 MARD 221 内', async () => {
    const baseUrl = await startApp();
    const image = await redSquarePng();

    const taskId = await submit(baseUrl, image);
    const task = await waitForTask(baseUrl, taskId);

    expect(task.status).toBe('completed');
    const candidates = task.candidates as Array<any>;
    expect(candidates).toHaveLength(3);
    expect(candidates.map((item) => item.id)).toEqual(['detail', 'color', 'few']);

    const candidate = candidates[0];
    expect(candidate.id).toBe('detail');
    expect(candidate.paletteTier).toBe('basic');
    expect(candidate.width).toBe(29);
    expect(candidate.height).toBe(29);
    expect(candidate.grid).toHaveLength(29);
    for (const row of candidate.grid as string[][]) expect(row).toHaveLength(29);

    const codes = (candidate.grid as string[][]).flat();
    for (const code of codes) {
      expect(code).toMatch(BASE_CODE);
      expect(paletteHex(code)).toBeDefined();
    }

    // 用量统计必须与色号矩阵完全一致（独立重算一遍）
    const expectedUsage = new Map<string, number>();
    for (const code of codes) expectedUsage.set(code, (expectedUsage.get(code) ?? 0) + 1);
    const usage = candidate.usage as Array<{ code: string; count: number }>;
    expect(new Set(usage.map((item) => item.code))).toEqual(new Set(expectedUsage.keys()));
    for (const item of usage) expect(item.count).toBe(expectedUsage.get(item.code));
    expect(usage.reduce((sum, item) => sum + item.count, 0)).toBe(29 * 29);

    // 三张候选都必须满足同一份结构契约，且色号不越出 221 档
    for (const item of candidates) {
      expect(item.paletteTier).toBe('basic');
      expect(item.width).toBe(29);
      expect(item.height).toBe(29);
      const itemCodes = (item.grid as string[][]).flat();
      for (const code of itemCodes) {
        expect(code).toMatch(BASE_CODE);
        expect(paletteHex(code)).toBeDefined();
      }
      const itemUsage = item.usage as Array<{ code: string; count: number }>;
      expect(itemUsage.reduce((sum, entry) => sum + entry.count, 0)).toBe(29 * 29);
    }

    // 主体可辨识：中央红色区域被保留，白底也存在
    const hexOf = new Map((candidate.colors as Array<{ code: string; hex: string }>).map((c) => [c.code, c.hex]));
    const rgbOf = (code: string) => {
      const hex = hexOf.get(code)!;
      return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    };
    const hasRed = codes.some((code) => {
      const [r, g, b] = rgbOf(code);
      return r > 120 && g < 90 && b < 90;
    });
    const hasWhite = codes.some((code) => {
      const [r, g, b] = rgbOf(code);
      return r > 220 && g > 220 && b > 220;
    });
    expect(hasRed).toBe(true);
    expect(hasWhite).toBe(true);
  });

  it('三候选在色号数或降采样策略上互不相同', async () => {
    const baseUrl = await startApp();
    const taskId = await submit(baseUrl, await gradientPng());
    const task = await waitForTask(baseUrl, taskId);

    const candidates = task.candidates as Array<any>;
    const counts = candidates.map((item) => (item.usage as Array<unknown>).length);

    // 保少色号压到低值，保色彩层次限制在中等值，保主体细节可放开
    expect(counts[2]).toBeLessThanOrEqual(24);
    expect(counts[1]).toBeLessThanOrEqual(64);
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[2]);

    // 三张图的色号集合必须互不相同
    const signatures = new Set(
      candidates.map((item) => (item.usage as Array<{ code: string }>).map((entry) => entry.code).join(',')),
    );
    expect(signatures.size).toBe(3);
  });

  it('小/中/大成品尺寸档的格网与拼板数正确', async () => {
    const baseUrl = await startApp();
    const image = await redSquarePng();

    const cases = [
      { sizeTier: 'small' as const, grid: 29, boards: 1 },
      { sizeTier: 'medium' as const, grid: 58, boards: 4 },
      { sizeTier: 'large' as const, grid: 87, boards: 9 },
    ];
    for (const item of cases) {
      const task = await waitForTask(baseUrl, await submit(baseUrl, image, { sizeTier: item.sizeTier }));
      expect(task.status).toBe('completed');
      const candidate = task.candidates[0];
      expect(candidate.width).toBe(item.grid);
      expect(candidate.height).toBe(item.grid);
      expect(candidate.boardCount).toBe(item.boards);

      const usage = candidate.usage as Array<{ count: number }>;
      expect(usage.reduce((sum, entry) => sum + entry.count, 0)).toBe(item.grid * item.grid);
    }
  });

  it('291 档在白名单外被服务端拒绝，提示可理解', async () => {
    const baseUrl = await startApp();
    const response = await upload(baseUrl, await redSquarePng(), { paletteTier: 'advanced' });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('advanced-not-allowed');
    expect(body.error.message).toContain('291');
  });

  it('291 档白名单内出图，且全部色号落在 291 内', async () => {
    expect(ADVANCED_CODES.size).toBe(291);
    const baseUrl = await startApp(allowAll, undefined, () => true);
    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { paletteTier: 'advanced' }));

    expect(task.status).toBe('completed');
    for (const candidate of task.candidates as Array<any>) {
      expect(candidate.paletteTier).toBe('advanced');
      const codes = (candidate.grid as string[][]).flat();
      for (const code of codes) {
        expect(ADVANCED_CODES.has(code)).toBe(true);
      }
    }
  });

  it('命中内容安全时阻断任务，返回换图提示并留痕', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, data) => events.push({ event, data }),
      warn: (event, data) => events.push({ event, data }),
      audit: (event, data) => events.push({ event, data }),
    };
    const baseUrl = await startApp({ check: async () => 'block' }, logger);

    const response = await upload(baseUrl, await redSquarePng());
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('content-unsafe');
    expect(body.error.message).toContain('换一张');

    const blocked = events.find((event) => event.event === 'content_blocked');
    expect(blocked).toBeDefined();
    expect(String(blocked!.data?.contentKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不可用图片给出可理解的原因，且不产出候选', async () => {
    const baseUrl = await startApp();
    const taskId = await submit(baseUrl, Buffer.from('definitely not an image'));

    const task = await waitForTask(baseUrl, taskId);
    expect(task.status).toBe('failed');
    expect(task.candidates).toBeUndefined();
    expect(task.failure.code).toBe('image-unsupported');
    expect(task.failure.message).toContain('换一张');
  });

  it('选中候选与首图接受事件按契约留痕，非法事件被拒绝', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, data) => events.push({ event, data }),
      warn: (event, data) => events.push({ event, data }),
      audit: (event, data) => events.push({ event, data }),
    };
    const baseUrl = await startApp(allowAll, logger);
    const taskId = await submit(baseUrl, await redSquarePng());
    await waitForTask(baseUrl, taskId);

    const selected = await postEvent(baseUrl, {
      name: 'candidate_selected',
      taskId,
      candidateId: 'color',
      index: 1,
    });
    expect(selected.status).toBe(200);
    const selectedLog = events.find((event) => event.event === 'candidate_selected');
    expect(selectedLog?.data).toMatchObject({ taskId, candidateId: 'color', index: 1 });
    expect(typeof selectedLog?.data?.at).toBe('string');

    const accepted = await postEvent(baseUrl, {
      name: 'first_pattern_accepted',
      taskId,
      candidateId: 'detail',
      index: 0,
    });
    expect(accepted.status).toBe(200);
    expect(
      events.some((event) => event.event === 'first_pattern_accepted' && event.data?.candidateId === 'detail'),
    ).toBe(true);

    // 首图接受只允许第一张
    const wrongIndex = await postEvent(baseUrl, {
      name: 'first_pattern_accepted',
      taskId,
      candidateId: 'color',
      index: 1,
    });
    expect(wrongIndex.status).toBe(400);

    // 候选与任务结果不匹配
    const wrongCandidate = await postEvent(baseUrl, {
      name: 'candidate_selected',
      taskId,
      candidateId: 'detail',
      index: 1,
    });
    expect(wrongCandidate.status).toBe(400);

    // 不存在的任务
    const missingTask = await postEvent(baseUrl, {
      name: 'candidate_selected',
      taskId: 'missing-task',
      candidateId: 'detail',
      index: 0,
    });
    expect(missingTask.status).toBe(400);

    // 未知事件名
    const unknown = await postEvent(baseUrl, {
      name: 'whatever',
      taskId,
      candidateId: 'detail',
      index: 0,
    });
    expect(unknown.status).toBe(400);
  });

  it('同一张图重复提交复用同一任务，候选逐字段一致', async () => {
    const baseUrl = await startApp();
    const image = await redSquarePng();

    const first = await submit(baseUrl, image);
    const firstTask = await waitForTask(baseUrl, first);

    const second = await submit(baseUrl, image);
    expect(second).toBe(first);

    // 缓存命中后任务已是 completed，再查即得，候选与原任务完全一致
    const secondTask = await waitForTask(baseUrl, second);
    expect(secondTask.status).toBe('completed');
    expect(secondTask.candidates).toEqual(firstTask.candidates);
  });

  it('同一张图并发提交只创建一个任务', async () => {
    const baseUrl = await startApp();
    const image = await redSquarePng();

    const [first, second] = await Promise.all([submit(baseUrl, image), submit(baseUrl, image)]);
    expect(first).toBe(second);
  });
});
