import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer, type ServerOptions } from '../src/server';
import { listenOnRandomPort } from './support/listen';
import type { Moderation } from '../src/moderation';
import {
  STYLE_IDS,
  STYLE_WORKING_SIZE,
  createFakeStyleProvider,
  styleCacheKey,
  type StyleProvider,
} from '../src/style';

const allowAll: Moderation = { check: async () => 'pass' };

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startApp(options: Partial<ServerOptions> = {}): Promise<string> {
  server = createServer({
    moderation: allowAll,
    // 多数用例验证生成行为而非授权，显式放开白名单；授权用例自身覆盖该参数。
    isAdvancedStyleAllowed: () => true,
    ...options,
  });
  await listenOnRandomPort(server!);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** 白底中央红色方块，用来完成一次稳定生成。 */
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

interface UploadOptions {
  sizeTier?: string;
  paletteTier?: string;
  style?: string;
  settings?: unknown;
}

function upload(baseUrl: string, image: Buffer, options: UploadOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-size-tier': options.sizeTier ?? 'small',
    'x-palette-tier': options.paletteTier ?? 'basic',
  };
  if (options.style) headers['x-style'] = options.style;
  if (options.settings) headers['x-advanced-settings'] = JSON.stringify(options.settings);
  return fetch(`${baseUrl}/api/generate`, { method: 'POST', headers, body: image });
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

/** 记录风格服务调用参数，内部仍用确定性假实现产出可解码图片。 */
function recordingProvider(inner: StyleProvider = createFakeStyleProvider()): {
  provider: StyleProvider;
  calls: Array<{ style: string; contentType: string; buffer: Buffer }>;
} {
  const calls: Array<{ style: string; contentType: string; buffer: Buffer }> = [];
  const provider: StyleProvider = {
    ...inner,
    async stylize(input) {
      calls.push({ style: input.style, contentType: input.contentType, buffer: input.buffer });
      return inner.stylize(input);
    },
  };
  return { provider, calls };
}

describe('风格族选择与风格服务骨架', () => {
  it('默认按原图生成，任务结果回传原图且仍为三候选', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng()));

    expect(task.status).toBe('completed');
    expect(task.style).toBe('original');
    expect(task.candidates).toHaveLength(3);
    expect(calls).toHaveLength(0);
  });

  it('非法风格返回可识别的参数错误', async () => {
    const baseUrl = await startApp({ style: recordingProvider().provider });

    const response = await upload(baseUrl, await redSquarePng(), { style: 'watercolor' });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid-style');
    expect(body.error.message).toContain('风格');
  });

  it('未配置生成式服务时选择高级风格返回明确的不可用提示', async () => {
    const baseUrl = await startApp();

    const response = await upload(baseUrl, await redSquarePng(), { style: 'anime' });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('style-unavailable');
    expect(body.error.message).toContain('高级风格');
  });

  it('免费风格不依赖生成式服务，未配置时仍能完成转换且不标记 AI', async () => {
    const baseUrl = await startApp();

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { style: 'chibi' }));

    expect(task.status).toBe('completed');
    expect(task.style).toBe('chibi');
    expect(task.aiStyled).toBe(false);
    expect(task.candidates).toHaveLength(3);
  });

  it('免费风格由本地算法完成，不调用生成式服务', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { style: 'line' }));

    expect(task.status).toBe('completed');
    expect(task.style).toBe('line');
    expect(calls).toHaveLength(0);
  });

  it('非原图风格先生成风格图再出图，仍恰好三候选且尺寸与色卡规则不变', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const task = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));

    expect(task.status).toBe('completed');
    expect(task.style).toBe('anime');
    expect(task.styleLabel).toBe('动漫风');
    expect(task.aiStyled).toBe(true);
    expect(task.candidates).toHaveLength(3);
    expect(task.candidates.map((item: any) => item.id)).toEqual(['detail', 'color', 'few']);
    for (const candidate of task.candidates as Array<any>) {
      expect(candidate.width).toBe(29);
      expect(candidate.height).toBe(29);
      expect(candidate.boardCount).toBe(1);
      expect(candidate.paletteTier).toBe('basic');
    }

    // 风格服务拿到的是解码摆正后的 PNG，一次生成只调用一次。
    expect(calls).toHaveLength(1);
    expect(calls[0].style).toBe('anime');
    expect(calls[0].contentType).toBe('image/png');
    expect(calls[0].buffer.length).toBeGreaterThan(0);
  });

  it('换风格产生新任务，不命中旧风格的结果', async () => {
    const baseUrl = await startApp({ style: recordingProvider().provider });
    const image = await redSquarePng();

    const originalTaskId = await submit(baseUrl, image);
    const animeTaskId = await submit(baseUrl, image, { style: 'anime' });

    expect(animeTaskId).not.toBe(originalTaskId);
    const original = await waitForTask(baseUrl, originalTaskId);
    const anime = await waitForTask(baseUrl, animeTaskId);
    expect(original.style).toBe('original');
    expect(anime.style).toBe('anime');
  });

  it('风格图输出被内容安全拦截时，任务以不合规原因结束且不产出候选', async () => {
    let checks = 0;
    const moderation: Moderation = {
      check: async () => {
        checks += 1;
        return checks === 1 ? 'pass' : 'block';
      },
    };
    const baseUrl = await startApp({ moderation, style: createFakeStyleProvider() });

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.candidates).toBeUndefined();
    expect(task.failure.code).toBe('style-blocked');
    expect(task.failure.message).toContain('换一张');
    expect(checks).toBe(2);
  });

  it('权益接口按层级下发免费风格与高级风格', async () => {
    const baseUrl = await startApp({ style: createFakeStyleProvider() });

    const response = await fetch(`${baseUrl}/api/membership`, { headers: { 'x-platform': 'android' } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      styles: {
        groups: Array<{
          group: string;
          label: string;
          options: Array<{
            id: string;
            label: string;
            group: string;
            requiresGenerativeModel: boolean;
          }>;
        }>;
      };
    };
    expect(body.styles.groups.map((group) => group.group)).toEqual(['free', 'advanced']);
    expect(body.styles.groups[0].options.map((item) => item.id)).toEqual([
      'original',
      'chibi',
      'line',
      'flat',
      'pixel',
    ]);
    expect(body.styles.groups[1].options.map((item) => item.id)).toEqual(['anime', 'realistic']);
    for (const group of body.styles.groups) {
      expect(group.label).toBeTruthy();
      for (const option of group.options) {
        expect(option.label).toBeTruthy();
        expect(option.group).toBe(group.group);
        expect(option.requiresGenerativeModel).toBe(group.group === 'advanced');
      }
    }
    const allIds = body.styles.groups.reduce<string[]>(
      (all, group) => all.concat(group.options.map((item) => item.id)),
      [],
    );
    expect(allIds.slice().sort()).toEqual([...STYLE_IDS].sort());
  });

  it('权益接口在未配置生成式服务时只下发免费风格', async () => {
    const baseUrl = await startApp();

    const response = await fetch(`${baseUrl}/api/membership`, { headers: { 'x-platform': 'android' } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      styles: { groups: Array<{ group: string; options: Array<{ id: string }> }> };
    };
    expect(body.styles.groups.map((group) => group.group)).toEqual(['free']);
    expect(body.styles.groups[0].options.map((item) => item.id)).toEqual([
      'original',
      'chibi',
      'line',
      'flat',
      'pixel',
    ]);
  });

  it('未授权时高级风格不下发且提交被拒绝', async () => {
    const baseUrl = await startApp({
      style: createFakeStyleProvider(),
      isAdvancedStyleAllowed: () => false,
    });

    const info = (await (
      await fetch(`${baseUrl}/api/membership`, { headers: { 'x-platform': 'android' } })
    ).json()) as { styles: { groups: Array<{ group: string }> } };
    expect(info.styles.groups.map((group) => group.group)).toEqual(['free']);

    const response = await upload(baseUrl, await redSquarePng(), { style: 'anime' });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('style-forbidden');
  });
});

