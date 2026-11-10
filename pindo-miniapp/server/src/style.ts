import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { AdvancedSettings } from './advanced-settings';

/** 风格族：原图表示不做风格转换，其余按免费/高级分组。 */
export const STYLE_IDS = ['original', 'chibi', 'line', 'flat', 'pixel', 'anime', 'realistic'] as const;

export type StyleId = (typeof STYLE_IDS)[number];

/** 需要风格转换的风格，排除原图。 */
export type GeneratedStyleId = Exclude<StyleId, 'original'>;

export type StyleGroupId = 'free' | 'advanced';

export interface StyleDefinition {
  id: StyleId;
  label: string;
  group: StyleGroupId;
  requiresGenerativeModel: boolean;
}

/** 客户端按分组展示的最小信息，属性驱动，不依赖列表位置。 */
export interface StyleOption {
  id: StyleId;
  label: string;
  group: StyleGroupId;
  requiresGenerativeModel: boolean;
}

export interface StyleGroup {
  group: StyleGroupId;
  label: string;
  options: StyleOption[];
}

export const DEFAULT_STYLE: StyleId = 'original';

/** 风格服务默认超时；真实适配器可按供应商 SLA 调整。 */
export const DEFAULT_STYLE_TIMEOUT_MS = 8000;

/** 风格图缓存的条目上限，避免长进程无界增长。 */
export const MAX_STYLE_CACHE_ENTRIES = 60;

export const STYLE_LABELS: Record<StyleId, string> = {
  original: '原图',
  chibi: 'Q版',
  line: '线条风',
  flat: '平涂卡通',
  pixel: '像素风',
  anime: '动漫风',
  realistic: '写实风',
};

/** 用 Record 约束每个风格都必须有描述，新增风格时不会漏配。 */
const STYLE_DEFINITIONS: Record<StyleId, Omit<StyleDefinition, 'id' | 'label'>> = {
  original: { group: 'free', requiresGenerativeModel: false },
  chibi: { group: 'free', requiresGenerativeModel: false },
  line: { group: 'free', requiresGenerativeModel: false },
  flat: { group: 'free', requiresGenerativeModel: false },
  pixel: { group: 'free', requiresGenerativeModel: false },
  anime: { group: 'advanced', requiresGenerativeModel: true },
  realistic: { group: 'advanced', requiresGenerativeModel: true },
};

/** 风格目录：层级与是否需要生成式模型都由属性描述。 */
export const STYLES: readonly StyleDefinition[] = STYLE_IDS.map((id) => ({
  id,
  label: STYLE_LABELS[id],
  ...STYLE_DEFINITIONS[id],
}));

const STYLE_BY_ID = new Map<StyleId, StyleDefinition>(STYLES.map((item) => [item.id, item]));

export function styleDefinition(style: StyleId): StyleDefinition {
  const found = STYLE_BY_ID.get(style);
  if (!found) throw new Error(`unknown style: ${style}`);
  return found;
}

/** 高级风格需要外部生成式模型；免费风格始终由本地算法完成。 */
export function requiresGenerativeModel(style: StyleId): boolean {
  return styleDefinition(style).requiresGenerativeModel;
}

/** 按分组下发风格选项；高级风格不可用时整组不出现。 */
export function listStyleGroups(options: { includeAdvanced: boolean }): StyleGroup[] {
  const groups: StyleGroup[] = [
    {
      group: 'free',
      label: '免费风格',
      options: STYLES.filter((item) => item.group === 'free'),
    },
  ];
  if (options.includeAdvanced) {
    groups.push({
      group: 'advanced',
      label: '高级风格',
      options: STYLES.filter((item) => item.group === 'advanced'),
    });
  }
  return groups;
}

export function isStyleId(value: unknown): value is StyleId {
  return typeof value === 'string' && (STYLE_IDS as readonly string[]).includes(value);
}

export interface StylizedImage {
  buffer: Buffer;
  contentType: string;
}

export interface StyleInput {
  buffer: Buffer;
  contentType: string;
  style: GeneratedStyleId;
  /** 真实适配器用于超时与取消；假实现仅模拟超时行为，最终由服务端超时兜底。 */
  signal?: AbortSignal;
}

