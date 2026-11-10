import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createNodeServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer, type ServerOptions } from '../src/server';
import { listenOnRandomPort } from './support/listen';
import type { Moderation } from '../src/moderation';
import {
  createCloudFunctionStyleProvider,
  type CloudFunctionStyleOptions,
} from '../src/cloud-function-style';

const allowAll: Moderation = { check: async () => 'pass' };

interface CloudCall {
  style: string;
  modelVersion: string;
  contentType: string;
  bytes: number;
}

interface CloudReply {
  status: number;
  body: Buffer;
  contentType: string;
}

type CloudResponder = (body: Buffer) => Promise<CloudReply> | CloudReply;

interface CloudStub {
  url: string;
  calls: CloudCall[];
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** 云函数替代品：本地 HTTP 端点，记录请求并按用例返回二进制、错误或坏图。 */
async function startCloudStub(respond: CloudResponder): Promise<CloudStub> {
  const calls: CloudCall[] = [];
  const server = createNodeServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    calls.push({
      style: String(req.headers['x-style'] ?? ''),
      modelVersion: String(req.headers['x-model-version'] ?? ''),
      contentType: String(req.headers['content-type'] ?? ''),
      bytes: body.length,
    });
    const reply = await respond(body);
    res.writeHead(reply.status, {
      'content-type': reply.contentType,
      'content-length': reply.body.length,
    });
    res.end(reply.body);
  });
  await listenOnRandomPort(server);
  const { port } = server.address() as AddressInfo;
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, calls };
}

let appServer: Server | undefined;

async function startApp(options: Partial<ServerOptions> = {}): Promise<string> {
  appServer = createServer({
    moderation: allowAll,
    // 高级风格授权不是本工单的验证对象，显式放开白名单。
    isAdvancedStyleAllowed: () => true,
    ...options,
  });
  await listenOnRandomPort(appServer!);
  const { port } = appServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  closers.push(async () => {
    appServer?.closeAllConnections();
    await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    appServer = undefined;
  });
  return baseUrl;
}

/** 一次搭好云函数替身与服务端；providerOptions 用来压小上限或超时。 */
async function startWithCloud(
  respond: CloudResponder,
  providerOptions: Partial<CloudFunctionStyleOptions> = {},
  appOptions: Partial<ServerOptions> = {},
): Promise<{ cloud: CloudStub; baseUrl: string }> {
  const cloud = await startCloudStub(respond);
  const baseUrl = await startApp({
    style: createCloudFunctionStyleProvider({
      endpoint: cloud.url,
      modelVersion: 'hunyuan-v1',
      ...providerOptions,
    }),
    ...appOptions,
  });
  return { cloud, baseUrl };
}

/** 白底中央彩色方块，用来完成一次稳定生成。 */
async function samplePng(size = 96, square = 40): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3, 255);
  const start = Math.floor((size - square) / 2);
  for (let y = start; y < start + square; y++) {
    for (let x = start; x < start + square; x++) {
      const i = (y * size + x) * 3;
      raw[i] = 40 + (x % 180);
      raw[i + 1] = 90;
      raw[i + 2] = 190 - (y % 120);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

function upload(
  baseUrl: string,
  image: Buffer,
  options: { style?: string; sizeTier?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-size-tier': options.sizeTier ?? 'small',
      'x-palette-tier': 'basic',
      ...(options.style ? { 'x-style': options.style } : {}),
    },
    body: image,
  });
}