describe('风格缓存与失败降级', () => {
  it('同图同风格同参数重复提交复用任务，不重复调用风格服务', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const firstId = await submit(baseUrl, image, { style: 'anime' });
    await waitForTask(baseUrl, firstId);

    const response = await upload(baseUrl, image, { style: 'anime' });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { taskId: string };
    expect(body.taskId).toBe(firstId);
    expect(calls).toHaveLength(1);
  });

  it('仅改成品尺寸档时复用已风格化的图片，不重复调用风格服务', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const small = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    const medium = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'anime', sizeTier: 'medium' }),
    );

    expect(small.status).toBe('completed');
    expect(medium.status).toBe('completed');
    expect(small.style).toBe('anime');
    expect(medium.style).toBe('anime');
    expect(medium.candidates[0].width).toBeGreaterThan(small.candidates[0].width);
    expect(calls).toHaveLength(1);
  });

  it('仅改色卡档时复用已风格化的图片，不重复调用风格服务', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider, isAdvancedPaletteAllowed: () => true });
    const image = await redSquarePng();

    const basic = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'anime', paletteTier: 'basic' }),
    );
    const advanced = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'anime', paletteTier: 'advanced' }),
    );

    expect(advanced.status).toBe('completed');
    expect(basic.candidates[0].paletteTier).toBe('basic');
    expect(advanced.candidates[0].paletteTier).toBe('advanced');
    expect(calls).toHaveLength(1);
  });

  it('仅改高级设置时复用已风格化的图片，不重复调用风格服务', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const defaults = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    const tuned = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'anime', settings: { maxColors: 20 } }),
    );

    expect(defaults.status).toBe('completed');
    expect(tuned.status).toBe('completed');
    expect(tuned.settings.maxColors).toBe(20);
    expect(calls).toHaveLength(1);
  });

  it('同图同风格的并发请求只调用一次风格服务', async () => {
    const inner = createFakeStyleProvider();
    let calls = 0;
    const provider: StyleProvider = {
      available: true,
      version: 'slow-v1',
      timeoutMs: 2000,
      async stylize(input) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return inner.stylize(input);
      },
    };
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const [smallId, mediumId] = await Promise.all([
      submit(baseUrl, image, { style: 'anime' }),
      submit(baseUrl, image, { style: 'anime', sizeTier: 'medium' }),
    ]);
    await Promise.all([waitForTask(baseUrl, smallId), waitForTask(baseUrl, mediumId)]);

    expect(calls).toBe(1);
  });

  it('风格化失败不写入缓存，重试会再次调用风格服务', async () => {
    let attempts = 0;
    const inner = createFakeStyleProvider();
    const provider: StyleProvider = {
      available: true,
      version: 'flaky-v1',
      async stylize(input) {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary provider failure');
        return inner.stylize(input);
      },
    };
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const failed = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    expect(failed.status).toBe('failed');
    expect(failed.failure.code).toBe('style-failed');

    const retried = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    expect(retried.status).toBe('completed');
    expect(attempts).toBe(2);
  });

  it('风格缓存键区分原图内容、风格、模型版本与背景模式', async () => {
    const image = await redSquarePng();
    const key = styleCacheKey(image, 'anime', 'v1', 'auto');

    expect(key).toBe(styleCacheKey(image, 'anime', 'v1', 'auto'));
    expect(key).not.toBe(styleCacheKey(image, 'anime', 'v2', 'auto'));
    expect(key).not.toBe(styleCacheKey(image, 'chibi', 'v1', 'auto'));
    expect(key).not.toBe(styleCacheKey(image, 'anime', 'v1', 'keep'));
    expect(key).not.toBe(styleCacheKey(await redSquarePng(65), 'anime', 'v1', 'auto'));
  });

  it('换风格重新调用风格服务并产生新图纸', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const animeId = await submit(baseUrl, image, { style: 'anime' });
    const anime = await waitForTask(baseUrl, animeId);
    const realisticId = await submit(baseUrl, image, { style: 'realistic' });
    const realistic = await waitForTask(baseUrl, realisticId);

    expect(animeId).not.toBe(realisticId);
    expect(anime.style).toBe('anime');
    expect(realistic.style).toBe('realistic');
    expect(calls.map((call) => call.style)).toEqual(['anime', 'realistic']);
  });

  it('风格服务超时后任务以风格化失败结束且不产出候选', async () => {
    const { provider, calls } = recordingProvider(
      createFakeStyleProvider({ behavior: 'timeout', timeoutMs: 40 }),
    );
    const baseUrl = await startApp({ style: provider });

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.candidates).toBeUndefined();
    expect(task.failure.code).toBe('style-failed');
    expect(calls).toHaveLength(1);
  });

  it('风格服务非成功响应时任务以风格化失败结束', async () => {
    const baseUrl = await startApp({
      style: createFakeStyleProvider({ behavior: 'error' }),
    });

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.candidates).toBeUndefined();
    expect(task.failure.code).toBe('style-failed');
  });

  it('风格服务返回不可解码图片时任务以风格化失败结束', async () => {
    const baseUrl = await startApp({
      style: createFakeStyleProvider({ behavior: 'bad-image' }),
    });

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.candidates).toBeUndefined();
    expect(task.failure.code).toBe('style-failed');
  });

  it('风格化失败后可按原图继续生成，不重复调用风格服务', async () => {
    const { provider, calls } = recordingProvider(
      createFakeStyleProvider({ behavior: 'error' }),
    );
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const failed = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    expect(failed.status).toBe('failed');
    expect(failed.failure.code).toBe('style-failed');

    const fallback = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'original' }));
    expect(fallback.status).toBe('completed');
    expect(fallback.style).toBe('original');
    expect(fallback.candidates).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });
});

