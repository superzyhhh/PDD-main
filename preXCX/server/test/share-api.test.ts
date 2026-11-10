import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
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

async function subjectPng(): Promise<Buffer> {
  const size = 48;
  const raw = Buffer.alloc(size * size * 3, 255);
  for (let y = 12; y < 36; y++) {
    for (let x = 12; x < 36; x++) {
      const i = (y * size + x) * 3;
      raw[i] = 210;
      raw[i + 1] = 40;
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

async function generate(baseUrl: string, token?: string): Promise<Record<string, any>> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-size-tier': 'small',
  };
  if (token) headers['x-session-token'] = token;
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers,
    body: await subjectPng(),
  });
  expect(response.status).toBe(202);
  const { taskId } = (await response.json()) as { taskId: string };
  return waitForTask(baseUrl, taskId);
}

function createShare(
  baseUrl: string,
  token: string | undefined,
  taskId: string,
  candidateId: string,
  source = 'menu',
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-session-token'] = token;
  return fetch(`${baseUrl}/api/shares`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ taskId, candidateId, source }),
  });
}

describe('原生分享', () => {
  it('接收者无需登录即可查看被分享的那一张图纸', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'share-owner');
    const task = await generate(baseUrl, token);
    const candidate = task.candidates[0];

    const response = await createShare(baseUrl, token, task.taskId, candidate.id);
    expect(response.status).toBe(201);
    const { shareId, coverUrl } = (await response.json()) as {
      shareId: string;
      coverUrl: string;
    };

    const shared = await fetch(`${baseUrl}/api/shares/${shareId}`);
    expect(shared.status).toBe(200);
    const body = (await shared.json()) as Record<string, any>;
    expect(body.candidate.id).toBe(candidate.id);
    expect(body.candidate.grid).toEqual(candidate.grid);
    expect(body).not.toHaveProperty('taskId');
    expect(body).not.toHaveProperty('openId');

    const cover = await fetch(`${baseUrl}${coverUrl}`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    const meta = await sharp(Buffer.from(await cover.arrayBuffer())).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(640);
  });

  it('不能分享别人的图纸，未知任务与候选直接拒绝', async () => {
    const baseUrl = await startApp();
    const owner = await login(baseUrl, 'share-owner');
    const other = await login(baseUrl, 'share-other');
    const task = await generate(baseUrl, owner);
    const candidateId = task.candidates[0].id;

    const forbidden = await createShare(baseUrl, other, task.taskId, candidateId);
    expect(forbidden.status).toBe(403);

    const missingTask = await createShare(baseUrl, owner, 'missing-task', candidateId);
    expect(missingTask.status).toBe(404);

    const missingCandidate = await createShare(baseUrl, owner, task.taskId, 'missing-candidate');
    expect(missingCandidate.status).toBe(400);
  });

  it('匿名生成的图纸也能分享给好友查看', async () => {
    const baseUrl = await startApp();
    const task = await generate(baseUrl);
    const candidate = task.candidates[0];

    const response = await createShare(baseUrl, undefined, task.taskId, candidate.id);
    expect(response.status).toBe(201);
    const { shareId } = (await response.json()) as { shareId: string };
    const shared = await fetch(`${baseUrl}/api/shares/${shareId}`);
    expect(shared.status).toBe(200);
  });

  it('后台可统计分享次数、来源与打开次数', async () => {
    const adminToken = 'share-admin';
    const baseUrl = await startApp({ adminToken });
    const token = await login(baseUrl, 'share-owner');
    const task = await generate(baseUrl, token);
    const candidateId = task.candidates[0].id;

    const first = await createShare(baseUrl, token, task.taskId, candidateId, 'menu');
    const second = await createShare(baseUrl, token, task.taskId, candidateId, 'button');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { shareId: string }).shareId;

    await fetch(`${baseUrl}/api/shares/${secondId}`);
    await fetch(`${baseUrl}/api/shares/${secondId}`);

    const denied = await fetch(`${baseUrl}/api/shares`);
    expect(denied.status).toBe(403);

    const stats = await fetch(`${baseUrl}/api/shares`, {
      headers: { 'x-admin-token': adminToken },
    });
    expect(stats.status).toBe(200);
    const body = (await stats.json()) as { total: number; shares: Array<Record<string, any>> };
    expect(body.total).toBe(2);
    expect(body.shares.map((share) => share.source)).toEqual(['button', 'menu']);
    expect(body.shares[0].openCount).toBe(2);
  });
});
