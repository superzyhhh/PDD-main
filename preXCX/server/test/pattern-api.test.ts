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

/** 每张图都不同，避免内容寻址缓存把两张图纸合并成同一个任务。 */
async function uniquePng(seed: number): Promise<Buffer> {
  const size = 16;
  const raw = Buffer.alloc(size * size * 3, 255);
  const startX = 2 + (seed % 10);
  const startY = 2 + ((seed * 3) % 10);
  const value = (seed * 5) % 256;
  for (let y = startY; y < startY + 4; y++) {
    for (let x = startX; x < startX + 4; x++) {
      const i = (y * size + x) * 3;
      raw[i] = value;
      raw[i + 1] = (value + 40) % 256;
      raw[i + 2] = (value + 80) % 256;
    }
  }
  raw[0] = seed;
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

async function generate(baseUrl: string, token: string | undefined, image: Buffer): Promise<Record<string, any>> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-size-tier': 'small',
  };
  if (token) headers['x-session-token'] = token;
  const response = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers, body: image });
  expect(response.status).toBe(202);
  const { taskId } = (await response.json()) as { taskId: string };
  return waitForTask(baseUrl, taskId);
}

function authHeader(token?: string): Record<string, string> {
  return token ? { 'x-session-token': token } : {};
}

async function listPatterns(baseUrl: string, token?: string): Promise<{ patterns: Array<Record<string, any>> }> {
  const response = await fetch(`${baseUrl}/api/patterns`, { headers: authHeader(token) });
  expect(response.status).toBe(200);
  return (await response.json()) as { patterns: Array<Record<string, any>> };
}

async function getPattern(baseUrl: string, token: string | undefined, patternId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/patterns/${encodeURIComponent(patternId)}`, { headers: authHeader(token) });
}

function savePattern(baseUrl: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/patterns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

function deletePattern(baseUrl: string, token: string | undefined, patternId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/patterns/${encodeURIComponent(patternId)}`, {
    method: 'DELETE',
    headers: authHeader(token),
  });
}