describe('假风格服务', () => {
  it('对同一输入确定性输出可解码图片', async () => {
    const provider = createFakeStyleProvider();
    const input = { buffer: await redSquarePng(), contentType: 'image/png', style: 'anime' as const };

    const first = await provider.stylize(input);
    const second = await provider.stylize(input);

    expect(first.contentType).toBe('image/png');
    expect(first.buffer.equals(second.buffer)).toBe(true);
    const meta = await sharp(first.buffer).metadata();
    expect(meta.width).toBe(STYLE_WORKING_SIZE);
    expect(meta.height).toBe(STYLE_WORKING_SIZE);
  });
});

/** 非白像素占比：用来判断风格转换拿到的是整图还是抠出的主体。 */
async function nonWhiteRatio(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) count += 1;
  }
  return count / (info.width * info.height);
}

/** 白底中央红色圆形：抠主体后四角仍留白，用来观察面积占比与色块连通性。 */
async function redCirclePng(size = 96): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3, 255);
  const center = (size - 1) / 2;
  const radius = size * 0.35;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      if (dx * dx + dy * dy > radius * radius) continue;
      const i = (y * size + x) * 3;
      raw[i] = 200;
      raw[i + 1] = 30;
      raw[i + 2] = 40;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/** 白底矩形线框：模拟用户上传的线稿。 */
