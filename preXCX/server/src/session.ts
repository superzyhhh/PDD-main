import { createHash, randomUUID } from 'node:crypto';

export interface SessionService {
  /** 用 wx.login 的 code 换取本服务端会话 token。 */
  login(code: string): Promise<string>;
  openIdFor(token: string): string | undefined;
}

const MAX_SESSIONS = 5000;

/**
 * 微信静默登录。配置了 AppID/Secret 时走 jscode2session，否则用开发期假 openid。
 */
export function createSessionService(options: { appId?: string; appSecret?: string } = {}): SessionService {
  const sessions = new Map<string, string>();

  async function exchange(code: string): Promise<string> {
    if (!options.appId || !options.appSecret) {
      return `dev-${createHash('sha256').update(code).digest('hex').slice(0, 16)}`;
    }
    const url =
      'https://api.weixin.qq.com/sns/jscode2session?grant_type=authorization_code' +
      `&appid=${encodeURIComponent(options.appId)}&secret=${encodeURIComponent(options.appSecret)}` +
      `&js_code=${encodeURIComponent(code)}`;
    const response = await fetch(url);
    const body = (await response.json()) as { openid?: string; errmsg?: string };
    if (!body.openid) throw new Error(`jscode2session 失败：${body.errmsg ?? 'unknown'}`);
    return body.openid;
  }

  return {
    async login(code) {
      const openId = await exchange(code);
      const token = randomUUID();
      sessions.set(token, openId);
      if (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest) sessions.delete(oldest);
      }
      return token;
    },
    openIdFor(token) {
      return sessions.get(token);
    },
  };
}
