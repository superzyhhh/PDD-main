import sharp from 'sharp';
import { downscale, type DownscaledPixel } from './vendor/pindo-engine/downscaler';
import { matchColor, matchColors } from './vendor/pindo-engine/color-matcher';
import { applyDithering } from './vendor/pindo-engine/dithering';
import { cropToSubject } from './vendor/pindo-engine/subject-crop';
import type { CompiledBeadColor } from './vendor/pindo-engine/types';
import type { Candidate } from './types';

export const GRID_SIZE = 29;

const MAX_INPUT_PIXELS = 4096 * 4096;

export type DecodeFailure = 'unsupported' | 'too-large';

export class ImageDecodeError extends Error {
  constructor(readonly reason: DecodeFailure) {
    super(`image decode failed: ${reason}`);
  }
}

export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 服务端图片解码，替代 Pindo 的浏览器 image-loader：
 * 按 EXIF 方向摆正 → 透明区域压白底 → 输出 RGBA。
 */
export async function decodeImage(buffer: Buffer): Promise<DecodedImage> {
  try {
    const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) throw new Error('empty image');
    return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit|too large/i.test(message)) throw new ImageDecodeError('too-large');
    throw new ImageDecodeError('unsupported');
  }
}

/**
 * 工单 01 的唯一边路：智能抠主体 → 边缘感知降采样 → 抖动 → MARD 221 色号匹配。
 */
export function generateCandidate(image: DecodedImage, palette: CompiledBeadColor[]): Candidate {
  const cropped = cropToSubject(image.data, image.width, image.height, { background: 'white' });

  const pixels = downscale(cropped.data, cropped.width, cropped.height, GRID_SIZE, GRID_SIZE, 'edge-aware');

  const nearest = (pixel: DownscaledPixel) => {
    const color = matchColor(pixel, palette);
    return { r: color.rgb[0], g: color.rgb[1], b: color.rgb[2] };
  };
  const dithered = applyDithering(pixels, GRID_SIZE, GRID_SIZE, 'floyd-steinberg', nearest);
  const matched = matchColors(dithered, palette);

  const grid: string[][] = [];
  const usage = new Map<string, number>();
  for (let y = 0; y < GRID_SIZE; y++) {
    const row: string[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      const color = matched[y * GRID_SIZE + x];
      row.push(color.code);
      usage.set(color.code, (usage.get(color.code) ?? 0) + 1);
    }
    grid.push(row);
  }

  const usedCodes = [...usage.keys()].sort((a, b) => a.localeCompare(b));
  const colors = usedCodes.map((code) => {
    const color = palette.find((item) => item.code === code)!;
    return { code, name: color.name, hex: color.hex };
  });

  return {
    id: 'detail',
    width: GRID_SIZE,
    height: GRID_SIZE,
    paletteTier: 'basic',
    grid,
    usage: usedCodes.map((code) => ({ code, count: usage.get(code)! })),
    colors,
  };
}