async function lineArtPng(
  size = 96,
  stroke = 4,
  ink: [number, number, number] = [20, 20, 20],
): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3, 255);
  const inset = Math.round(size * 0.2);
  const limit = size - inset;
  for (let y = inset; y < limit; y++) {
    for (let x = inset; x < limit; x++) {
      const onBorder =
        x < inset + stroke || x >= limit - stroke || y < inset + stroke || y >= limit - stroke;
      if (!onBorder) continue;
      const i = (y * size + x) * 3;
      raw[i] = ink[0];
      raw[i + 1] = ink[1];
      raw[i + 2] = ink[2];
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/** 候选图纸上非白格网的面积占比、连通块数量与包围盒跨度。 */
function gridStats(candidate: any): { ratio: number; components: number; bboxSpan: number } {
  const hex = new Map<string, string>(
    (candidate.colors as Array<{ code: string; hex: string }>).map((color) => [
      color.code,
      color.hex,
    ]),
  );
  const grid = candidate.grid as string[][];
  const height = grid.length;
  const width = grid[0].length;
  const isSubject = (x: number, y: number): boolean => {
    const value = hex.get(grid[y][x]) ?? '#ffffff';
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
    return r < 245 || g < 245 || b < 245;
  };

  const seen = grid.map((row) => row.map(() => false));
  let subject = 0;
  let components = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isSubject(x, y)) continue;
      subject += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (seen[y][x]) continue;
      components += 1;
      const stack: Array<[number, number]> = [[x, y]];
      seen[y][x] = true;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        const neighbors: Array<[number, number]> = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (seen[ny][nx] || !isSubject(nx, ny)) continue;
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
    }
  }
  const bboxSpan =
    maxX < 0 ? 0 : Math.max((maxX - minX + 1) / width, (maxY - minY + 1) / height);
  return { ratio: subject / (width * height), components, bboxSpan };
}

