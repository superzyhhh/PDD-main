import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer } from '../src/server';
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

async function startApp(): Promise<string> {
  server = createServer({ moderation: allowAll });
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

function createExport(baseUrl: string, token: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-session-token'] = token;
  return fetch(`${baseUrl}/api/exports`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('高清导出与免费额度', () => {
  it('未登录导出被拒绝并提示先登录', async () => {
    const baseUrl = await startApp();
    const taskId = await createTask(baseUrl);

    const response = await createExport(baseUrl, undefined, { taskId, candidateId: 'detail' });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('login-required');
    expect(body.error.message).toContain('登录');
  });

  it('首次导出得到高清无水印 PNG，格网像素尺寸与候选一致并扣一次额度', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'free-user');
    const taskId = await createTask(baseUrl, token);
    await waitForTask(baseUrl, taskId);

    const response = await createExport(baseUrl, token, { taskId, candidateId: 'detail' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      exportId: string;
      url: string;
      width: number;
      height: number;
      quota: { limit: number; used: number; remaining: number };
    };
    expect(body.width).toBe(29);
    expect(body.height).toBe(29);
    expect(body.quota).toEqual({ limit: 1, used: 1, remaining: 0 });

    // 下载同样需要登录，且只能取本账号的资源。
    const anonymous = await fetch(`${baseUrl}${body.url}`);
    expect(anonymous.status).toBe(401);

    const download = await fetch(`${baseUrl}${body.url}`, {
      headers: { 'x-session-token': token },
    });
    expect(download.status).toBe(200);
    const image = Buffer.from(await download.arrayBuffer());
    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
    // 高清单格像素是 40，且导出图不带半透明水印通道。
    expect(metadata.width).toBe(29 * 40);
    expect(metadata.height).toBe(29 * 40);
    expect(metadata.hasAlpha).toBe(false);
  });

  it('同一图纸重复导出命中缓存且不扣次', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'free-user');
    const taskId = await createTask(baseUrl, token);
    await waitForTask(baseUrl, taskId);

    const first = await createExport(baseUrl, token, { taskId, candidateId: 'detail' });
    const firstBody = (await first.json()) as { exportId: string; quota: { used: number } };
    const second = await createExport(baseUrl, token, { taskId, candidateId: 'detail' });
    const secondBody = (await second.json()) as { exportId: string; quota: { used: number } };

    expect(second.status).toBe(200);
    expect(secondBody.exportId).toBe(firstBody.exportId);
    expect(secondBody.quota.used).toBe(1);
  });

  it('免费额度用完后导出另一张候选被拒绝，提示含会员入口文案', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'free-user');
    const taskId = await createTask(baseUrl, token);
    await waitForTask(baseUrl, taskId);

    await createExport(baseUrl, token, { taskId, candidateId: 'detail' });
    const response = await createExport(baseUrl, token, { taskId, candidateId: 'color' });

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('quota-exceeded');
    expect(body.error.message).toContain('会员');
  });

  it('换新令牌后额度按账号继承，已导出图纸仍可复用缓存', async () => {
    const baseUrl = await startApp();
    const firstToken = await login(baseUrl, 'same-account');
    const taskId = await createTask(baseUrl, firstToken);
    await waitForTask(baseUrl, taskId);
    await createExport(baseUrl, firstToken, { taskId, candidateId: 'detail' });

    const secondToken = await login(baseUrl, 'same-account');
    expect(secondToken).not.toBe(firstToken);

    const cached = await createExport(baseUrl, secondToken, { taskId, candidateId: 'detail' });
    expect(cached.status).toBe(200);
    const cachedBody = (await cached.json()) as { quota: { used: number } };
    expect(cachedBody.quota.used).toBe(1);

    const other = await createExport(baseUrl, secondToken, { taskId, candidateId: 'few' });
    expect(other.status).toBe(429);
  });

  it('不同账号导出同一张匿名图纸各自计费，不能复用他人资源', async () => {
    const baseUrl = await startApp();
    const tokenA = await login(baseUrl, 'user-a');
    const tokenB = await login(baseUrl, 'user-b');
    const taskId = await createTask(baseUrl);
    // 出图是异步任务，未完成时导出会返回 409，必须先等任务完成。
    await waitForTask(baseUrl, taskId);

    const first = (await (
      await createExport(baseUrl, tokenA, { taskId, candidateId: 'detail' })
    ).json()) as { exportId: string; url: string; quota: { used: number } };
    expect(first.quota.used).toBe(1);

    const second = (await (
      await createExport(baseUrl, tokenB, { taskId, candidateId: 'detail' })
    ).json()) as { exportId: string; quota: { used: number } };
    expect(second.exportId).not.toBe(first.exportId);
    expect(second.quota.used).toBe(1);

    const otherDownload = await fetch(`${baseUrl}${first.url}`, {
      headers: { 'x-session-token': tokenB },
    });
    expect(otherDownload.status).toBe(403);
  });

  it('不能导出他人账号生成的图纸', async () => {
    const baseUrl = await startApp();
    const ownerToken = await login(baseUrl, 'owner');
    const otherToken = await login(baseUrl, 'intruder');
    const taskId = await createTask(baseUrl, ownerToken);
    await waitForTask(baseUrl, taskId);

    const response = await createExport(baseUrl, otherToken, { taskId, candidateId: 'detail' });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('export-forbidden');
  });
});
