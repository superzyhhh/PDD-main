import { createWechatModeration, allowAllModeration } from './moderation';
import { createServer } from './server';
import { createSessionService } from './session';

const port = Number(process.env.PORT ?? 3000);
const appId = process.env.WX_APP_ID;
const appSecret = process.env.WX_APP_SECRET;

const moderation =
  appId && appSecret
    ? createWechatModeration({ appId, appSecret })
    : allowAllModeration;

if (!appId || !appSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 WX_APP_ID / WX_APP_SECRET 才能启用内容安全校验');
  }
  console.warn('[pindo-miniapp] 未配置 WX_APP_ID / WX_APP_SECRET，内容安全校验为开发期直通模式');
}

const session = createSessionService({ appId, appSecret });

createServer({ moderation, session }).listen(port, () => {
  console.log(`[pindo-miniapp] server listening on :${port}`);
});