describe('风格转换流水线', () => {
  it('风格转换只接收抠出的主体，并输出固定工作尺寸', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });

    await waitForTask(baseUrl, await submit(baseUrl, await redSquarePng(), { style: 'anime' }));
    await waitForTask(
      baseUrl,
      await submit(baseUrl, await redSquarePng(80, 24), {
        style: 'realistic',
        settings: { background: 'keep' },
      }),
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const meta = await sharp(call.buffer).metadata();
      expect(meta.width).toBe(STYLE_WORKING_SIZE);
      expect(meta.height).toBe(STYLE_WORKING_SIZE);
    }
    expect(await nonWhiteRatio(calls[0].buffer)).toBeGreaterThan(0.7);
    expect(await nonWhiteRatio(calls[1].buffer)).toBeLessThan(0.5);
  });

  it('同一原图同风格换尺寸档不重复转换', async () => {
    const { provider, calls } = recordingProvider();
    const baseUrl = await startApp({ style: provider });
    const image = await redSquarePng();

    const small = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime', sizeTier: 'small' }));
    const medium = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'anime', sizeTier: 'medium' }),
    );

    expect(small.candidates[0].width).toBe(29);
    expect(medium.candidates[0].width).toBe(58);
    expect(calls).toHaveLength(1);
  });

  it('Q 版端到端仍为三候选，尺寸档与色卡档不变，主体不缩水也不碎', async () => {
    const baseUrl = await startApp();
    const image = await redCirclePng();

    const styled = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'chibi' }));
    const plain = await waitForTask(baseUrl, await submit(baseUrl, image));

    expect(styled.candidates).toHaveLength(3);
    for (const candidate of styled.candidates as Array<any>) {
      expect(candidate.width).toBe(29);
      expect(candidate.height).toBe(29);
      expect(candidate.boardCount).toBe(1);
      expect(candidate.paletteTier).toBe('basic');
    }
    const chibi = gridStats(styled.candidates[0]);
    const original = gridStats(plain.candidates[0]);
    expect(chibi.ratio).toBeGreaterThan(original.ratio * 0.9);
    expect(chibi.components).toBe(1);
  });
});

/** 白底径向渐变圆形（带轻微噪点）：模拟连续色调的照片，用来区分平涂、像素与 Q 版。 */
async function gradientCirclePng(size = 96): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3, 255);
  const center = (size - 1) / 2;
  const radius = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - center, y - center);
      if (distance > radius) continue;
      const t = distance / radius;
      const noise = ((x * 37 + y * 91) % 37) - 18;
      const i = (y * size + x) * 3;
      raw[i] = Math.round(230 - 160 * t + noise);
      raw[i + 1] = Math.round(70 + 120 * t + noise);
      raw[i + 2] = Math.round(50 + 130 * t + noise);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/** 候选格网里深色格的占比：用来比较不同风格的硬边轮廓密度。 */
