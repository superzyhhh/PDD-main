import sharp from 'sharp';
import { BOARD_SIZE } from './generation';
import { gridCellSvg } from './exports';
import { buildPdfFromJpegPages, type PdfImagePage } from './pdf';
import type { Candidate } from './types';

/** 打印目标 300 DPI：A4 210×297mm 栅格化为 2480×3508px。 */
export const PRINT_DPI = 300;
/** 单格 64px，约 5.4mm，保证打印后色号可读。 */
export const PRINT_CELL_PX = 64;
export const A4_PRINT_LAYOUT = {
  dpi: PRINT_DPI,
  cellPx: PRINT_CELL_PX,
  pageWidthPx: Math.round((210 / 25.4) * PRINT_DPI),
  pageHeightPx: Math.round((297 / 25.4) * PRINT_DPI),
  marginPx: 120,
  headerPx: 200,
  footerPx: 120,
  /** 每页恰好一块拼板，页数因此与拼板数一致。 */
  columns: BOARD_SIZE,
  rows: BOARD_SIZE,
} as const;

export interface PrintTile {
  /** 0 基序号，用于内部计算。 */
  index: number;
  /** 面向用户的页码，从 1 开始。 */
  pageNumber: number;
  /** 拼板编号，按行优先从 1 开始，与实物底板顺序一致。 */
  boardNumber: number;
  colStart: number;
  /** 开区间。 */
  colEnd: number;
  rowStart: number;
  /** 开区间。 */
  rowEnd: number;
}

/**
 * 分块导出纯函数：按 29 格一块板切页，行优先排列，覆盖全图且不重不漏。
 * 所有成品尺寸档都是 29 的整数倍，因此页数恒等于拼板数。
 */
export function paginateCandidate(width: number, height: number): PrintTile[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`无效的图纸格网尺寸：${width}×${height}`);
  }
  const boardCols = Math.ceil(width / BOARD_SIZE);
  const boardRows = Math.ceil(height / BOARD_SIZE);
  const tiles: PrintTile[] = [];
  for (let boardRow = 0; boardRow < boardRows; boardRow++) {
    for (let boardCol = 0; boardCol < boardCols; boardCol++) {
      const index = tiles.length;
      const colStart = boardCol * BOARD_SIZE;
      const rowStart = boardRow * BOARD_SIZE;
      tiles.push({
        index,
        pageNumber: index + 1,
        boardNumber: boardRow * boardCols + boardCol + 1,
        colStart,
        colEnd: Math.min(colStart + BOARD_SIZE, width),
        rowStart,
        rowEnd: Math.min(rowStart + BOARD_SIZE, height),
      });
    }
  }
  return tiles;
}

