import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createServer } from '../src/server';
import { listenOnRandomPort } from './support/listen';
import type { Moderation } from '../src/moderation';
import {
  A4_PRINT_LAYOUT,
  paginateCandidate,
} from '../src/print';

const allowAll: Moderation = { check: async () => 'pass' };
const BOARD = 29;

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
  return ((await response.json()) as { token: string }).token;
}

async function createTask(baseUrl: string, token: string, sizeTier: 'small' | 'large'): Promise<string> {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-size-tier': sizeTier,
      'x-session-token': token,
    },
    body: await redSquarePng(),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { taskId: string }).taskId;
}

async function waitForTask(baseUrl: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
    const body = (await response.json()) as Record<string, any>;
    if (body.status === 'completed' || body.status === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} did not finish in time`);
}

function createExport(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify(body),
  });
}

describe('分块打印分页纯函数', () => {
  it('小/中/大成品尺寸的分页数等于拼板数，且覆盖全图不重不漏', () => {
    for (const size of [BOARD, BOARD * 2, BOARD * 3]) {
      const tiles = paginateCandidate(size, size);
      expect(tiles).toHaveLength((size / BOARD) ** 2);

      const cells = new Set<string>();
      for (const tile of tiles) {
        expect(tile.colEnd - tile.colStart).toBeLessThanOrEqual(A4_PRINT_LAYOUT.columns);
        expect(tile.rowEnd - tile.rowStart).toBeLessThanOrEqual(A4_PRINT_LAYOUT.rows);
        for (let y = tile.rowStart; y < tile.rowEnd; y++) {
          for (let x = tile.colStart; x < tile.colEnd; x++) {
            const key = `${x},${y}`;
            expect(cells.has(key)).toBe(false);
            cells.add(key);
          }
        }
      }
      expect(cells.size).toBe(size * size);
      expect(tiles.map((tile) => tile.pageNumber)).toEqual(
        Array.from({ length: tiles.length }, (_, index) => index + 1),
      );
      expect(new Set(tiles.map((tile) => tile.boardNumber)).size).toBe(tiles.length);
    }
  });

  it('大档 87×87 按 3×3 拼板分 9 页，页内对齐坐标正确', () => {
    const tiles = paginateCandidate(87, 87);
    expect(tiles.map((tile) => tile.boardNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tiles[0]).toMatchObject({ colStart: 0, colEnd: 29, rowStart: 0, rowEnd: 29 });
    expect(tiles[3]).toMatchObject({ colStart: 0, colEnd: 29, rowStart: 29, rowEnd: 58 });
    expect(tiles[8]).toMatchObject({ colStart: 58, colEnd: 87, rowStart: 58, rowEnd: 87 });
    expect(tiles[8].pageNumber).toBe(9);
  });

  it('A4 打印每页恰好一块板，单格约 5.4mm 在可读范围内', () => {
    const mmPerCell = (A4_PRINT_LAYOUT.cellPx / A4_PRINT_LAYOUT.dpi) * 25.4;
    expect(mmPerCell).toBeGreaterThanOrEqual(4);
    expect(mmPerCell).toBeLessThanOrEqual(10);

    const pageWidthMm = (A4_PRINT_LAYOUT.pageWidthPx / A4_PRINT_LAYOUT.dpi) * 25.4;
    const pageHeightMm = (A4_PRINT_LAYOUT.pageHeightPx / A4_PRINT_LAYOUT.dpi) * 25.4;
    expect(pageWidthMm).toBeCloseTo(210, 0);
    expect(pageHeightMm).toBeCloseTo(297, 0);
    expect(A4_PRINT_LAYOUT.columns * mmPerCell).toBeLessThanOrEqual(pageWidthMm);
    expect(A4_PRINT_LAYOUT.rows * mmPerCell).toBeLessThanOrEqual(pageHeightMm);
  });
});

describe('A4 分块打印导出接口', () => {
  it('导出 PDF，可下载且页数与拼板数一致；命中缓存不重复渲染', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'tiled-user');
    const taskId = await createTask(baseUrl, token, 'small');
    await waitForTask(baseUrl, taskId);

    const response = await createExport(baseUrl, token, {
      taskId,
      candidateId: 'detail',
      type: 'tiled',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({ type: 'tiled', format: 'pdf', pageCount: 1 });
    expect(body.url).toMatch(/\.pdf$/);

    const download = await fetch(`${baseUrl}${body.url}`, {
      headers: { 'x-session-token': token },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/pdf');
    const pdf = Buffer.from(await download.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString().match(/\/Type \/Page\b/g)).toHaveLength(1);

    const cached = (await (
      await createExport(baseUrl, token, { taskId, candidateId: 'detail', type: 'tiled' })
    ).json()) as Record<string, any>;
    expect(cached.exportId).toBe(body.exportId);

    // 免费版导出不限次数：高清导出不再被拦截。
    const hd = await createExport(baseUrl, token, { taskId, candidateId: 'color', type: 'hd' });
    expect(hd.status).toBe(200);
  }, 30_000);

  it('大档 87×87 分块导出为 9 页 PDF', async () => {
    const baseUrl = await startApp();
    const token = await login(baseUrl, 'tiled-large');
    const taskId = await createTask(baseUrl, token, 'large');
    await waitForTask(baseUrl, taskId);

    const response = await createExport(baseUrl, token, {
      taskId,
      candidateId: 'few',
      type: 'tiled',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.pageCount).toBe(9);

    const download = await fetch(`${baseUrl}${body.url}`, {
      headers: { 'x-session-token': token },
    });
    const pdf = Buffer.from(await download.arrayBuffer());
    expect(pdf.toString().match(/\/Type \/Page\b/g)).toHaveLength(9);
  }, 30_000);
});
