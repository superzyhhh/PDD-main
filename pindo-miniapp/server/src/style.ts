import sharp from 'sharp';

/** 风格族：原图表示不做风格化，其余五种交给风格服务处理。 */
export const STYLE_IDS = ['original', 'anime', 'chibi', 'pixel', 'realistic', 'line'] as const;

export type StyleId = (typeof STYLE_IDS)[number];

/** 需要风格服务的风格，排除原图。 */
export type GeneratedStyleId = Exclude<StyleId, 'original'>;

export const DEFAULT_STYLE: StyleId = 'original';

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
  /** 真实适配器用于超时与取消；本轮假实现同步完成，无需响应。 */
  signal?: AbortSignal;
}

/** 风格服务适配层：小程序端不持有厂商密钥，全部由服务端注入。 */
export interface StyleProvider {
  readonly available: boolean;
  stylize(input: StyleInput): Promise<StylizedImage>;
}

/** 未配置风格服务等同于关闭：原图流程不变，非原图请求直接不可用。 */
export const unconfiguredStyleProvider: StyleProvider = {
  available: false,
  async stylize() {
    throw new Error('style provider is not configured');
  },
};

/**
 * 确定性假实现：按风格做固定的像素处理，输出可解码 PNG。
 * 用于本地演示与自动化测试，不构成真实生成式服务。
 */
export function createFakeStyleProvider(): StyleProvider {
  return {
    available: true,
    async stylize({ buffer, style }) {
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
