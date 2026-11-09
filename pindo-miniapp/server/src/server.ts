import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseAnalyticsEvent } from './analytics';
import {
  DEFAULT_ADVANCED_SETTINGS,
  filterPaletteBySeries,
  parseAdvancedSettings,
  settingsFingerprint,
  type AdvancedSettings,
} from './advanced-settings';
import { FailureSampleStore, MAX_FAILURE_SAMPLES } from './failure-samples';
import { ImageDecodeError, decodeImage, encodeImage, generateCandidates } from './generation';
import {
  ExportStore,
  FREE_DAILY_EXPORT_LIMIT,
  QuotaExceededError,
  exportKey,
  renderHdExport,
  renderShareCover,
  type ExportFormat,
  type ExportRecord,
} from './exports';
import { consoleLogger, type Logger } from './logger';
import { MEMBERSHIP_PLANS, MembershipStore, PLAN_IDS, type PlanId } from './membership';
import {
  BLIND_TEST_WINNERS,
  DEFAULT_CHANNEL,
  MetricsStore,
  inTimeRange,
  sanitizeChannel,
  type BlindTestWinner,
} from './metrics';
import type { Moderation } from './moderation';
import { getAdvancedPalette, getBasicPalette } from './palette';
import { PaymentUnavailableError, unconfiguredPaymentProvider, type PaymentProvider } from './payment';
import { MAX_PATTERNS, PatternStore, patternSummary } from './patterns';
import { renderTiledPrintExport } from './print';
import { createSessionService, type SessionService } from './session';
import { MAX_SHARES, SHARE_SOURCES, ShareStore, type ShareRecord, type ShareSource } from './shares';
import {
  DEFAULT_STYLE,
  DEFAULT_STYLE_TIMEOUT_MS,
  STYLE_IDS,
  STYLE_LABELS,
  StyleCache,
  isStyleId,
  styleCacheKey,
  unconfiguredStyleProvider,
  type StyleId,
  type StyleInput,
  type StyleProvider,
  type StylizedImage,
} from './style';
import { TaskStore, type TaskMeta } from './store';
import {
  PALETTE_TIERS,
  SIZE_TIERS,
  type Candidate,
  type PaletteTier,
  type SavedPattern,
  type SizeTier,
  type TaskFailureCode,
} from './types';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface ServerOptions {
  /** 必填：内容安全校验不能有默认放行路径。 */
  moderation: Moderation;
  logger?: Logger;
  session?: SessionService;
  /** 支付渠道；缺省为未配置，客户端只能看到权益、不能下单。 */
  payment?: PaymentProvider;
  /** 风格服务；缺省为未配置，风格化能力关闭，原图流程不变。 */
  style?: StyleProvider;
  /** 测试注入时钟；缺省用系统时间。 */
  now?: () => Date;
  /** 291 进阶档的额外白名单（运营/测试用）；会员资格由服务端会员状态判定。 */
  isAdvancedPaletteAllowed?: (openId?: string) => boolean;
  /** 失败样本后台口令；未配置时后台查询接口不开放。 */
  adminToken?: string;
}

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function contentKey(buffer: Buffer, meta: TaskMeta): string {
  return createHash('sha256')
    .update(buffer)
    .update(
      `|${meta.sizeTier}|${meta.paletteTier}|${settingsFingerprint(meta.settings)}|${meta.style}`,
    )
    .digest('hex');
}

function failureFor(error: unknown): { code: TaskFailureCode; message: string } {
  if (error instanceof ImageDecodeError && error.reason === 'too-large') {
    return { code: 'image-too-large', message: '图片太大，请换一张尺寸小一些的图片' };
  }
  if (error instanceof ImageDecodeError) {
    return { code: 'image-unsupported', message: '这张图片无法识别，请换一张 JPG 或 PNG 图片' };
  }
  return { code: 'internal', message: '生成失败，请稍后重试' };
}

/** 看板时间参数：缺省表示不限，格式非法由调用方回 400。 */
function parseTimeBound(raw: string | null): { ok: true; value?: number } | { ok: false } {
  if (raw === null || raw === '') return { ok: true };
  const value = Date.parse(raw);
  return Number.isNaN(value) ? { ok: false } : { ok: true, value };
}