function darkCellRatio(candidate: any): number {
  const hex = new Map<string, string>(
    (candidate.colors as Array<{ code: string; hex: string }>).map((color) => [
      color.code,
      color.hex,
    ]),
  );
  const grid = candidate.grid as string[][];
  let dark = 0;
  for (const row of grid) {
    for (const code of row) {
      const value = hex.get(code) ?? '#ffffff';
      const [r, g, b] = [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
      if ((r + g + b) / 3 < 120) dark += 1;
    }
  }
  return dark / (grid.length * grid[0].length);
}

/** 把格网按 3×3 对齐分块，统计颜色完全一致的块占比：像素块在成品格网里可见且稳定。 */
function alignedBlockRatio(candidate: any): number {
  const grid = candidate.grid as string[][];
  const block = 3;
  let uniform = 0;
  let total = 0;
  for (let by = 0; by + block <= grid.length; by += block) {
    for (let bx = 0; bx + block <= grid[0].length; bx += block) {
      const code = grid[by][bx];
      let same = true;
      for (let y = by; y < by + block && same; y++) {
        for (let x = bx; x < bx + block; x++) {
          if (grid[y][x] !== code) {
            same = false;
            break;
          }
        }
      }
      total += 1;
      if (same) uniform += 1;
    }
  }
  return total === 0 ? 0 : uniform / total;
}

describe('平涂卡通', () => {
  it('端到端三候选与既有不变量成立，主体结构保留', async () => {
    const baseUrl = await startApp();
    const image = await gradientCirclePng();

    const flat = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'flat' }));
    const plain = await waitForTask(baseUrl, await submit(baseUrl, image));

    expect(flat.candidates).toHaveLength(3);
    flat.candidates.forEach((candidate: any) => {
      expect(candidate.width).toBe(29);
      expect(candidate.height).toBe(29);
      expect(candidate.boardCount).toBe(1);
      expect(candidate.paletteTier).toBe('basic');
    });
    // 主体结构保留：抠主体后仍是实心色块，面积不缩水、不碎裂。
    const styled = gridStats(flat.candidates[0]);
    const original = gridStats(plain.candidates[0]);
    expect(styled.ratio).toBeGreaterThan(original.ratio * 0.9);
    expect(styled.components).toBe(1);
    expect(styled.bboxSpan).toBeGreaterThan(0.9);
  });

  it('与 Q 版可区分：硬边轮廓明显更少，已不是同一张图纸', async () => {
    const baseUrl = await startApp();
    const image = await gradientCirclePng();

    const flat = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'flat' }));
    const chibi = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'chibi' }));

    expect(flat.candidates[0].grid).not.toEqual(chibi.candidates[0].grid);
    expect(darkCellRatio(flat.candidates[2])).toBeLessThan(darkCellRatio(chibi.candidates[2]));
  });
});

