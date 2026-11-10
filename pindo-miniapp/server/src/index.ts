import { createWechatModeration, allowAllModeration } from './moderation';
import { createSandboxPaymentProvider, unconfiguredPaymentProvider } from './payment';
import { createCloudFunctionStyleProvider } from './cloud-function-style';
import { createServer } from './server';
import { createSessionService } from './session';
import { createFakeStyleProvider, type StyleProvider } from './style';

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

// 风格服务：优先接云函数出口；没有配置时仅提供确定性假实现（本地联调），生产环境禁止误用。
const styleSandbox = process.env.STYLE_SANDBOX === '1';
if (styleSandbox && process.env.NODE_ENV === 'production') {
  throw new Error('生产环境禁止启用 STYLE_SANDBOX');
}

const styleEndpoint = process.env.STYLE_CLOUD_FUNCTION_URL;
const styleModelVersion = process.env.STYLE_MODEL_VERSION;
let styleProvider: StyleProvider | undefined;
if (styleSandbox) {
  styleProvider = createFakeStyleProvider();
} else if (styleEndpoint && styleModelVersion) {
  const styleTimeoutMs = Number(process.env.STYLE_TIMEOUT_MS ?? '');
  styleProvider = createCloudFunctionStyleProvider({
    endpoint: styleEndpoint,
    token: process.env.STYLE_CLOUD_FUNCTION_TOKEN,
    modelVersion: styleModelVersion,
    ...(Number.isFinite(styleTimeoutMs) && styleTimeoutMs > 0 ? { timeoutMs: styleTimeoutMs } : {}),
  });
} else if (styleEndpoint) {
  // 模型版本进入风格缓存键，缺省会让旧缓存无法失效；宁可关闭高级风格也不带病上线。
  console.warn('[pindo-miniapp] STYLE_CLOUD_FUNCTION_URL 缺少 STYLE_MODEL_VERSION，高级风格入口关闭');
} else {
  console.warn('[pindo-miniapp] 未配置风格服务，高级风格入口关闭，免费风格与原图生成不受影响');
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
