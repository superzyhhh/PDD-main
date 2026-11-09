import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** 风格族：原图表示不做风格化，其余五种交给风格服务处理。 */
export const STYLE_IDS = ['original', 'anime', 'chibi', 'pixel', 'realistic', 'line'] as const;

export type StyleId = (typeof STYLE_IDS)[number];

/** 需要风格服务的风格，排除原图。 */
export type GeneratedStyleId = Exclude<StyleId, 'original'>;

export const DEFAULT_STYLE: StyleId = 'original';

/** 风格服务默认超时；真实适配器可按供应商 SLA 调整。 */
export const DEFAULT_STYLE_TIMEOUT_MS = 8000;

/** 风格图缓存的条目上限，避免长进程无界增长。 */
export const MAX_STYLE_CACHE_ENTRIES = 60;

export const STYLE_LABELS: Record<StyleId, string> = {
  original: '原图',
  anime: '动漫风',
  chibi: 'Q版',
  pixel: '像素风',
  realistic: '写实风',
  line: '线条风',
};

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

/** 风格图缓存键：原图内容 + 风格标识 + 模型/提示词版本。 */
export function styleCacheKey(image: Buffer, style: GeneratedStyleId, version: string): string {
  return createHash('sha256').update(image).update(`|${style}|${version}`).digest('hex');
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

      const meta = await sharp(buffer).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (!width || !height) throw new Error('style input is not decodable');

      const base = sharp(buffer).flatten({ background: '#ffffff' });
      if (style === 'pixel') {
        const small = await base
          .resize({ width: Math.min(width, 64), kernel: 'nearest' })
          .png()
          .toBuffer();
        return {
          buffer: await sharp(small).resize({ width, height, kernel: 'nearest' }).png().toBuffer(),
          contentType: 'image/png',
        };
      }

      const pipeline =
        style === 'anime'
          ? base.modulate({ saturation: 1.6 }).sharpen()
          : style === 'chibi'
            ? base.modulate({ saturation: 1.4, brightness: 1.1 })
            : style === 'realistic'
              ? base.normalise()
              : base.grayscale().threshold(160);
      return { buffer: await pipeline.png().toBuffer(), contentType: 'image/png' };
    },
  };
}