describe('像素风', () => {
  it('端到端三候选与既有不变量成立，轮廓可辨识', async () => {
    const baseUrl = await startApp();
    const image = await gradientCirclePng();

    const pixel = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'pixel' }));
    const plain = await waitForTask(baseUrl, await submit(baseUrl, image));

    expect(pixel.candidates).toHaveLength(3);
    pixel.candidates.forEach((candidate: any) => {
      expect(candidate.width).toBe(29);
      expect(candidate.height).toBe(29);
      expect(candidate.boardCount).toBe(1);
      expect(candidate.paletteTier).toBe('basic');
    });
    // 少色号候选不做抖动，主体应连成一片；高细节候选的抖动会在边界留下零星噪点，不适合做连通性判据。
    const stats = gridStats(pixel.candidates[2]);
    const original = gridStats(plain.candidates[2]);
    expect(stats.ratio).toBeGreaterThan(original.ratio * 0.9);
    expect(stats.components).toBe(1);
    expect(stats.bboxSpan).toBeGreaterThan(0.9);
  });

  it('大档格网里像素块整齐成块，没有被降采样抹平', async () => {
    const baseUrl = await startApp();
    const image = await gradientCirclePng();

    const large = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'pixel', sizeTier: 'large' }),
    );

    expect(large.candidates[0].width).toBe(87);
    // 87 格网按 3×3 对齐分块，每块都对应一个 12px 像素块，颜色应当一致。
    expect(alignedBlockRatio(large.candidates[2])).toBeGreaterThan(0.8);
  });

  it('缩到不同尺寸档后主体占比一致，没有失真', async () => {
    const baseUrl = await startApp();
    const image = await gradientCirclePng();

    const small = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'pixel', sizeTier: 'small' }),
    );
    const large = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'pixel', sizeTier: 'large' }),
    );

    expect(small.candidates[0].width).toBe(29);
    expect(large.candidates[0].width).toBe(87);
    const smallRatio = gridStats(small.candidates[2]).ratio;
    const largeRatio = gridStats(large.candidates[2]).ratio;
    expect(Math.abs(smallRatio - largeRatio)).toBeLessThan(0.1);
  });

  it('与其他风格互不复用，换风格产生不同图纸', async () => {
    const baseUrl = await startApp();
    const image = await gradientCirclePng();

    const pixel = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'pixel' }));
    const flat = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'flat' }));
    const plain = await waitForTask(baseUrl, await submit(baseUrl, image));

    expect(pixel.candidates[0].grid).not.toEqual(flat.candidates[0].grid);
    expect(pixel.candidates[0].grid).not.toEqual(plain.candidates[0].grid);
  });
});

describe('线条风', () => {
  it('照片走边缘提取：三候选、尺寸档与色卡档不变，轮廓覆盖主体且不碎', async () => {
    const baseUrl = await startApp();

    const task = await waitForTask(baseUrl, await submit(baseUrl, await redCirclePng(), { style: 'line' }));

    expect(task.candidates).toHaveLength(3);
    for (const candidate of task.candidates as Array<any>) {
      expect(candidate.width).toBe(29);
      expect(candidate.height).toBe(29);
      expect(candidate.boardCount).toBe(1);
      expect(candidate.paletteTier).toBe('basic');
    }
    const outline = gridStats(task.candidates[0]);
    // 轮廓仍覆盖主体范围，但只保留线条而不是实心剪影，也不能整张空白。
    expect(outline.bboxSpan).toBeGreaterThan(0.8);
    expect(outline.ratio).toBeGreaterThan(0.02);
    expect(outline.ratio).toBeLessThan(0.7);
    expect(gridStats(task.candidates[2]).components).toBe(1);
  });

  it('线稿输入幂等：黑白与彩色线稿都不会被重复描边加粗', async () => {
    const baseUrl = await startApp();
    const cases: Array<[string, [number, number, number]]> = [
      ['黑白线稿', [20, 20, 20]],
      ['彩色线稿', [30, 60, 200]],
    ];

    for (const [label, ink] of cases) {
      const image = await lineArtPng(96, 4, ink);
      const styled = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'line' }));
      const plain = await waitForTask(baseUrl, await submit(baseUrl, image));

      const styledInk = gridStats(styled.candidates[2]).ratio;
      const plainInk = gridStats(plain.candidates[2]).ratio;
      expect(styledInk, label).toBeGreaterThan(0);
      // 描边没有叠加成双线：线条覆盖面积与原图基本一致。
      expect(styledInk, label).toBeLessThanOrEqual(plainInk * 1.6);
      expect(styledInk, label).toBeGreaterThanOrEqual(plainInk * 0.6);
    }
  });

  it('与其他风格互不复用，换风格产生不同图纸', async () => {
    const baseUrl = await startApp();
    const image = await redCirclePng();

    const line = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'line' }));
    const chibi = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'chibi' }));
    const plain = await waitForTask(baseUrl, await submit(baseUrl, image));

    expect(line.candidates[0].grid).not.toEqual(chibi.candidates[0].grid);
    expect(line.candidates[0].grid).not.toEqual(plain.candidates[0].grid);
  });
});