/** 风格服务适配层：小程序端不持有厂商密钥，全部由服务端注入。 */
export interface StyleProvider {
  readonly available: boolean;
  /** 模型/提示词版本，参与风格缓存键；版本变化必须让旧风格缓存失效。 */
  readonly version: string;
  /** 单次风格化超时毫秒数，缺省用 DEFAULT_STYLE_TIMEOUT_MS。 */
  readonly timeoutMs?: number;
  stylize(input: StyleInput): Promise<StylizedImage>;
}

/** 未配置风格服务等同于关闭：原图流程不变，非原图请求直接不可用。 */
export const unconfiguredStyleProvider: StyleProvider = {
  available: false,
  version: 'none',
  async stylize() {
    throw new Error('style provider is not configured');
  },
};

/** 本地算法版本；算法一改动就需要让旧缓存失效。 */
export const LOCAL_STYLE_VERSION = 'local-v3';

/**
 * 风格工作尺寸：最大成品格网（87）的 4 倍，与成品尺寸档解耦，
 * 保证同一原图同风格只转换一次；出图时再降采样到目标格网。
 */
export const STYLE_WORKING_SIZE = 348;

/** 风格图统一按比例铺满方形画布，与出图降采样的口径保持一致。 */
const WORKING_RESIZE = { fit: 'fill', background: '#ffffff' } as const;

/** 把图片归一到风格工作尺寸，输出 PNG。 */
export async function resizeToWorkingSize(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .flatten({ background: '#ffffff' })
    .resize(STYLE_WORKING_SIZE, STYLE_WORKING_SIZE, WORKING_RESIZE)
    .png()
    .toBuffer();
}

/** 把抠好的主体编码成风格服务输入：固定工作尺寸、不带原始 EXIF。 */
export async function encodeStyleInput(image: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Promise<Buffer> {
  return sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(STYLE_WORKING_SIZE, STYLE_WORKING_SIZE, WORKING_RESIZE)
    .png()
    .toBuffer();
}

/** 3×3 均值平滑（单通道），压掉噪点，让边缘与色块更稳。 */
function boxBlur3(input: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(input.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          sum += input[ny * width + nx];
          count += 1;
        }
      }
      output[y * width + x] = sum / count;
    }
  }
  return output;
}

/** 轮廓墨色，Q 版与线条风共用。 */
const OUTLINE_RGB = [40, 40, 40] as const;

/** Q 版使用的色阶数量，压掉连续色阶让色块更整。 */
const CHIBI_LEVELS = 5;

/** Q 版轮廓粗细；工作图为成品小档格网的 12 倍，6px 约半个成品格。 */
const CHIBI_OUTLINE_WIDTH = 6;
const CHIBI_EDGE_THRESHOLD = 20;

