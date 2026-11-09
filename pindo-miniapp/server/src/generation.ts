import sharp from 'sharp';
import { downscale, type DownscaledPixel, type PixelationMode } from './vendor/pindo-engine/downscaler';
import { matchColor, matchColors } from './vendor/pindo-engine/color-matcher';
import { applyDithering } from './vendor/pindo-engine/dithering';
import { cropToSubject } from './vendor/pindo-engine/subject-crop';
import { buildUsageMap, limitPaletteWithKeyColors } from './vendor/pindo-engine/palette-limit';
import type { CompiledBeadColor, DitheringMode } from './vendor/pindo-engine/types';
import { CANDIDATE_IDS, type Candidate, type CandidateId } from './types';

export const GRID_SIZE = 29;

const MAX_INPUT_PIXELS = 4096 * 4096;

/** 基础档 221：保主体细节的色号上限即档位上限。 */
const BASIC_TIER_COLOR_CAP = 221;

interface CandidateStrategy {
  id: CandidateId;
  downscale: PixelationMode;
  dithering: DitheringMode;
  maxColors: number;
}

/**
 * 三候选由既有引擎参数组合而成，顺序来自 CANDIDATE_IDS（规格「三候选策略」）。
 * 保主体细节：边缘感知降采样 + 抖动 + 放开到档位上限；
 * 保色彩层次：平均降采样 + 抖动 + 中等色号数；
 * 保少色号：平均降采样 + 关闭抖动 + 低色号数。
 */
const STRATEGY_PARAMS: Record<CandidateId, Omit<CandidateStrategy, 'id'>> = {
  detail: { downscale: 'edge-aware', dithering: 'floyd-steinberg', maxColors: BASIC_TIER_COLOR_CAP },
  color: { downscale: 'average', dithering: 'floyd-steinberg', maxColors: 64 },
  few: { downscale: 'average', dithering: 'none', maxColors: 24 },
};

const CANDIDATE_STRATEGIES: readonly CandidateStrategy[] = CANDIDATE_IDS.map((id) => ({
  id,
  ...STRATEGY_PARAMS[id],
}));

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
 * 抠主体一次，按三套策略各出一张 29×29 图纸；返回值顺序即展示顺序。
 */
export function generateCandidates(image: DecodedImage, palette: CompiledBeadColor[]): Candidate[] {
  const cropped = cropToSubject(image.data, image.width, image.height, { background: 'white' });
  return CANDIDATE_STRATEGIES.map((strategy) => buildCandidate(cropped, palette, strategy));
}

function buildCandidate(
  cropped: { data: Uint8ClampedArray; width: number; height: number },
  palette: CompiledBeadColor[],
  strategy: CandidateStrategy,
): Candidate {
  const pixels = downscale(
    cropped.data,
    cropped.width,
    cropped.height,
    GRID_SIZE,
    GRID_SIZE,
    strategy.downscale,
  );

  // 先用完整色卡统计用量，再按策略压到目标色号数；色号上限不会突破档位。
  const targetPalette =
    strategy.maxColors < palette.length
      ? limitPaletteWithKeyColors(palette, buildUsageMap(matchColors(pixels, palette)), strategy.maxColors)
          .limitedPalette
      : palette;

  const nearest = (pixel: DownscaledPixel) => {
    const color = matchColor(pixel, targetPalette);
    return { r: color.rgb[0], g: color.rgb[1], b: color.rgb[2] };
  };
  const dithered = applyDithering(pixels, GRID_SIZE, GRID_SIZE, strategy.dithering, nearest);
  const matched = matchColors(dithered, targetPalette);

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
    const color = targetPalette.find((item) => item.code === code)!;
    return { code, name: color.name, hex: color.hex };
  });

  return {
    id: strategy.id,
    width: GRID_SIZE,
    height: GRID_SIZE,
    paletteTier: 'basic',
    grid,
    usage: usedCodes.map((code) => ({ code, count: usage.get(code)! })),
    colors,
  };
}
