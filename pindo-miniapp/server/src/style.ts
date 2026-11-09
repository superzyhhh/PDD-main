import { createHash } from 'node:crypto';
import sharp from 'sharp';

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
export const LOCAL_STYLE_VERSION = 'local-v1';

/**
 * 本地风格转换：免费风格的全部实现都在这里，输出可解码 PNG。
 * 确定性输出，不依赖任何外部服务。
 */
async function renderStyledImage(buffer: Buffer, style: GeneratedStyleId): Promise<StylizedImage> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('style input is not decodable');

  const base = sharp(buffer).flatten({ background: '#ffffff' });
  switch (style) {
    case 'pixel': {
      const small = await base
        .resize({ width: Math.min(width, 64), kernel: 'nearest' })
        .png()
        .toBuffer();
      return {
        buffer: await sharp(small).resize({ width, height, kernel: 'nearest' }).png().toBuffer(),
        contentType: 'image/png',
      };
    }
    case 'line':
      return { buffer: await base.grayscale().threshold(160).png().toBuffer(), contentType: 'image/png' };
    case 'flat':
      return { buffer: await base.median(5).sharpen().png().toBuffer(), contentType: 'image/png' };
    case 'chibi':
      return {
        buffer: await base
          .modulate({ saturation: 1.35, brightness: 1.08 })
          .blur(0.8)
          .png()
          .toBuffer(),
        contentType: 'image/png',
      };
    case 'anime':
      return { buffer: await base.modulate({ saturation: 1.6 }).sharpen().png().toBuffer(), contentType: 'image/png' };
    case 'realistic':
      return { buffer: await base.normalise().png().toBuffer(), contentType: 'image/png' };
    default:
      throw new Error('unsupported style');
  }
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

/** 风格图缓存键：原图内容 + 风格标识 + 算法/模型版本。 */
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
      // 成功路径复用本地算法，保证测试与演示输出确定且不需要真实生成式服务。
      return renderStyledImage(buffer, style);
    },
  };
}