function createExport(baseUrl: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

describe('我的图纸', () => {
  it('登录用户生成的图纸自动保存，列表按时间倒序且默认保存保主体细节', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'patterns-user');

    const first = await generate(baseUrl, token, await uniquePng(1));
    const second = await generate(baseUrl, token, await uniquePng(2));

    expect(first.savedPattern?.id).toBeTruthy();
    expect(second.savedPattern?.id).toBeTruthy();

    const { patterns } = await listPatterns(baseUrl, token);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].taskId).toBe(second.taskId);
    expect(patterns[1].taskId).toBe(first.taskId);
    expect(patterns[0].id).toBe(second.savedPattern!.id);
    expect(patterns[0].candidateId).toBe('detail');
    expect(patterns[0].width).toBe(29);
    expect(patterns[0].height).toBe(29);
    expect(patterns[0].boardCount).toBe(1);
    expect(patterns[0].colorCodeCount).toBeGreaterThan(0);
    expect(typeof patterns[0].createdAt).toBe('string');
  });

  it('第 51 张入列表时淘汰最早一张，并在任务上给出淘汰提示', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'max-patterns-user');

    const tasks: Array<Record<string, any>> = [];
    for (let seed = 0; seed < 51; seed++) {
      tasks.push(await generate(baseUrl, token, await uniquePng(seed)));
    }

    const { patterns } = await listPatterns(baseUrl, token);
    expect(patterns).toHaveLength(50);
    expect(patterns[0].taskId).toBe(tasks[50].taskId);
    expect(patterns.map((item) => item.taskId)).not.toContain(tasks[0].taskId);
    expect(tasks[50].savedPattern.evictedCount).toBe(1);
    expect(patterns[49].taskId).toBe(tasks[1].taskId);
  });

  it('选中其他候选后 upsert 同一张图纸，列表仍只有一条并使用新候选', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'upsert-user');
    const task = await generate(baseUrl, token, await uniquePng(3));

    const response = await savePattern(baseUrl, token, { taskId: task.taskId, candidateId: 'color' });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as { pattern: { id: string; candidateId: string } };
    expect(saved.pattern.id).toBe(task.savedPattern.id);
    expect(saved.pattern.candidateId).toBe('color');

    const { patterns } = await listPatterns(baseUrl, token);
    expect(patterns).toHaveLength(1);

    const detail = await getPattern(baseUrl, token, saved.pattern.id);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { pattern: Record<string, any> };
    expect(detailBody.pattern.candidateId).toBe('color');
    expect(detailBody.pattern.candidate.grid).toEqual(task.candidates[1].grid);
  });

  it('删除即时生效，列表与存储一致，重复删除返回不存在', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'delete-user');

    const first = await generate(baseUrl, token, await uniquePng(4));
    const second = await generate(baseUrl, token, await uniquePng(5));

    const removed = await deletePattern(baseUrl, token, first.savedPattern.id);
    expect(removed.status).toBe(200);

    const { patterns } = await listPatterns(baseUrl, token);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].taskId).toBe(second.taskId);
    expect(patterns.map((item) => item.id)).not.toContain(first.savedPattern.id);

    const again = await deletePattern(baseUrl, token, first.savedPattern.id);
    expect(again.status).toBe(404);
  });

  it('旧图纸可重新打开并按缓存导出，导出图纸与首次一致', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'reopen-user');
    const task = await generate(baseUrl, token, await uniquePng(6));

    const first = await createExport(baseUrl, token, {
      taskId: task.taskId,
      candidateId: 'detail',
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      exportId: string;
      url: string;
      taskId: string;
      quota: { limit: number | null; used: number; remaining: number | null };
    };
    expect(firstBody.taskId).toBe(task.taskId);
    expect(firstBody.quota).toEqual({ limit: null, used: 0, remaining: null });

    const detail = await getPattern(baseUrl, token, task.savedPattern.id);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { pattern: Record<string, any> };
    expect(detailBody.pattern.taskId).toBe(task.taskId);
    expect(detailBody.pattern.candidate.id).toBe('detail');

    const reopened = await createExport(baseUrl, token, { patternId: detailBody.pattern.id });
    expect(reopened.status).toBe(200);
    const reopenedBody = (await reopened.json()) as { exportId: string; url: string };
    expect(reopenedBody.exportId).toBe(firstBody.exportId);

    const download = await fetch(`${baseUrl}${firstBody.url}`, { headers: authHeader(token) });
    expect(download.status).toBe(200);
    const image = Buffer.from(await download.arrayBuffer());
    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(29 * 40);

    const reopenDownload = await fetch(`${baseUrl}${reopenedBody.url}`, { headers: authHeader(token) });
    expect(reopenDownload.status).toBe(200);
    expect(Buffer.from(await reopenDownload.arrayBuffer()).equals(image)).toBe(true);
  });

  it('未登录生成的图纸不落库，登录后新生成的图纸才开始保存', async () => {
    const baseUrl = await startApp();
    const anonymous = await generate(baseUrl, undefined, await uniquePng(7));
    expect(anonymous.savedPattern).toBeUndefined();

    const token = await login(baseUrl, 'late-login-user');
    const { patterns: before } = await listPatterns(baseUrl, token);
    expect(before).toHaveLength(0);

    const response = await savePattern(baseUrl, token, { taskId: anonymous.taskId, candidateId: 'detail' });
    expect(response.status).toBe(403);

    const loggedIn = await generate(baseUrl, token, await uniquePng(8));
    expect(loggedIn.savedPattern).toBeDefined();
    const { patterns: after } = await listPatterns(baseUrl, token);
    expect(after.map((item) => item.taskId)).toEqual([loggedIn.taskId]);

    // 登录后重新提交匿名时生成过的同一张图，会新建并保存为当前账号的图纸。
    const repeated = await generate(baseUrl, token, await uniquePng(7));
    expect(repeated.taskId).not.toBe(anonymous.taskId);
    expect(repeated.savedPattern).toBeDefined();
    const { patterns: repeatedList } = await listPatterns(baseUrl, token);
    expect(repeatedList.map((item) => item.taskId)).toContain(repeated.taskId);
  });

  it('未登录不能查看列表，也不能读取、删除或导出他人图纸', async () => {
    const baseUrl = await startApp();
    const ownerToken = await login(baseUrl, 'pattern-owner');
    const otherToken = await login(baseUrl, 'pattern-intruder');
    const task = await generate(baseUrl, ownerToken, await uniquePng(9));
    const patternId = task.savedPattern.id as string;

    const anonymousList = await fetch(`${baseUrl}/api/patterns`);
    expect(anonymousList.status).toBe(401);

    const read = await getPattern(baseUrl, otherToken, patternId);
    expect(read.status).toBe(404);

    const remove = await deletePattern(baseUrl, otherToken, patternId);
    expect(remove.status).toBe(404);

    const exported = await createExport(baseUrl, otherToken, { patternId });
    expect(exported.status).toBe(404);
  });
});
