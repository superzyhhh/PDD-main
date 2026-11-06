import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer } from '../src/server';
import type { Moderation } from '../src/moderation';
import type { Logger } from '../src/logger';
import mardPalette from '../src/data/mard.json';

const BASE_CODE = /^(?:[A-H]|M)\d{2}$/;

const allowAll: Moderation = { check: async () => 'pass' };

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startApp(moderation: Moderation = allowAll, logger?: Logger): Promise<string> {
  server = createServer({ moderation, logger });
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

function upload(baseUrl: string, image: Buffer): Promise<Response> {
  return fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-size-tier': 'small',
      'x-palette-tier': 'basic',
    },
    body: image,
  });
}

async function submit(baseUrl: string, image: Buffer): Promise<string> {
  const response = await upload(baseUrl, image);
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

describe('云端生成接口', () => {
  it('返回一张 29×29 的基础档图纸，色号全部落在 MARD 221 内', async () => {
    const baseUrl = await startApp();
    const image = await redSquarePng();

    const taskId = await submit(baseUrl, image);
    const task = await waitForTask(baseUrl, taskId);

    expect(task.status).toBe('completed');
    const candidates = task.candidates as Array<any>;
    expect(candidates).toHaveLength(1);

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

  it('同一张图重复提交复用同一任务，不重复计算', async () => {
    const baseUrl = await startApp();
    const image = await redSquarePng();

    const first = await submit(baseUrl, image);
    await waitForTask(baseUrl, first);

    const second = await submit(baseUrl, image);
    expect(second).toBe(first);
  });

  it('同一张图并发提交只创建一个任务', async () => {
    const baseUrl = await startApp();
    const image = await redSquarePng();

    const [first, second] = await Promise.all([submit(baseUrl, image), submit(baseUrl, image)]);
    expect(first).toBe(second);
  });
});