/** Q 版：平滑 → 有限色阶 → 加粗轮廓；比例不变，只做圆润简化。 */
async function renderChibi(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // 3×3 均值平滑：压掉照片噪点，让色块连通不碎。
  const smooth = new Float32Array(width * height * 3);
  for (let channel = 0; channel < 3; channel++) {
    const values = new Float32Array(width * height);
    for (let p = 0; p < values.length; p++) values[p] = data[p * channels + channel];
    const blurred = boxBlur3(values, width, height);
    for (let p = 0; p < blurred.length; p++) smooth[p * 3 + channel] = blurred[p];
  }

  // 每通道 5 级量化：拼豆色号更少，色块边界更清晰。
  const step = 255 / (CHIBI_LEVELS - 1);
  const quantized = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < smooth.length; i++) {
    quantized[i] = Math.round(smooth[i] / step) * step;
  }

  // 色块交界处画加粗深色轮廓，做「圆润简化」的勾边。
  const result = new Uint8ClampedArray(quantized);
  const paintOutline = (x: number, y: number) => {
    for (let dy = 0; dy < CHIBI_OUTLINE_WIDTH; dy++) {
      for (let dx = 0; dx < CHIBI_OUTLINE_WIDTH; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= width || ny >= height) continue;
        const o = (ny * width + nx) * 3;
        result[o] = OUTLINE_RGB[0];
        result[o + 1] = OUTLINE_RGB[1];
        result[o + 2] = OUTLINE_RGB[2];
      }
    }
  };
  const differs = (a: number, b: number) =>
    Math.abs(quantized[a] - quantized[b]) > CHIBI_EDGE_THRESHOLD ||
    Math.abs(quantized[a + 1] - quantized[b + 1]) > CHIBI_EDGE_THRESHOLD ||
    Math.abs(quantized[a + 2] - quantized[b + 2]) > CHIBI_EDGE_THRESHOLD;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const edge =
        (x + 1 < width && differs(o, o + 3)) || (y + 1 < height && differs(o, o + width * 3));
      if (edge) paintOutline(x, y);
    }
  }

  return sharp(Buffer.from(result.buffer), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** 线条风判定：白底占比下限，以及非白像素里允许出现的大块实心区域比例上限。 */
const LINE_ART_WHITE_RATIO = 0.4;
const LINE_ART_CORE_RATIO = 0.1;
const LINE_ART_CORE_RADIUS = 12;

/** 线条风描边：常规/低对比度两档边缘阈值，描边粗细按成品小档格网可辨识来定。 */
const LINE_EDGE_THRESHOLD = 110;
const LINE_EDGE_LOW_THRESHOLD = 45;
const LINE_EDGE_MIN_RATIO = 0.002;
const LINE_STROKE_RADIUS = 4;

/**
 * 线稿判定：白底占多数，且非白像素几乎都是细线条（没有大块实心区域）。
 * 用积分图判断每个非白像素周围是否有整块非白区域，避免依赖彩度而漏判彩色线稿。
 */
function isLineArt(mask: Uint8Array, width: number, height: number, whiteRatio: number): boolean {
  if (whiteRatio < LINE_ART_WHITE_RATIO) return false;

  const stride = width + 1;
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += mask[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  const windowSum = (x0: number, y0: number, x1: number, y1: number): number =>
    integral[(y1 + 1) * stride + x1 + 1] -
    integral[y0 * stride + x1 + 1] -
    integral[(y1 + 1) * stride + x0] +
    integral[y0 * stride + x0];

  let nonWhite = 0;
  let core = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      nonWhite += 1;
      const x0 = Math.max(0, x - LINE_ART_CORE_RADIUS);
      const y0 = Math.max(0, y - LINE_ART_CORE_RADIUS);
      const x1 = Math.min(width - 1, x + LINE_ART_CORE_RADIUS);
      const y1 = Math.min(height - 1, y + LINE_ART_CORE_RADIUS);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (windowSum(x0, y0, x1, y1) === area) core += 1;
    }
  }
  return nonWhite === 0 || core / nonWhite <= LINE_ART_CORE_RATIO;
}

/**
 * 线条风：已是线稿时原样保留（避免重复描边出现双线），
 * 否则用 Sobel 提取边缘并加粗描边，输出白底线条图。
 */
