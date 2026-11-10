import sharp from 'sharp';
import type { StyleProvider, StylizedImage } from './style';

/** 云函数返回的图片字节上限：生成式出图远小于此值，超出视为异常响应。 */
export const MAX_CLOUD_STYLE_BYTES = 8 * 1024 * 1024;

/** 云函数返回的像素数上限：超过 2K 视为异常，避免解码占满容器内存。 */
export const MAX_CLOUD_STYLE_PIXELS = 2048 * 2048;

/** 高级风格默认超时：外部模型比本地算法慢，留足调用与下载时间。 */
export const DEFAULT_CLOUD_STYLE_TIMEOUT_MS = 20_000;

export interface CloudFunctionStyleOptions {
  /** 云函数 HTTP 触发器地址；只由服务端配置，小程序端不持有。 */
  endpoint: string;
  /** 容器调用云函数的服务令牌；缺省表示内网免鉴权。 */
  token?: string;
  /** 模型/提示词版本，参与风格缓存键：版本变化必须让旧风格缓存失效。 */
  modelVersion: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxOutputPixels?: number;
}

/**
 * 高级风格的唯一出口：容器把工作图发给云函数，云函数内调用云开发 AI 图片生成，
 * 只把图片二进制回传。这里不接受外链，逐项校验内容类型、字节数、可解码与像素上限。
 */
export function createCloudFunctionStyleProvider(
  options: CloudFunctionStyleOptions,
): StyleProvider {
  if (options.modelVersion.trim() === '') {
    throw new Error('模型版本不能为空，否则风格缓存无法失效');
  }
  const maxBytes = options.maxOutputBytes ?? MAX_CLOUD_STYLE_BYTES;
  const maxPixels = options.maxOutputPixels ?? MAX_CLOUD_STYLE_PIXELS;

  async function readBounded(response: Response): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('云函数没有返回响应体');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('云函数返回图片超过大小上限');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** 失败分支也要把响应体丢掉，避免连接被挂住的响应占着不释放。 */
  async function discard(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  return {
    available: true,
    version: `cloud-${options.modelVersion}`,
    timeoutMs: options.timeoutMs ?? DEFAULT_CLOUD_STYLE_TIMEOUT_MS,
    async stylize({ buffer, contentType, style, signal }): Promise<StylizedImage> {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          'x-style': style,
          'x-model-version': options.modelVersion,
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: buffer,
        signal,
      });
      if (!response.ok) {
        await discard(response);
        throw new Error(`云函数返回 ${response.status}`);
      }

      const responseType = response.headers.get('content-type') ?? '';
      // 只按「有没有回图片」判断：JSON/文本多为外链或错误信息，一律不接受。
      if (responseType.startsWith('application/json') || responseType.startsWith('text/')) {
        await discard(response);
        throw new Error('云函数没有返回图片二进制');
      }

      const bytes = await readBounded(response);
      if (bytes.length === 0) throw new Error('云函数返回了空图片');

      let width: number;
      let height: number;
      try {
        const meta = await sharp(bytes).metadata();
        width = meta.width ?? 0;
        height = meta.height ?? 0;
      } catch {
        throw new Error('云函数返回的图片无法解码');
      }
      if (width === 0 || height === 0) throw new Error('云函数返回的图片无法解码');
      if (width * height > maxPixels) throw new Error('云函数返回图片超过尺寸上限');

      return { buffer: bytes, contentType };
    },
  };
}