async function submit(
  baseUrl: string,
  image: Buffer,
  options: Parameters<typeof upload>[2] = {},
): Promise<string> {
  const response = await upload(baseUrl, image, options);
  expect(response.status).toBe(202);
  const body = (await response.json()) as { taskId: string };
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

describe('高级风格经云函数出口', () => {
  it('动漫风经云函数转换后仍为三候选，同一张图只调用一次', async () => {
    const styled = await samplePng(64, 48);
    const { cloud, baseUrl } = await startWithCloud(() => ({
      status: 200,
      body: styled,
      contentType: 'image/png',
    }));
    const image = await samplePng();

    const anime = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));

    expect(anime.status).toBe('completed');
    expect(anime.style).toBe('anime');
    expect(anime.aiStyled).toBe(true);
    expect(anime.candidates).toHaveLength(3);
    for (const candidate of anime.candidates as Array<any>) {
      expect(candidate.width).toBe(29);
      expect(candidate.height).toBe(29);
      expect(candidate.boardCount).toBe(1);
      expect(candidate.paletteTier).toBe('basic');
    }
    // 云函数拿到的是工作尺寸的 PNG，并带上风格与模型版本。
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0].style).toBe('anime');
    expect(cloud.calls[0].modelVersion).toBe('hunyuan-v1');
    expect(cloud.calls[0].contentType).toBe('image/png');

    // 只改成品尺寸档时复用风格图，不重复调用云函数。
    const medium = await waitForTask(
      baseUrl,
      await submit(baseUrl, image, { style: 'anime', sizeTier: 'medium' }),
    );
    expect(medium.candidates[0].width).toBe(58);
    expect(cloud.calls).toHaveLength(1);
  });

  it('云函数限流时以风格转换失败结束，不自动换风格，重试会再次调用', async () => {
    const { cloud, baseUrl } = await startWithCloud(() => ({
      status: 429,
      body: Buffer.from('{"error":"rate limited"}'),
      contentType: 'application/json',
    }));
    const image = await samplePng();

    const failed = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));

    expect(failed.status).toBe('failed');
    expect(failed.failure.code).toBe('style-failed');
    expect(failed.candidates).toBeUndefined();
    // 不自动回退到其他风格：任务仍记录用户选择的动漫风。
    expect(failed.style).toBe('anime');

    const retried = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    expect(retried.status).toBe('failed');
    expect(cloud.calls).toHaveLength(2);
  });

  it('云函数超时时以风格转换失败结束', async () => {
    const { baseUrl } = await startWithCloud(() => new Promise<CloudReply>(() => {}), {
      timeoutMs: 40,
    });

    const task = await waitForTask(baseUrl, await submit(baseUrl, await samplePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.failure.code).toBe('style-failed');
    expect(task.candidates).toBeUndefined();
  });

  it('云函数返回外链而不是图片二进制时失败，外链不进入缓存', async () => {
    const { cloud, baseUrl } = await startWithCloud(() => ({
      status: 200,
      body: Buffer.from('{"url":"https://example.invalid/style.png"}'),
      contentType: 'application/json',
    }));
    const image = await samplePng();

    const failed = await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    expect(failed.status).toBe('failed');
    expect(failed.failure.code).toBe('style-failed');

    await waitForTask(baseUrl, await submit(baseUrl, image, { style: 'anime' }));
    expect(cloud.calls).toHaveLength(2);
  });

  it('云函数返回内容超过大小上限时失败', async () => {
    const { baseUrl } = await startWithCloud(
      async () => ({ status: 200, body: await samplePng(64, 40), contentType: 'image/png' }),
      { maxOutputBytes: 200 },
    );

    const task = await waitForTask(baseUrl, await submit(baseUrl, await samplePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.failure.code).toBe('style-failed');
  });

  it('云函数返回像素数超过上限时失败', async () => {
    const { baseUrl } = await startWithCloud(
      async () => ({ status: 200, body: await samplePng(96, 40), contentType: 'image/png' }),
      { maxOutputPixels: 100 },
    );

    const task = await waitForTask(baseUrl, await submit(baseUrl, await samplePng(), { style: 'realistic' }));

    expect(task.status).toBe('failed');
    expect(task.failure.code).toBe('style-failed');
  });

  it('云函数返回不可解码内容时失败', async () => {
    const { baseUrl } = await startWithCloud(() => ({
      status: 200,
      body: Buffer.from('not-an-image'),
      contentType: 'image/png',
    }));

    const task = await waitForTask(baseUrl, await submit(baseUrl, await samplePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.failure.code).toBe('style-failed');
  });

  it('云函数输出被内容安全拦截时以独立原因结束', async () => {
    const styled = await samplePng(64, 48);
    let checks = 0;
    const moderation: Moderation = {
      check: async () => {
        checks += 1;
        return checks === 1 ? 'pass' : 'block';
      },
    };
    const { baseUrl } = await startWithCloud(
      () => ({ status: 200, body: styled, contentType: 'image/png' }),
      {},
      { moderation },
    );

    const task = await waitForTask(baseUrl, await submit(baseUrl, await samplePng(), { style: 'anime' }));

    expect(task.status).toBe('failed');
    expect(task.failure.code).toBe('style-blocked');
    expect(task.candidates).toBeUndefined();
    expect(checks).toBe(2);
  });
});
