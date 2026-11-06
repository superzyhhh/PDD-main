/**
 * 上传即过内容安全。生产环境用微信内容安全接口，开发/测试可注入直通实现。
 */
export type ModerationVerdict = 'pass' | 'block';

export interface Moderation {
  check(input: { buffer: Buffer; contentType: string }): Promise<ModerationVerdict>;
}

export const allowAllModeration: Moderation = {
  check: async () => 'pass',
};

const WECHAT_API = 'https://api.weixin.qq.com';

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** 微信图片内容安全（img_sec_check）。errcode 87014 表示命中。 */
export function createWechatModeration(options: { appId: string; appSecret: string }): Moderation {
  let token: CachedToken | undefined;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 60_000) return token.value;
    const url =
      `${WECHAT_API}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(options.appId)}&secret=${encodeURIComponent(options.appSecret)}`;
    const response = await fetch(url);
    const body = (await response.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
    if (!body.access_token) throw new Error(`获取 access_token 失败：${body.errmsg ?? 'unknown'}`);
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 };
    return token.value;
  }

  return {
    async check({ buffer }) {
      const form = new FormData();
      form.append('media', new Blob([buffer]), 'upload');
      const response = await fetch(`${WECHAT_API}/wxa/img_sec_check?access_token=${encodeURIComponent(await accessToken())}`, {
        method: 'POST',
        body: form,
      });
      const body = (await response.json()) as { errcode?: number; errmsg?: string };
      if (body.errcode === 0) return 'pass';
      if (body.errcode === 87014) return 'block';
      throw new Error(`内容安全接口返回 ${body.errcode ?? 'unknown'}：${body.errmsg ?? ''}`);
    },
  };
}
