import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer, type ServerOptions } from '../src/server';
import type { Moderation } from '../src/moderation';
import {
  STYLE_IDS,
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
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
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

  it('风格缓存键区分原图内容、风格与模型版本', async () => {
    const image = await redSquarePng();
    const key = styleCacheKey(image, 'anime', 'v1');

    expect(key).toBe(styleCacheKey(image, 'anime', 'v1'));
    expect(key).not.toBe(styleCacheKey(image, 'anime', 'v2'));
    expect(key).not.toBe(styleCacheKey(image, 'chibi', 'v1'));
    expect(key).not.toBe(styleCacheKey(await redSquarePng(65), 'anime', 'v1'));
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
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });
});
