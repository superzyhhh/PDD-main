import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Candidate } from './types';

/** 高清导出的单格像素：40px，保证格线与色号可直接打印。 */
export const HD_CELL_PX = 40;

const MAX_EXPORTS = 20;

export function exportKey(
  openId: string,
  taskId: string,
  candidateId: string,
  format: ExportFormat = 'hd',
): string {
  return `${openId}|${taskId}|${candidateId}|${format}`;
}

/** 导出类型：高清整图 PNG，或按 A4 分块打印的 PDF。 */
export type ExportFormat = 'hd' | 'tiled';

export interface ExportRecord {
  id: string;
  key: string;
  taskId: string;
  candidateId: string;
  openId: string;
  format: ExportFormat;
  /** 分块打印的页数，等于拼板数；高清整图不填。 */
  pageCount?: number;
  /** 格网尺寸（格），不是像素。 */
  width: number;
  height: number;
  buffer: Buffer;
  createdAt: number;
}

/** 免费版导出不限次数；保留 quota 字段以维持既有响应结构。 */
export interface QuotaSnapshot {
  limit: number | null;
  used: number;
  remaining: number | null;
}

export const UNLIMITED_EXPORT_QUOTA: QuotaSnapshot = { limit: null, used: 0, remaining: null };

export type DecideExport =
  | { outcome: 'cached'; record: ExportRecord }
  | { outcome: 'allowed' };

/** 导出缓存；缓存命中直接复用已渲染的资源。 */
export class ExportStore {
  private readonly records = new Map<string, ExportRecord>();
  private readonly byKey = new Map<string, string>();

  find(key: string): ExportRecord | undefined {
    const id = this.byKey.get(key);
    return id ? this.records.get(id) : undefined;
  }

  get(id: string): ExportRecord | undefined {
    return this.records.get(id);
  }

  /** 先查缓存；未命中则允许新渲染。 */
  decide(key: string): DecideExport {
    const cached = this.find(key);
    return cached ? { outcome: 'cached', record: cached } : { outcome: 'allowed' };
  }

  save(
    key: string,
    input: Omit<ExportRecord, 'id' | 'key' | 'createdAt'>,
  ): ExportRecord {
    const record: ExportRecord = {
      ...input,
      id: randomUUID(),
      key,
      createdAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.byKey.set(key, record.id);
    this.evictIfNeeded();
    return record;
  }

  private evictIfNeeded(): void {
    if (this.records.size <= MAX_EXPORTS) return;
    const oldest = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) return;
    this.records.delete(oldest.id);
    if (this.byKey.get(oldest.key) === oldest.id) this.byKey.delete(oldest.key);
  }
}

/**
 * 把候选渲染成高清整图：每格填色、画格线与色号，每 29 格加粗拼板分界线。
 * 纯色块 + ASCII 色号，SVG 交给 sharp 栅格化，不带任何水印。
 */
export async function renderHdExport(candidate: Candidate): Promise<Buffer> {
  const cell = HD_CELL_PX;
  const pixelWidth = candidate.width * cell;
  const pixelHeight = candidate.height * cell;
  const fontSize = Math.round(cell * 0.32);

  const hexByCode = new Map(candidate.colors.map((color) => [color.code, color.hex]));
  const parts: string[] = [
    `<rect x="0" y="0" width="${pixelWidth}" height="${pixelHeight}" fill="#FFFFFF"/>`,
  ];

  for (let y = 0; y < candidate.height; y++) {
    for (let x = 0; x < candidate.width; x++) {
      const code = candidate.grid[y][x];
      const hex = hexByCode.get(code) ?? '#FFFFFF';
      parts.push(
        gridCellSvg(x * cell, y * cell, cell, code, hex, fontSize),
      );
    }
  }

  // 拼板分界线：每 29 格一条，便于按板裁切。
  for (let x = 29; x < candidate.width; x += 29) {
    parts.push(`<line x1="${x * cell}" y1="0" x2="${x * cell}" y2="${pixelHeight}" stroke="#2B2622" stroke-width="3"/>`);
  }
  for (let y = 29; y < candidate.height; y += 29) {
    parts.push(`<line x1="0" y1="${y * cell}" x2="${pixelWidth}" y2="${y * cell}" stroke="#2B2622" stroke-width="3"/>`);
  }
  parts.push(
    `<rect x="1.5" y="1.5" width="${pixelWidth - 3}" height="${pixelHeight - 3}" fill="none" stroke="#2B2622" stroke-width="3"/>`,
  );

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" ` +
    `viewBox="0 0 ${pixelWidth} ${pixelHeight}">${parts.join('')}</svg>`;

  return sharp(Buffer.from(svg))
    .flatten({ background: '#FFFFFF' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** 分享封面统一 640×640，微信卡片按 5:4 裁切时仍能看到图纸主体。 */
export const SHARE_COVER_PX = 640;

export async function renderShareCover(candidate: Candidate): Promise<Buffer> {
  const image = await renderHdExport(candidate);
  return sharp(image)
    .resize(SHARE_COVER_PX, SHARE_COVER_PX, { fit: 'contain', background: '#FFFFFF' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** 浅色底用深字，深色底用白字，与预览端一致。 */
export function textColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 150 ? '#2B2622' : '#FFFFFF';
}

/** 一个格子的底色、格线与色号；高清整图与分块打印共用同一套格子渲染。 */
export function gridCellSvg(
  px: number,
  py: number,
  cell: number,
  code: string,
  hex: string,
  fontSize: number,
  strokeWidth = 1,
): string {
  return (
    `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" fill="${hex}" ` +
    `stroke="#D9D3CB" stroke-width="${strokeWidth}"/>` +
    `<text x="${px + cell / 2}" y="${py + cell / 2 + fontSize * 0.35}" font-family="sans-serif" ` +
    `font-size="${fontSize}" text-anchor="middle" fill="${textColor(hex)}">${code}</text>`
  );
}