async function renderLine(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const total = width * height;

  const gray = new Float32Array(total);
  const mask = new Uint8Array(total);
  let whiteCount = 0;
  for (let p = 0; p < total; p++) {
    const i = p * channels;
    const value = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = value;
    if (value >= 235) {
      whiteCount += 1;
    } else {
      mask[p] = 1;
    }
  }

  if (isLineArt(mask, width, height, whiteCount / total)) {
    return sharp(input).grayscale().png().toBuffer();
  }

  // 平滑后取 Sobel 梯度，弱边缘被阈值滤掉，只留主体轮廓。
  const smooth = boxBlur3(gray, width, height);
  const magnitude = new Float32Array(total);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const o = y * width + x;
      const tl = smooth[o - width - 1];
      const t = smooth[o - width];
      const tr = smooth[o - width + 1];
      const l = smooth[o - 1];
      const r = smooth[o + 1];
      const bl = smooth[o + width - 1];
      const b = smooth[o + width];
      const br = smooth[o + width + 1];
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      magnitude[o] = Math.hypot(gx, gy);
    }
  }

  const edge = new Uint8Array(total);
  const markEdges = (threshold: number): number => {
    let count = 0;
    for (let p = 0; p < total; p++) {
      if (magnitude[p] <= threshold) continue;
      edge[p] = 1;
      count += 1;
    }
    return count;
  };
  const edgeCount = markEdges(LINE_EDGE_THRESHOLD);
  // 低对比度素材可能一个边缘都提不出来，退回低阈值重算，避免输出全白图纸。
  if (edgeCount / total < LINE_EDGE_MIN_RATIO) {
    edge.fill(0);
    markEdges(LINE_EDGE_LOW_THRESHOLD);
  }

  // 描边加粗到足够宽，缩到成品小档格网仍能看见轮廓。
  const result = new Uint8ClampedArray(total * 3).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!edge[y * width + x]) continue;
      for (let dy = -LINE_STROKE_RADIUS; dy <= LINE_STROKE_RADIUS; dy++) {
        for (let dx = -LINE_STROKE_RADIUS; dx <= LINE_STROKE_RADIUS; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const o = (ny * width + nx) * 3;
          result[o] = OUTLINE_RGB[0];
          result[o + 1] = OUTLINE_RGB[1];
          result[o + 2] = OUTLINE_RGB[2];
        }
      }
    }
  }

  return sharp(Buffer.from(result.buffer), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** 在风格工作尺寸上执行各风格的像素处理，返回 PNG。 */
async function renderStyleVariant(working: Buffer, style: GeneratedStyleId): Promise<Buffer> {
  switch (style) {
    case 'pixel':
      return sharp(working)
        .resize({ width: 64, kernel: 'nearest' })
        .resize(STYLE_WORKING_SIZE, STYLE_WORKING_SIZE, { kernel: 'nearest' })
        .png()
        .toBuffer();
    case 'line':
      return renderLine(working);
    case 'flat':
      return sharp(working).median(5).sharpen().png().toBuffer();
    case 'chibi':
      return renderChibi(working);
    case 'anime':
      return sharp(working).modulate({ saturation: 1.6 }).sharpen().png().toBuffer();
    case 'realistic':
      return sharp(working).normalise().png().toBuffer();
    default:
      throw new Error('unsupported style');
  }
}

/**
 * 本地风格转换：免费风格的全部实现都在这里，输出可解码 PNG。
 * 确定性输出，不依赖任何外部服务。
 */
async function renderStyledImage(buffer: Buffer, style: GeneratedStyleId): Promise<StylizedImage> {
  const working = await resizeToWorkingSize(buffer);
  return { buffer: await renderStyleVariant(working, style), contentType: 'image/png' };
}

/** 免费风格的本地转换器：不依赖外部服务，因此始终可用。 */
export function createLocalStyleProvider(): StyleProvider {
  return {
    available: true,
    version: LOCAL_STYLE_VERSION,
    stylize({ buffer, style }) {
      return renderStyledImage(buffer, style);
    },
  };
}

/**
 * 风格图缓存键：原图内容 + 风格标识 + 算法/模型版本 + 背景模式。
 * 背景模式决定风格转换拿到的是整图还是抠出的主体，必须计入键。
 */
export function styleCacheKey(
  image: Buffer,
  style: GeneratedStyleId,
  version: string,
  background: AdvancedSettings['background'],
): string {
  return createHash('sha256')
    .update(image)
    .update(`|${style}|${version}|${background}`)
    .digest('hex');
}

/** 进程内风格图缓存；同一张原图同一种风格只调用一次风格服务。 */
export class StyleCache {
  private readonly entries = new Map<string, StylizedImage>();

  get(key: string): StylizedImage | undefined {
    return this.entries.get(key);
  }

  set(key: string, image: StylizedImage): void {
    this.entries.set(key, image);
    if (this.entries.size <= MAX_STYLE_CACHE_ENTRIES) return;
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}

export type FakeStyleBehavior = 'success' | 'timeout' | 'error' | 'bad-image';

export interface FakeStyleOptions {
  /** 测试与演示用的稳定行为；缺省成功。 */
  behavior?: FakeStyleBehavior;
  /** 覆盖默认超时，便于测试快速触发超时。 */
  timeoutMs?: number;
}

/**
 * 确定性假实现：按风格做固定的像素处理，输出可解码 PNG。
 * 用于本地演示与自动化测试，不构成真实生成式服务。
 */
export function createFakeStyleProvider(options: FakeStyleOptions = {}): StyleProvider {
  const behavior = options.behavior ?? 'success';
  return {
    available: true,
    version: 'fake-v1',
    timeoutMs: options.timeoutMs,
    async stylize({ buffer, style, signal }) {
      if (behavior === 'timeout') {
        // 永不完成，但响应服务端的取消信号；超时兜底仍由服务端负责。
        return new Promise<StylizedImage>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('风格服务已取消')), {
            once: true,
          });
        });
      }
      if (behavior === 'error') throw new Error('fake style provider rejected the request');
      if (behavior === 'bad-image') {
        return { buffer: Buffer.from('not-an-image'), contentType: 'image/png' };
      }
      // 成功路径复用本地算法，保证测试与演示输出确定且不需要真实生成式服务。
      return renderStyledImage(buffer, style);
    },
  };
}
