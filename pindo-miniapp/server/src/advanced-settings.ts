import type { CompiledBeadColor } from './vendor/pindo-engine/types';

/** 引擎的 ordered 抖动是占位实现（原样返回），不向用户暴露无效选项。 */
export const DITHERING_SETTINGS = ['auto', 'none', 'floyd-steinberg'] as const;

/** 背景处理：auto 自动裁掉背景，keep 保留整图不做裁切。 */
export const BACKGROUND_SETTINGS = ['auto', 'keep'] as const;

export const DOWNSCALE_SETTINGS = ['auto', 'average', 'edge-aware', 'dominant'] as const;

/** MARD 基础档（221）系列：A–H 彩色与 M 灰阶。 */
export const BASIC_SERIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'] as const;

/** 进阶档（291）在基础档之外追加的系列。 */
export const ADVANCED_SERIES = ['P', 'Q', 'R', 'T', 'Y', 'ZG'] as const;

/** MARD 色号系列：A–H 基础、M 灰阶、P/Q/R/T/Y 与 ZG 进阶。 */
export const SERIES_CODES = [...BASIC_SERIES, ...ADVANCED_SERIES] as const;

export const MIN_ADVANCED_MAX_COLORS = 4;

export const MAX_ADVANCED_MAX_COLORS = 291;

/** 高级设置只影响下一次生成；默认值表示沿用三候选各自的自动策略。 */
export interface AdvancedSettings {
  dithering: (typeof DITHERING_SETTINGS)[number];
  background: (typeof BACKGROUND_SETTINGS)[number];
  maxColors: 'auto' | number;
  downscale: (typeof DOWNSCALE_SETTINGS)[number];
  /** 允许使用的色号系列；空数组表示不限制。 */
  series: string[];
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  dithering: 'auto',
  background: 'auto',
  maxColors: 'auto',
  downscale: 'auto',
  series: [],
};

/**
 * 解析客户端传来的高级设置。
 * 未传返回 undefined（使用默认值），格式非法返回 null（调用方回 400）。
 */
export function parseAdvancedSettings(raw: string | undefined): AdvancedSettings | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const input = value as Record<string, unknown>;
  const dithering = input.dithering ?? 'auto';
  const background = input.background ?? 'auto';
  const downscale = input.downscale ?? 'auto';
  if (!(DITHERING_SETTINGS as readonly unknown[]).includes(dithering)) return null;
  if (!(BACKGROUND_SETTINGS as readonly unknown[]).includes(background)) return null;
  if (!(DOWNSCALE_SETTINGS as readonly unknown[]).includes(downscale)) return null;

  const maxColors = input.maxColors ?? 'auto';
  const validMaxColors =
    maxColors === 'auto' ||
    (typeof maxColors === 'number' &&
      Number.isInteger(maxColors) &&
      maxColors >= MIN_ADVANCED_MAX_COLORS &&
      maxColors <= MAX_ADVANCED_MAX_COLORS);
  if (!validMaxColors) return null;

  const rawSeries = input.series ?? [];
  if (!Array.isArray(rawSeries)) return null;
  const series: string[] = [];
  for (const item of rawSeries) {
    if (typeof item !== 'string' || !(SERIES_CODES as readonly string[]).includes(item)) return null;
    if (!series.includes(item)) series.push(item);
  }

  return {
    dithering: dithering as AdvancedSettings['dithering'],
    background: background as AdvancedSettings['background'],
    maxColors: maxColors as AdvancedSettings['maxColors'],
    downscale: downscale as AdvancedSettings['downscale'],
    series,
  };
}

export function seriesOfCode(code: string): string {
  return code.startsWith('ZG') ? 'ZG' : code.slice(0, 1);
}

/** 按系列过滤色卡；空数组表示不限制。 */
export function filterPaletteBySeries(
  palette: CompiledBeadColor[],
  series: string[],
): CompiledBeadColor[] {
  if (series.length === 0) return palette;
  return palette.filter((color) => series.includes(seriesOfCode(color.code)));
}

/** 参与内容寻址的参数指纹，保证同图同参只算一次、换参数必重新生成。 */
export function settingsFingerprint(settings: AdvancedSettings): string {
  return JSON.stringify({
    dithering: settings.dithering,
    background: settings.background,
    maxColors: settings.maxColors,
    downscale: settings.downscale,
    series: [...settings.series].sort(),
  });
}