/** 含逗号、引号或换行的字段按 RFC 4180 加引号转义。 */
function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function createServer(options: ServerOptions): Server {
  const moderation = options.moderation;
  const logger = options.logger ?? consoleLogger;
  const session = options.session ?? createSessionService();
  const store = new TaskStore();
  const exportStore = new ExportStore();
  const patterns = new PatternStore();
  const memberships = new MembershipStore();
  const failureSamples = new FailureSampleStore();
  const shares = new ShareStore();
  const metrics = new MetricsStore();
  const now = options.now ?? (() => new Date());
  const payment = options.payment ?? unconfiguredPaymentProvider;
  const styleProvider = options.style ?? unconfiguredStyleProvider;
  const styleCache = new StyleCache();
  /** 同一张原图同一种风格的并发请求合并成一次调用，避免重复计费。 */
  const pendingStyles = new Map<string, Promise<StylizedImage>>();
  /** 同一账号同一图纸的并发导出只渲染一次，避免重复扣次。 */
  const pendingExports = new Map<string, Promise<ExportRecord>>();
  const basicPalette = getBasicPalette();
  const advancedPalette = getAdvancedPalette();
  const extraAdvancedAllow = options.isAdvancedPaletteAllowed ?? (() => false);

  /** 只复用同一请求上下文的任务：匿名归匿名，登录账号各自独立，保证生成即入我的图纸。 */
  function reusableTaskFor(key: string, openId?: string) {
    const reusable = store.findReusable(key);
    if (!reusable || store.ownerOf(reusable.id) !== openId) return undefined;
    return reusable;
  }

  /** 291 档位以服务端会员状态为准，额外白名单只用于运营/测试。 */
  function isAdvancedPaletteAllowed(openId?: string): boolean {
    return extraAdvancedAllow(openId) || memberships.isMember(openId, now());
  }

  /** 把图纸快照存入「我的图纸」，并把淘汰数量挂回任务，供客户端提示。 */
  function savePattern(openId: string, taskId: string, candidate: Candidate): SavedPattern {
    const saved = patterns.save(openId, taskId, candidate);
    const result: SavedPattern = { id: saved.pattern.id, evictedCount: saved.evictedCount };
    store.setSavedPattern(taskId, result);
    if (saved.evictedCount > 0) {
      logger.audit('pattern_evicted', {
        openId,
        taskId,
        evictedCount: saved.evictedCount,
        limit: MAX_PATTERNS,
        at: new Date().toISOString(),
      });
    }
    return result;
  }

  /** 风格化失败统一留痕，并以可识别原因结束任务。 */
  function failStyle(taskId: string, style: StyleId, stage: string, error: unknown): void {
    logger.warn('style_failed', {
      taskId,
      style,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
    store.fail(taskId, 'style-failed', '风格化失败，请重试');
  }

  /** 给风格服务调用套上超时与取消，避免第三方无响应时任务一直挂起。 */
  async function stylizeWithTimeout(input: StyleInput): Promise<StylizedImage> {
    const controller = new AbortController();
    const timeoutMs = styleProvider.timeoutMs ?? DEFAULT_STYLE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('风格服务超时'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        styleProvider.stylize({ ...input, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 缓存未命中时合并同键并发请求，缓存命中则不再调用风格服务。 */
  function stylizeOnce(cacheKey: string, input: StyleInput): Promise<StylizedImage> {
    const pending = pendingStyles.get(cacheKey);
    if (pending) return pending;
    const request = stylizeWithTimeout(input).finally(() => pendingStyles.delete(cacheKey));
    pendingStyles.set(cacheKey, request);
    return request;
  }

  async function runTask(taskId: string, image: Buffer, meta: TaskMeta): Promise<void> {
    const { sizeTier, paletteTier, settings, style } = meta;
    store.markProcessing(taskId);
    try {
      const source = await decodeImage(image);
      let decoded = source;
      if (style !== 'original') {
        // 风格缓存以原图内容 + 风格 + 模型版本为键：仅改尺寸/色卡/高级设置时直接复用。
        const cacheKey = styleCacheKey(image, style, styleProvider.version);
        const cached = styleCache.get(cacheKey);
        let styled: StylizedImage;
        if (cached) {
          // 缓存命中的风格图在首次生成时已通过内容安全，无需重复校验。
          styled = cached;
        } else {
          // 风格化在抠主体之前，拿到的是已摆正、不带 EXIF 的完整画面。
          try {
            styled = await stylizeOnce(cacheKey, {
              buffer: await encodeImage(source),
              contentType: 'image/png',
              style,
            });
          } catch (error) {
            failStyle(taskId, style, 'provider', error);
            return;
          }

          // 风格图输出同样要过内容安全，命中即结束任务，不进入出图。
          let verdict: 'pass' | 'block' = 'pass';
          try {
            verdict = await moderation.check({
              buffer: styled.buffer,
              contentType: styled.contentType,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('moderation_error', { taskId, stage: 'style-output', error: message });
            logger.audit('moderation_skipped', {
              taskId,
              stage: 'style-output',
              reason: message,
              at: new Date().toISOString(),
            });
          }
          if (verdict === 'block') {
            logger.audit('content_blocked', {
              taskId,
              stage: 'style-output',
              at: new Date().toISOString(),
            });
            store.fail(taskId, 'style-blocked', '风格化结果不符合内容规范，请换一张图');
            return;
          }
        }

        try {
          decoded = await decodeImage(styled.buffer);
        } catch (error) {
          failStyle(taskId, style, 'decode', error);
          return;
        }
        if (!cached) styleCache.set(cacheKey, styled);
      }

      const palette = filterPaletteBySeries(
        paletteTier === 'advanced' ? advancedPalette : basicPalette,
        settings.series,
      );
      const candidates = generateCandidates(decoded, palette, { sizeTier, paletteTier, settings });
      store.complete(taskId, candidates);
      // 未登录任务不落库；登录用户在生成完成时自动保存默认候选。
      const owner = store.ownerOf(taskId);
      metrics.recordGeneration({
        taskId,
        openId: owner,
        channel: store.channelOf(taskId) ?? DEFAULT_CHANNEL,
        at: now().getTime(),
      });
      if (owner) savePattern(owner, taskId, candidates[0]);
    } catch (error) {
      const failure = failureFor(error);
      if (failure.code === 'internal') {
        logger.warn('generate_failed', { taskId, error: error instanceof Error ? error.message : String(error) });
      }
      store.fail(taskId, failure.code, failure.message);
    }
  }

  async function handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let code: unknown;
    try {
      const body = await readBody(req, 4096);
      code = (JSON.parse(body.toString('utf8') || '{}') as { code?: unknown }).code;
    } catch {
      sendError(res, 400, 'invalid-code', '登录信息不完整，请重试');
      return;
    }
    if (typeof code !== 'string' || code.length === 0) {
      sendError(res, 400, 'invalid-code', '登录信息不完整，请重试');
      return;
    }
    try {
      const token = await session.login(code);
      sendJson(res, 200, { token });
    } catch (error) {
      logger.warn('session_failed', { error: error instanceof Error ? error.message : String(error) });
      sendError(res, 502, 'session-failed', '登录失败，请重试');
    }
  }

  async function handleEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readBody(req, 4096);
    } catch {
      sendError(res, 400, 'invalid-event', '埋点事件格式不正确');
      return;
    }
    let event: ReturnType<typeof parseAnalyticsEvent>;
    try {
      event = parseAnalyticsEvent(JSON.parse(raw.toString('utf8') || 'null'));
    } catch {
      event = undefined;
    }
    if (!event) {
      sendError(res, 400, 'invalid-event', '埋点事件格式不正确');
      return;
    }

    // 事件必须对应已完成任务里真实存在的那张候选，避免伪造「首图接受」。
    const view = store.toView(event.taskId);
    const candidate = view?.status === 'completed' ? view.candidates?.[event.index] : undefined;
    if (!candidate || candidate.id !== event.candidateId) {
      sendError(res, 400, 'invalid-event', '埋点事件与任务结果不匹配');
      return;
    }
    const owner = store.ownerOf(event.taskId);
    if (owner) {
      const token = String(req.headers['x-session-token'] ?? '');
      if ((token ? session.openIdFor(token) : undefined) !== owner) {
        sendError(res, 403, 'event-forbidden', '无权上报该任务的事件');
        return;
      }
    }

    logger.audit(event.name, {
      taskId: event.taskId,
      candidateId: event.candidateId,
      index: event.index,
      at: new Date().toISOString(),
    });
    if (event.name === 'first_pattern_accepted') {
      metrics.recordAcceptance({
        taskId: event.taskId,
        openId: owner,
        channel: store.channelOf(event.taskId) ?? DEFAULT_CHANNEL,
        at: now().getTime(),
      });
    }
    sendJson(res, 200, { ok: true });
  }

  function requestOpenId(req: IncomingMessage): string | undefined {
    const token = String(req.headers['x-session-token'] ?? '');
    return token ? session.openIdFor(token) : undefined;
  }

  function isIOSPlatform(req: IncomingMessage): boolean {
    return String(req.headers['x-platform'] ?? '').toLowerCase() === 'ios';
  }

  /** 权益状态与可购买的套餐都由服务端下发；iOS 不返回任何价格。 */
  function handleMembership(req: IncomingMessage, res: ServerResponse): void {
    const openId = requestOpenId(req);
    const status = openId ? memberships.statusOf(openId, now()) : undefined;
    const purchaseAvailable = !isIOSPlatform(req) && payment.available;
    // 风格族是否可用与可选项由服务端下发，不可用时客户端隐藏整组入口。
    const styleOptions = styleProvider.available
      ? STYLE_IDS.map((id) => ({ id, label: STYLE_LABELS[id] }))
      : [];
    sendJson(res, 200, {
      purchaseAvailable,
      plans: purchaseAvailable
        ? PLAN_IDS.map((id) => {
            const plan = MEMBERSHIP_PLANS[id];
            return {
              id: plan.id,
              label: plan.label,
              priceFen: plan.priceFen,
              priceLabel: plan.priceLabel,
              durationDays: plan.durationDays,
            };
          })
        : [],
      membership: status
        ? {
            active: status.active,
            plan: status.plan,
            expiresAt: new Date(status.expiresAt).toISOString(),
          }
        : null,
      styles: { available: styleProvider.available, options: styleOptions },
    });
  }

  async function handleCreateMembershipOrder(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isIOSPlatform(req)) {
      sendError(res, 403, 'purchase-not-allowed', '当前设备暂不支持开通会员');
      return;
    }
    const openId = requestOpenId(req);
    if (!openId) {
      sendError(res, 401, 'login-required', '请先登录再开通会员');
      return;
    }

    let rawPlan: unknown;
    try {
      const raw = await readBody(req, 4096);
      rawPlan = (JSON.parse(raw.toString('utf8') || '{}') as { plan?: unknown }).plan;
    } catch {
      sendError(res, 400, 'invalid-plan', '会员卡类型不正确');
      return;
    }
    const plan =
      typeof rawPlan === 'string' && (PLAN_IDS as readonly string[]).includes(rawPlan)
        ? (rawPlan as PlanId)
        : undefined;
    if (!plan) {
      sendError(res, 400, 'invalid-plan', '会员卡类型不正确');
      return;
    }

    const order = memberships.createOrder(openId, plan, now());
    let paymentParams: Record<string, unknown>;
    try {
      paymentParams = await payment.createPayment({
        orderId: order.id,
        openId,
        plan: order.plan,
        amountFen: order.amountFen,
        description: `拼豆图纸会员-${MEMBERSHIP_PLANS[order.plan].label}`,
      });
    } catch (error) {
      // 下单失败不留 pending 脏单，会员状态保持不变。
      memberships.closeOrder(order.id, 'failed');
      if (error instanceof PaymentUnavailableError) {
        sendError(res, 503, 'payment-unavailable', '支付暂未开通，请稍后再试');
        return;
      }
      throw error;
    }

    logger.audit('membership_order_created', {
      orderId: order.id,
      openId,
      plan: order.plan,
      amountFen: order.amountFen,
      at: new Date().toISOString(),
    });
    sendJson(res, 200, {
      orderId: order.id,
      plan: order.plan,
      amountFen: order.amountFen,
      payment: paymentParams,
    });
  }

  /** 支付渠道回调：只有校验通过的支付事实才能改变会员状态。 */
  async function handlePaymentNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readBody(req, 65536);
    } catch {
      sendError(res, 400, 'invalid-notification', '支付通知格式不正确');
      return;
    }
    const notification = await payment.parseNotification(raw, req.headers);
    if (!notification) {
      sendError(res, 400, 'invalid-notification', '支付通知无法校验');
      return;
    }
    const order = memberships.orderOf(notification.orderId);
    if (!order) {
      sendError(res, 400, 'unknown-order', '订单不存在');
      return;
    }

    if (notification.outcome === 'success') {
      const applied = memberships.confirmPaid(
        order.id,
        notification.transactionId ?? '',
        now(),
      );
      if (applied) metrics.recordMembershipActivated(order.openId, now().getTime());
      logger.audit(applied ? 'membership_activated' : 'membership_payment_duplicate', {
        orderId: order.id,
        openId: order.openId,
        plan: order.plan,
        transactionId: notification.transactionId,
        at: new Date().toISOString(),
      });
    } else {
      const closed = memberships.closeOrder(order.id, notification.outcome);
      logger.audit(closed ? 'membership_order_closed' : 'membership_payment_ignored', {
        orderId: order.id,
        openId: order.openId,
        status: notification.outcome,
        at: new Date().toISOString(),
      });
    }
    sendJson(res, 200, { ok: true });
  }

  async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sizeTier = String(req.headers['x-size-tier'] ?? 'small') as SizeTier;
    const paletteTier = String(req.headers['x-palette-tier'] ?? 'basic') as PaletteTier;
    if (!SIZE_TIERS.includes(sizeTier) || !PALETTE_TIERS.includes(paletteTier)) {
      sendError(res, 400, 'unsupported-option', '当前版本暂不支持该尺寸或色号档位');
      return;
    }

    const rawStyle = req.headers['x-style'];
    const styleHeader = Array.isArray(rawStyle) ? rawStyle[0] : rawStyle;
    // 缺省按原图处理；取值固定为六种，非法值直接拒绝。
    const style = styleHeader === undefined || styleHeader === '' ? DEFAULT_STYLE : styleHeader;
    if (!isStyleId(style)) {
      sendError(res, 400, 'invalid-style', '不支持该风格，请重新选择');
      return;
    }
    if (style !== 'original' && !styleProvider.available) {
      sendError(res, 503, 'style-unavailable', '当前版本暂不支持风格化，请选择原图');
      return;
    }

    const token = String(req.headers['x-session-token'] ?? '');
    const openId = token ? session.openIdFor(token) : undefined;
    // 渠道由投放链接带入，非法值统一归为直接访问。
    const rawChannel = req.headers['x-channel'];
    const channel = sanitizeChannel(Array.isArray(rawChannel) ? rawChannel[0] : rawChannel);
    if (paletteTier === 'advanced' && !isAdvancedPaletteAllowed(openId)) {
      sendError(res, 403, 'advanced-not-allowed', '291 进阶色卡仅对已开通会员开放');
      return;
    }

    const rawSettingsHeader = req.headers['x-advanced-settings'];
    const rawSettings = Array.isArray(rawSettingsHeader) ? rawSettingsHeader[0] : rawSettingsHeader;
    const parsedSettings = parseAdvancedSettings(rawSettings);
    if (parsedSettings === null) {
      sendError(res, 400, 'invalid-settings', '高级设置不可用，请重置后再试');
      return;
    }
    const settings = parsedSettings ?? DEFAULT_ADVANCED_SETTINGS;
    const sourcePalette = paletteTier === 'advanced' ? advancedPalette : basicPalette;
    if (filterPaletteBySeries(sourcePalette, settings.series).length === 0) {
      sendError(res, 400, 'invalid-settings', '当前系列过滤后没有可用色号，请放宽设置');
      return;
    }

    let image: Buffer;
    try {
      image = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendError(res, 413, 'image-too-large', '图片太大，请换一张小于 10MB 的图片');
        return;
      }
      throw error;
    }
    if (image.length === 0) {
      sendError(res, 400, 'empty-image', '没有收到图片，请重新上传');
      return;
    }

    const meta: TaskMeta = { sizeTier, paletteTier, settings, style };
    const key = contentKey(image, meta);
    const reusable = reusableTaskFor(key, openId);
    if (reusable) {
      sendJson(res, 202, { taskId: reusable.id, status: reusable.status });
      return;
    }

    const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
    let verdict: 'pass' | 'block' = 'pass';
    try {
      verdict = await moderation.check({ buffer: image, contentType });
    } catch (error) {
      // 内容安全接口异常时放行，但留痕，避免把可用性押在外部接口上。
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('moderation_error', { error: message });
      logger.audit('moderation_skipped', { contentKey: key, reason: message, at: new Date().toISOString() });
    }

    if (verdict === 'block') {
      logger.audit('content_blocked', {
        contentKey: key,
        bytes: image.length,
        at: new Date().toISOString(),
      });
      sendError(res, 422, 'content-unsafe', '这张图片不符合内容规范，请换一张图');
      return;
    }

    // 内容安全校验是异步的，并发提交可能在此期间已经建出任务；这里再查一次，
    // 保证同一内容的并发请求只落一个任务。
    const concurrent = reusableTaskFor(key, openId);
    if (concurrent) {
      sendJson(res, 202, { taskId: concurrent.id, status: concurrent.status });
      return;
    }

    const task = store.create(key, openId, meta, channel);
    sendJson(res, 202, { taskId: task.id, status: task.status });
    setImmediate(() => void runTask(task.id, image, meta));
  }

  /** 取当前登录账号；未登录时回 401 并返回 undefined。 */
  function requireOpenId(req: IncomingMessage, res: ServerResponse, message: string): string | undefined {
    const openId = requestOpenId(req);
    if (!openId) sendError(res, 401, 'login-required', message);
    return openId;
  }

  /** 「我的图纸」列表只返回摘要，逐格色号在打开时再取。 */
  function handleListPatterns(req: IncomingMessage, res: ServerResponse): void {
    const openId = requireOpenId(req, res, '请先登录再查看「我的图纸」');
    if (!openId) return;
    sendJson(res, 200, { limit: MAX_PATTERNS, patterns: patterns.list(openId).map(patternSummary) });
  }

  function handleGetPattern(req: IncomingMessage, res: ServerResponse, patternId: string): void {
    const openId = requireOpenId(req, res, '请先登录再查看「我的图纸」');
    if (!openId) return;
    const record = patterns.get(openId, patternId);
    if (!record) {
      sendError(res, 404, 'pattern-not-found', '图纸不存在或已删除');
      return;
    }
    const style = store.taskMeta(record.taskId)?.style;
    sendJson(res, 200, {
      pattern: {
        ...patternSummary(record),
        style,
        styleLabel: style ? STYLE_LABELS[style] : undefined,
        candidate: record.candidate,
      },
    });
  }

  /** 选中其他候选后原地更新同一张图纸，不新增列表条目。 */
  async function handleSavePattern(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const openId = requireOpenId(req, res, '请先登录再保存图纸');
    if (!openId) return;

    let body: { taskId?: unknown; candidateId?: unknown };
    try {
      const raw = await readBody(req, 4096);
      body = JSON.parse(raw.toString('utf8') || '{}') as { taskId?: unknown; candidateId?: unknown };
    } catch {
      sendError(res, 400, 'invalid-pattern', '图纸参数不正确');
      return;
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
    if (!taskId || !candidateId) {
      sendError(res, 400, 'invalid-pattern', '图纸参数不正确');
      return;
    }

    const view = store.toView(taskId);
    if (!view) {
      sendError(res, 404, 'task-not-found', '图纸不存在，请重新生成');
      return;
    }
    if (view.status !== 'completed') {
      sendError(res, 409, 'task-not-ready', '图纸还在生成，请稍后再保存');
      return;
    }
    // 匿名任务不落库：只有任务所有者本人才能保存。
    const owner = store.ownerOf(taskId);
    if (!owner || owner !== openId) {
      sendError(res, 403, 'pattern-forbidden', '只能保存自己生成的图纸');
      return;
    }
    const candidate = view.candidates?.find((item) => item.id === candidateId);
    if (!candidate) {
      sendError(res, 400, 'invalid-pattern', '没有找到这张候选图纸');
      return;
    }

    const saved = savePattern(openId, taskId, candidate);
    const record = patterns.get(openId, saved.id);
    if (!record) {
      sendError(res, 500, 'internal', '保存失败，请稍后重试');
      return;
    }
    sendJson(res, 200, { pattern: patternSummary(record), evictedCount: saved.evictedCount });
  }

  function handleDeletePattern(req: IncomingMessage, res: ServerResponse, patternId: string): void {
    const openId = requireOpenId(req, res, '请先登录再删除图纸');
    if (!openId) return;
    if (!patterns.remove(openId, patternId)) {
      sendError(res, 404, 'pattern-not-found', '图纸不存在或已删除');
      return;
    }
    sendJson(res, 200, { ok: true });
  }

  /** 后台口令校验；不同后台只换提示文案与错误码。 */
  function requireAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    labels = {
      disabledCode: 'samples-disabled',
      disabledMessage: '失败样本后台未启用',
      forbiddenMessage: '无权查看失败样本',
    },
  ): boolean {
    if (!options.adminToken) {
      sendError(res, 404, labels.disabledCode, labels.disabledMessage);
      return false;
    }
    if (String(req.headers['x-admin-token'] ?? '') !== options.adminToken) {
      sendError(res, 403, 'admin-forbidden', labels.forbiddenMessage);
      return false;
    }
    return true;
  }

  /** 三候选全不满意：把原图、参数与三候选一起留档，供后台回看。 */
  async function handleReportFailureSample(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const taskId = String(req.headers['x-task-id'] ?? '');
    if (!taskId) {
      sendError(res, 400, 'invalid-sample', '缺少图纸信息，请重新生成后再反馈');
      return;
    }
    const meta = store.taskMeta(taskId);
    if (!meta) {
      sendError(res, 404, 'task-not-found', '图纸不存在，请重新生成');
      return;
    }
    if (meta.status !== 'completed' || !meta.candidates?.length) {
      sendError(res, 409, 'task-not-ready', '图纸还在生成，请稍后再反馈');
      return;
    }
    const openId = requestOpenId(req);
    if (meta.openId && meta.openId !== openId) {
      sendError(res, 403, 'sample-forbidden', '无权提交该图纸的反馈');
      return;
    }

    let image: Buffer;
    try {
      image = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendError(res, 413, 'image-too-large', '图片太大，请换一张小于 10MB 的图片');
        return;
      }
      throw error;
    }
    if (image.length === 0) {
      sendError(res, 400, 'empty-image', '没有收到图片，请重新上传');
      return;
    }

    const sample = failureSamples.add({
      taskId,
      openId: meta.openId,
      sizeTier: meta.sizeTier,
      paletteTier: meta.paletteTier,
      settings: meta.settings,
      candidates: meta.candidates,
      image,
      imageContentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
    }, now().getTime());
    logger.audit('failure_sample', {
      sampleId: sample.id,
      taskId,
      openId: meta.openId,
      at: new Date().toISOString(),
    });
    sendJson(res, 201, { sampleId: sample.id });
  }

  function handleListFailureSamples(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!requireAdmin(req, res)) return;
    const rawLimit = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.floor(rawLimit)), MAX_FAILURE_SAMPLES)
      : 20;
    sendJson(res, 200, {
      samples: failureSamples.list(limit).map((sample) => ({
        id: sample.id,
        taskId: sample.taskId,
        openId: sample.openId,
        sizeTier: sample.sizeTier,
        paletteTier: sample.paletteTier,
        settings: sample.settings,
        candidates: sample.candidates,
        imageUrl: `/api/failure-samples/${sample.id}/image`,
        createdAt: new Date(sample.createdAt).toISOString(),
      })),
    });
  }

  function handleFailureSampleImage(req: IncomingMessage, res: ServerResponse, sampleId: string): void {
    if (!requireAdmin(req, res)) return;
    const sample = failureSamples.get(sampleId);
    if (!sample) {
      sendError(res, 404, 'sample-not-found', '失败样本不存在');
      return;
    }
    res.writeHead(200, {
      'content-type': sample.imageContentType,
      'content-length': String(sample.image.length),
      'cache-control': 'no-store',
    });
    res.end(sample.image);
  }

  /** 失败样本按创建时间导出 CSV，供运营按验证期区间取数。 */
  function handleExportFailureSamples(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!requireAdmin(req, res)) return;
    const from = parseTimeBound(url.searchParams.get('from'));
    const to = parseTimeBound(url.searchParams.get('to'));
    if (!from.ok || !to.ok) {
      sendError(res, 400, 'invalid-range', '时间范围格式不正确');
      return;
    }
    const rows = failureSamples
      .list(MAX_FAILURE_SAMPLES)
      .filter((sample) => inTimeRange(sample.createdAt, { from: from.value, to: to.value }))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((sample) =>
        [
          sample.id,
          sample.taskId,
          sample.openId ?? '',
          sample.sizeTier,
          sample.paletteTier,
          JSON.stringify(sample.settings),
          new Date(sample.createdAt).toISOString(),
          `/api/failure-samples/${sample.id}/image`,
        ]
          .map(csvEscape)
          .join(','),
      );
    const csv = [
      'sampleId,taskId,openId,sizeTier,paletteTier,settings,createdAt,imageUrl',
      ...rows,
    ].join('\n');
    const payload = `${csv}\n`;
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
      'content-disposition': 'attachment; filename="failure-samples.csv"',
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  const dashboardLabels = {
    disabledCode: 'metrics-disabled',
    disabledMessage: '验证看板后台未启用',
    forbiddenMessage: '无权查看验证看板',
  };

  /** 验证期四闸门的统一取数入口：时间区间 + 可选渠道。 */
  function handleMetricsSummary(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!requireAdmin(req, res, dashboardLabels)) return;
    const from = parseTimeBound(url.searchParams.get('from'));
    const to = parseTimeBound(url.searchParams.get('to'));
    if (!from.ok || !to.ok) {
      sendError(res, 400, 'invalid-range', '时间范围格式不正确');
      return;
    }
    const channel = url.searchParams.get('channel') || undefined;
    sendJson(res, 200, metrics.summary({ from: from.value, to: to.value, channel }));
  }

  async function handleRecordBlindTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requireAdmin(req, res, dashboardLabels)) return;
    let body: {
      testerId?: unknown;
      group?: unknown;
      competitor?: unknown;
      winner?: unknown;
    };
    try {
      const raw = await readBody(req, 4096);
      body = JSON.parse(raw.toString('utf8') || '{}') as typeof body;
    } catch {
      sendError(res, 400, 'invalid-blind-test', '盲测记录格式不正确');
      return;
    }
    const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const testerId = text(body.testerId);
    const group = text(body.group);
    const competitor = text(body.competitor);
    const winner = text(body.winner);
    if (
      !testerId ||
      testerId.length > 64 ||
      !group ||
      group.length > 32 ||
      !competitor ||
      competitor.length > 32 ||
      !BLIND_TEST_WINNERS.includes(winner as BlindTestWinner)
    ) {
      sendError(res, 400, 'invalid-blind-test', '盲测记录格式不正确');
      return;
    }
    metrics.recordBlindTest(
      { testerId, group, competitor, winner: winner as BlindTestWinner },
      now().getTime(),
    );
    sendJson(res, 201, { ok: true });
  }

  function handleListBlindTests(req: IncomingMessage, res: ServerResponse): void {
    if (!requireAdmin(req, res, dashboardLabels)) return;
    sendJson(res, 200, metrics.blindTestSummary());
  }

  /** 分享记录只公开这一张候选快照，不带任务号、账号或其他图纸。 */
  function shareView(record: ShareRecord): Record<string, unknown> {
    return {
      shareId: record.id,
      candidate: record.candidate,
      coverUrl: `/api/shares/${record.id}/cover`,
      createdAt: new Date(record.createdAt).toISOString(),
    };
  }

  /** 生成分享链接：复制当前候选快照，接收者无需登录即可查看。 */
  async function handleCreateShare(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { taskId?: unknown; candidateId?: unknown; source?: unknown };
    try {
      const raw = await readBody(req, 4096);
      body = JSON.parse(raw.toString('utf8') || '{}') as {
        taskId?: unknown;
        candidateId?: unknown;
        source?: unknown;
      };
    } catch {
      sendError(res, 400, 'invalid-share', '分享参数不正确');
      return;
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
    const source = typeof body.source === 'string' ? body.source : 'menu';
    if (!taskId || !candidateId || !SHARE_SOURCES.includes(source as ShareSource)) {
      sendError(res, 400, 'invalid-share', '分享参数不正确');
      return;
    }

    const meta = store.taskMeta(taskId);
    if (!meta) {
      sendError(res, 404, 'task-not-found', '图纸不存在，请重新生成');
      return;
    }
    if (meta.status !== 'completed' || !meta.candidates?.length) {
      sendError(res, 409, 'task-not-ready', '图纸还在生成，请稍后再分享');
      return;
    }
    const openId = requestOpenId(req);
    if (meta.openId && meta.openId !== openId) {
      sendError(res, 403, 'share-forbidden', '只能分享自己生成的图纸');
      return;
    }
    const candidate = meta.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      sendError(res, 400, 'invalid-share', '没有找到这张候选图纸');
      return;
    }

    const record = shares.create({
      taskId,
      candidateId: candidate.id,
      source: source as ShareSource,
      candidate,
      openId: meta.openId,
    });
    logger.audit('share_created', {
      shareId: record.id,
      taskId,
      candidateId: candidate.id,
      source,
      openId: meta.openId,
      at: new Date(record.createdAt).toISOString(),
    });
    sendJson(res, 201, { shareId: record.id, coverUrl: `/api/shares/${record.id}/cover` });
  }

  /** 公开查看：只按分享号取快照，无法枚举或越权打开其他图纸。 */
  function handleGetShare(req: IncomingMessage, res: ServerResponse, shareId: string): void {
    const record = shares.openAndCount(shareId);
    if (!record) {
      sendError(res, 404, 'share-not-found', '分享已失效');
      return;
    }
    sendJson(res, 200, shareView(record));
  }

  async function handleShareCover(req: IncomingMessage, res: ServerResponse, shareId: string): Promise<void> {
    const record = shares.get(shareId);
    if (!record) {
      sendError(res, 404, 'share-not-found', '分享已失效');
      return;
    }
    const cover = await renderShareCover(record.candidate);
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(cover.length),
      'cache-control': 'public, max-age=86400',
    });
    res.end(cover);
  }

  /** 后台统计分享次数、来源与打开次数。 */
  function handleListShares(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (
      !requireAdmin(req, res, {
        disabledCode: 'shares-disabled',
        disabledMessage: '分享后台未启用',
        forbiddenMessage: '无权查看分享统计',
      })
    ) {
      return;
    }
    const rawLimit = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.floor(rawLimit)), MAX_SHARES)
      : 20;
    sendJson(res, 200, {
      total: shares.total,
      shares: shares.list(limit).map((record) => ({
        shareId: record.id,
        taskId: record.taskId,
        candidateId: record.candidateId,
        source: record.source,
        openCount: record.openCount,
        createdAt: new Date(record.createdAt).toISOString(),
      })),
    });
  }

  async function handleCreateExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const openId = requireOpenId(req, res, '请先登录再导出高清图纸');
    if (!openId) return;
    // 会员无限导出；非会员按上海自然日计 1 次。额度一律由服务端判定。
    const quotaLimit = memberships.isMember(openId, now()) ? null : FREE_DAILY_EXPORT_LIMIT;

    let body: { taskId?: unknown; candidateId?: unknown; patternId?: unknown; type?: unknown };
    try {
      const raw = await readBody(req, 4096);
      body = JSON.parse(raw.toString('utf8') || '{}') as {
        taskId?: unknown;
        candidateId?: unknown;
        patternId?: unknown;
        type?: unknown;
      };
    } catch {
      sendError(res, 400, 'invalid-export', '导出参数不正确');
      return;
    }
    let taskId = typeof body.taskId === 'string' ? body.taskId : '';
    let candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
    const patternId = typeof body.patternId === 'string' ? body.patternId : '';
    const format: ExportFormat | undefined =
      body.type === undefined || body.type === 'hd'
        ? 'hd'
        : body.type === 'tiled'
          ? 'tiled'
          : undefined;
    if (!format) {
      sendError(res, 400, 'invalid-export', '导出参数不正确');
      return;
    }

    let candidate: Candidate;
    if (patternId) {
      // 从「我的图纸」重开时用保存的快照，任务表淘汰后仍可导出，缓存键不变。
      const record = patterns.get(openId, patternId);
      if (!record) {
        sendError(res, 404, 'pattern-not-found', '图纸不存在或已删除，请重新生成');
        return;
      }
      taskId = record.taskId;
      candidateId = record.candidate.id;
      candidate = record.candidate;
    } else {
      if (!taskId || !candidateId) {
        sendError(res, 400, 'invalid-export', '导出参数不正确');
        return;
      }
      const view = store.toView(taskId);
      if (!view) {
        sendError(res, 404, 'task-not-found', '任务不存在，请重新生成');
        return;
      }
      if (view.status !== 'completed') {
        sendError(res, 409, 'task-not-ready', '图纸还在生成，请稍后再导出');
        return;
      }
      const found = view.candidates?.find((item) => item.id === candidateId);
      if (!found) {
        sendError(res, 400, 'invalid-export', '没有找到这张候选图纸');
        return;
      }
      candidate = found;
      const owner = store.ownerOf(taskId);
      if (owner && owner !== openId) {
        sendError(res, 403, 'export-forbidden', '无权导出该图纸');
        return;
      }
    }

    const key = exportKey(openId, taskId, candidateId, format);
    const inFlight = pendingExports.get(key);
    if (inFlight) {
      sendExportResult(res, await inFlight, exportStore.usedToday(openId, quotaLimit, now()));
      return;
    }

    let decision: ReturnType<ExportStore['decide']>;
    try {
      decision = exportStore.decide(key, openId, quotaLimit, now());
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        metrics.recordQuotaExhausted(openId, now().getTime());
        logger.audit('export_quota_exceeded', {
          taskId,
          candidateId,
          openId,
          at: new Date().toISOString(),
        });
        sendError(
          res,
          429,
          'quota-exceeded',
          `今日 ${FREE_DAILY_EXPORT_LIMIT} 次免费导出已用完，开通会员可无限导出`,
        );
        return;
      }
      throw error;
    }

    let record: ExportRecord;
    if (decision.outcome === 'cached') {
      record = decision.record;
    } else {
      const creation = createExportRecord(key, openId, { taskId, candidateId, candidate, format });
      pendingExports.set(key, creation);
      try {
        record = await creation;
      } catch (error) {
        // 出图失败不占额度；会员本来就没有扣次。
        if (quotaLimit !== null) exportStore.refund(openId, now());
        throw error;
      } finally {
        pendingExports.delete(key);
      }
    }

    logger.audit(decision.outcome === 'cached' ? 'export_cache_hit' : 'export_created', {
      exportId: record.id,
      taskId,
      candidateId,
      openId,
      width: record.width,
      height: record.height,
      at: new Date().toISOString(),
    });
    sendExportResult(res, record, decision.quota);
  }

  function sendExportResult(res: ServerResponse, record: ExportRecord, quota: unknown): void {
    const suffix = record.format === 'tiled' ? 'pdf' : 'png';
    sendJson(res, 200, {
      exportId: record.id,
      url: `/api/exports/${record.id}.${suffix}`,
      taskId: record.taskId,
      candidateId: record.candidateId,
      type: record.format,
      format: suffix,
      pageCount: record.pageCount,
      width: record.width,
      height: record.height,
      quota,
    });
  }

  async function createExportRecord(
    key: string,
    openId: string,
    input: { taskId: string; candidateId: string; candidate: Candidate; format: ExportFormat },
  ): Promise<ExportRecord> {
    if (input.format === 'tiled') {
      const { pdf, pageCount } = await renderTiledPrintExport(input.candidate);
      return exportStore.save(key, {
        taskId: input.taskId,
        candidateId: input.candidateId,
        openId,
        format: 'tiled',
        pageCount,
        width: input.candidate.width,
        height: input.candidate.height,
        buffer: pdf,
      });
    }
    const buffer = await renderHdExport(input.candidate);
    return exportStore.save(key, {
      taskId: input.taskId,
      candidateId: input.candidateId,
      openId,
      format: 'hd',
      width: input.candidate.width,
      height: input.candidate.height,
      buffer,
    });
  }

  function handleDownloadExport(
    req: IncomingMessage,
    res: ServerResponse,
    exportId: string,
    suffix: string,
  ): void {
    const token = String(req.headers['x-session-token'] ?? '');
    const openId = token ? session.openIdFor(token) : undefined;
    if (!openId) {
      sendError(res, 401, 'login-required', '请先登录再下载图纸');
      return;
    }
    const record = exportStore.get(exportId);
    if (!record || record.format !== (suffix === 'pdf' ? 'tiled' : 'hd')) {
      sendError(res, 404, 'export-not-found', '导出资源不存在，请重新导出');
      return;
    }
    if (record.openId !== openId) {
      sendError(res, 403, 'export-forbidden', '无权下载该图纸');
      return;
    }
    res.writeHead(200, {
      'content-type': record.format === 'tiled' ? 'application/pdf' : 'image/png',
      'content-length': record.buffer.length,
      'cache-control': 'no-store',
    });
    res.end(record.buffer);
  }

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        await handleSession(req, res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/membership') {
        handleMembership(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/membership/orders') {
        await handleCreateMembershipOrder(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/membership/notify') {
        await handlePaymentNotify(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/generate') {
        await handleGenerate(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/events') {
        await handleEvent(req, res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/metrics/summary') {
        handleMetricsSummary(req, res, url);
        return;
      }

      if (url.pathname === '/api/metrics/blind-tests') {
        if (req.method === 'GET') {
          handleListBlindTests(req, res);
          return;
        }
        if (req.method === 'POST') {
          await handleRecordBlindTest(req, res);
          return;
        }
      }

      if (url.pathname === '/api/patterns') {
        if (req.method === 'GET') {
          handleListPatterns(req, res);
          return;
        }
        if (req.method === 'POST') {
          await handleSavePattern(req, res);
          return;
        }
      }

      const patternMatch = url.pathname.match(/^\/api\/patterns\/([^/]+)$/);
      if (patternMatch) {
        const patternId = decodeURIComponent(patternMatch[1]);
        if (req.method === 'GET') {
          handleGetPattern(req, res, patternId);
          return;
        }
        if (req.method === 'DELETE') {
          handleDeletePattern(req, res, patternId);
          return;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/failure-samples/export') {
        handleExportFailureSamples(req, res, url);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/failure-samples') {
        await handleReportFailureSample(req, res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/failure-samples') {
        handleListFailureSamples(req, res, url);
        return;
      }

      const sampleImageMatch = url.pathname.match(/^\/api\/failure-samples\/([^/]+)\/image$/);
      if (req.method === 'GET' && sampleImageMatch) {
        handleFailureSampleImage(req, res, decodeURIComponent(sampleImageMatch[1]));
        return;
      }

      if (url.pathname === '/api/shares') {
        if (req.method === 'POST') {
          await handleCreateShare(req, res);
          return;
        }
        if (req.method === 'GET') {
          handleListShares(req, res, url);
          return;
        }
      }

      const shareCoverMatch = url.pathname.match(/^\/api\/shares\/([^/]+)\/cover$/);
      if (req.method === 'GET' && shareCoverMatch) {
        await handleShareCover(req, res, decodeURIComponent(shareCoverMatch[1]));
        return;
      }

      const shareMatch = url.pathname.match(/^\/api\/shares\/([^/]+)$/);
      if (req.method === 'GET' && shareMatch) {
        handleGetShare(req, res, decodeURIComponent(shareMatch[1]));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/exports') {
        await handleCreateExport(req, res);
        return;
      }

      const exportMatch = url.pathname.match(/^\/api\/exports\/([^/]+)\.(png|pdf)$/);
      if (req.method === 'GET' && exportMatch) {
        handleDownloadExport(req, res, exportMatch[1], exportMatch[2]);
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === 'GET' && taskMatch) {
        const view = store.toView(decodeURIComponent(taskMatch[1]));
        if (!view) {
          sendError(res, 404, 'task-not-found', '任务不存在，请重新生成');
          return;
        }
        sendJson(res, 200, view);
        return;
      }

      sendError(res, 404, 'not-found', '接口不存在');
    } catch (error) {
      logger.warn('request_failed', {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendError(res, 500, 'internal', '服务异常，请稍后重试');
    }
  });
}
