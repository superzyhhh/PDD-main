import sharp from 'sharp';
import { DEFAULT_ADVANCED_SETTINGS, type AdvancedSettings } from './advanced-settings';
import { downscale, type DownscaledPixel, type PixelationMode } from './vendor/pindo-engine/downscaler';
import { matchColor, matchColors } from './vendor/pindo-engine/color-matcher';
import { applyDithering } from './vendor/pindo-engine/dithering';
import { cropToSubject } from './vendor/pindo-engine/subject-crop';
import { buildUsageMap, limitPaletteWithKeyColors } from './vendor/pindo-engine/palette-limit';
import type { CompiledBeadColor, DitheringMode } from './vendor/pindo-engine/types';
import {
  CANDIDATE_IDS,
  type Candidate,
  type CandidateId,
  type PaletteTier,
  type SizeTier,
} from './types';

/** 拼板规格统一按 29 格一块板。 */
export const BOARD_SIZE = 29;

/** 成品尺寸档：小 29×29（1 块板）、中 58×58（4 块）、大 87×87（9 块）。 */
export const SIZE_TIER_GRID: Record<SizeTier, number> = {
  small: BOARD_SIZE,
  medium: BOARD_SIZE * 2,
  large: BOARD_SIZE * 3,
};

const MAX_INPUT_PIXELS = 4096 * 4096;

interface CandidateStrategy {
  id: CandidateId;
  downscale: PixelationMode;
  dithering: DitheringMode;
  maxColors: number;
}

type StrategyParams = Omit<CandidateStrategy, 'id'>;

/**
 * 三候选由既有引擎参数组合而成，顺序来自 CANDIDATE_IDS（规格「三候选策略」）。
 * 保主体细节：边缘感知降采样 + 抖动 + 放开到档位上限；
 * 保色彩层次：平均降采样 + 抖动 + 中等色号数；
 * 保少色号：平均降采样 + 关闭抖动 + 低色号数。
 */
const STRATEGY_PARAMS: Record<CandidateId, StrategyParams> = {
  detail: { downscale: 'edge-aware', dithering: 'floyd-steinberg', maxColors: Number.POSITIVE_INFINITY },
  color: { downscale: 'average', dithering: 'floyd-steinberg', maxColors: 64 },
  few: { downscale: 'average', dithering: 'none', maxColors: 24 },
};

export interface GenerationOptions {
  sizeTier: SizeTier;
  paletteTier: PaletteTier;
  /** 高级设置；缺省时三候选沿用各自的自动策略。 */
  settings?: AdvancedSettings;
}

/** 一张图纸的格网规格：格宽、拼板数与所属色卡档位。 */
interface GridSpec {
  gridSize: number;
  boardCount: number;
  paletteTier: PaletteTier;
}

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
 * 抠主体一次，按尺寸档与色卡档、三套策略各出一张图纸；返回值顺序即展示顺序。
 */
export function generateCandidates(
  image: DecodedImage,
  palette: CompiledBeadColor[],
  options: GenerationOptions,
): Candidate[] {
  const settings = options.settings ?? DEFAULT_ADVANCED_SETTINGS;
  const gridSize = SIZE_TIER_GRID[options.sizeTier];
  const spec: GridSpec = {
    gridSize,
    boardCount: (gridSize / BOARD_SIZE) ** 2,
    paletteTier: options.paletteTier,
  };
  const cropped =
    settings.background === 'keep'
      ? { data: image.data, width: image.width, height: image.height }
      : cropToSubject(image.data, image.width, image.height, { background: 'white' });

  return CANDIDATE_IDS.map((id) => {
    const base = STRATEGY_PARAMS[id];
    const strategy: CandidateStrategy = {
      id,
      downscale: settings.downscale === 'auto' ? base.downscale : settings.downscale,
      dithering: settings.dithering === 'auto' ? base.dithering : settings.dithering,
      // 高级色号上限与档位上限取小，任何策略都不得突破。
      maxColors: Math.min(
        base.maxColors,
        settings.maxColors === 'auto' ? Number.POSITIVE_INFINITY : settings.maxColors,
        palette.length,
      ),
    };
    return buildCandidate(cropped, palette, strategy, spec);
  });
}

function buildCandidate(
  cropped: { data: Uint8ClampedArray; width: number; height: number },
  palette: CompiledBeadColor[],
  strategy: CandidateStrategy,
  spec: GridSpec,
): Candidate {
  const { gridSize, boardCount, paletteTier } = spec;
  const pixels = downscale(cropped.data, cropped.width, cropped.height, gridSize, gridSize, strategy.downscale);

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
  const dithered = applyDithering(pixels, gridSize, gridSize, strategy.dithering, nearest);
  const matched = matchColors(dithered, targetPalette);

  const grid: string[][] = [];
  const usage = new Map<string, number>();
  for (let y = 0; y < gridSize; y++) {
    const row: string[] = [];
    for (let x = 0; x < gridSize; x++) {
      const color = matched[y * gridSize + x];
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
    width: gridSize,
    height: gridSize,
    boardCount,
    paletteTier,
    grid,
    usage: usedCodes.map((code) => ({ code, count: usage.get(code)! })),
    colors,
  };
}