/** 渲染单页 A4 分块图（JPEG，压缩后嵌入 PDF）。页眉页码、拼板编号与全图对齐坐标都在图上。 */
export async function renderPrintPageJpeg(
  candidate: Candidate,
  tile: PrintTile,
  pageCount: number,
): Promise<Buffer> {
  const { pageWidthPx, pageHeightPx, cellPx } = A4_PRINT_LAYOUT;
  const cols = tile.colEnd - tile.colStart;
  const rows = tile.rowEnd - tile.rowStart;
  const drawingWidth = cols * cellPx;
  const drawingHeight = rows * cellPx;
  const originX = Math.round((pageWidthPx - drawingWidth) / 2);
  const originY = A4_PRINT_LAYOUT.headerPx + 80;
  const codeFont = Math.round(cellPx * 0.3);
  const axisFont = Math.round(cellPx * 0.28);

  const hexByCode = new Map(candidate.colors.map((color) => [color.code, color.hex]));
  const fontFamily = 'Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif';
  const parts: string[] = [
    `<rect x="0" y="0" width="${pageWidthPx}" height="${pageHeightPx}" fill="#FFFFFF"/>`,
    `<text x="${A4_PRINT_LAYOUT.marginPx}" y="86" font-family="${fontFamily}" font-size="44" font-weight="600" fill="#2B2622">拼豆图纸 · 分块打印</text>`,
    `<text x="${A4_PRINT_LAYOUT.marginPx}" y="146" font-family="${fontFamily}" font-size="26" fill="#7A6F66">第 ${tile.pageNumber} / ${pageCount} 页 · 拼板 ${tile.boardNumber} · 列 ${tile.colStart + 1}–${tile.colEnd} · 行 ${tile.rowStart + 1}–${tile.rowEnd}</text>`,
  ];

  // 全图坐标：每格标出它在整张图纸里的列号/行号，便于跨页对齐。
  for (let col = 0; col < cols; col++) {
    const x = originX + col * cellPx + cellPx / 2;
    parts.push(
      `<text x="${x}" y="${originY - 12}" font-family="sans-serif" font-size="${axisFont}" ` +
        `text-anchor="middle" fill="#7A6F66">${tile.colStart + col + 1}</text>`,
    );
  }
  for (let row = 0; row < rows; row++) {
    const y = originY + row * cellPx + cellPx / 2 + axisFont * 0.35;
    parts.push(
      `<text x="${originX - 10}" y="${y}" font-family="sans-serif" font-size="${axisFont}" ` +
        `text-anchor="end" fill="#7A6F66">${tile.rowStart + row + 1}</text>`,
    );
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const code = candidate.grid[tile.rowStart + row][tile.colStart + col];
      const hex = hexByCode.get(code) ?? '#FFFFFF';
      const px = originX + col * cellPx;
      const py = originY + row * cellPx;
      parts.push(gridCellSvg(px, py, cellPx, code, hex, codeFont, 2));
    }
  }

  parts.push(
    `<rect x="${originX}" y="${originY}" width="${drawingWidth}" height="${drawingHeight}" ` +
      `fill="none" stroke="#2B2622" stroke-width="4"/>`,
  );

  // 四角对齐标记，打印后可据此对齐叠页与裁切。
  const mark = 28;
  const corners = [
    [originX, originY, -1, -1],
    [originX + drawingWidth, originY, 1, -1],
    [originX, originY + drawingHeight, -1, 1],
    [originX + drawingWidth, originY + drawingHeight, 1, 1],
  ] as const;
  for (const [x, y, dx, dy] of corners) {
    parts.push(
      `<line x1="${x}" y1="${y}" x2="${x + dx * mark}" y2="${y}" stroke="#2B2622" stroke-width="3"/>`,
      `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + dy * mark}" stroke="#2B2622" stroke-width="3"/>`,
    );
  }

  parts.push(
    `<text x="${A4_PRINT_LAYOUT.marginPx}" y="${pageHeightPx - 64}" font-family="${fontFamily}" font-size="24" fill="#9A8F85">` +
      `拼板规格 ${BOARD_SIZE}×${BOARD_SIZE} · 每格约 5.4mm · 300 DPI · 拼板 ${tile.boardNumber}</text>`,
  );

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidthPx}" height="${pageHeightPx}" ` +
    `viewBox="0 0 ${pageWidthPx} ${pageHeightPx}">${parts.join('')}</svg>`;

  return sharp(Buffer.from(svg))
    .flatten({ background: '#FFFFFF' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** 把整张图纸渲染成一份 A4 分块打印 PDF，页数等于拼板数。 */
export async function renderTiledPrintExport(
  candidate: Candidate,
): Promise<{ pdf: Buffer; pageCount: number }> {
  const tiles = paginateCandidate(candidate.width, candidate.height);
  const pages: PdfImagePage[] = [];
  for (const tile of tiles) {
    const jpeg = await renderPrintPageJpeg(candidate, tile, tiles.length);
    pages.push({
      jpeg,
      width: A4_PRINT_LAYOUT.pageWidthPx,
      height: A4_PRINT_LAYOUT.pageHeightPx,
    });
  }
  return { pdf: buildPdfFromJpegPages(pages), pageCount: tiles.length };
}
