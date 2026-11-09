import { createWechatModeration, allowAllModeration } from './moderation';
import { createSandboxPaymentProvider, unconfiguredPaymentProvider } from './payment';
import { createServer } from './server';
import { createSessionService } from './session';
import { createFakeStyleProvider } from './style';

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

// 支付渠道：真实微信支付需商户号、API v3 密钥与证书，配置前保持不可用；
// 本地可用 PAYMENT_SANDBOX=1 启用沙箱，生产环境禁止。
const sandboxPayment = process.env.PAYMENT_SANDBOX === '1';
if (sandboxPayment && process.env.NODE_ENV === 'production') {
  throw new Error('生产环境禁止启用 PAYMENT_SANDBOX');
}
const payment = sandboxPayment ? createSandboxPaymentProvider() : unconfiguredPaymentProvider;
if (!payment.available) {
  console.warn('[pindo-miniapp] 未配置微信支付商户参数，会员仅展示权益，暂不可开通');
}

// 291 进阶档额外白名单：逗号分隔的 openId。会员资格由服务端会员状态自动放行。
const advancedOpenIds = (process.env.ADVANCED_PALETTE_OPENIDS ?? '')
  .split(',')
  .map((openId) => openId.trim())
  .filter(Boolean);

const isAdvancedPaletteAllowed = (openId?: string): boolean =>
  !!openId && advancedOpenIds.includes(openId);

// 风格服务：真实厂商凭据到位前仅提供确定性假实现，生产环境禁止误用。
const styleSandbox = process.env.STYLE_SANDBOX === '1';
if (styleSandbox && process.env.NODE_ENV === 'production') {
  throw new Error('生产环境禁止启用 STYLE_SANDBOX');
}
const styleProvider = styleSandbox ? createFakeStyleProvider() : undefined;
if (!styleProvider) {
  console.warn('[pindo-miniapp] 未配置风格服务，风格族入口关闭，原图生成不受影响');
}

createServer({
  moderation,
  session,
  payment,
  style: styleProvider,
  isAdvancedPaletteAllowed,
  adminToken: process.env.ADMIN_TOKEN,
}).listen(port, () => {
  console.log(`[pindo-miniapp] server listening on :${port}`);
});
