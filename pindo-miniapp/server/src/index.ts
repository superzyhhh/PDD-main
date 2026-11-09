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

// 291 进阶档白名单：逗号分隔的 openId。未配置时全部拒绝（会员体系见工单 05）。
const advancedOpenIds = (process.env.ADVANCED_PALETTE_OPENIDS ?? '')
  .split(',')
  .map((openId) => openId.trim())
  .filter(Boolean);

if (advancedOpenIds.length === 0) {
  console.warn('[pindo-miniapp] 未配置 ADVANCED_PALETTE_OPENIDS，291 进阶档将对所有账号关闭');
}

const isAdvancedPaletteAllowed = (openId?: string): boolean =>
  !!openId && advancedOpenIds.includes(openId);

createServer({ moderation, session, isAdvancedPaletteAllowed }).listen(port, () => {
  console.log(`[pindo-miniapp] server listening on :${port}`);
});
