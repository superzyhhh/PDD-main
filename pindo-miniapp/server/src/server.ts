import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseAnalyticsEvent } from './analytics';
import { ImageDecodeError, decodeImage, generateCandidates } from './generation';
import {
  ExportStore,
  FREE_DAILY_EXPORT_LIMIT,
  QuotaExceededError,
  exportKey,
  renderHdExport,
  type ExportFormat,
  type ExportRecord,
} from './exports';
import { consoleLogger, type Logger } from './logger';
import { MEMBERSHIP_PLANS, MembershipStore, PLAN_IDS, type PlanId } from './membership';
import type { Moderation } from './moderation';
import { getAdvancedPalette, getBasicPalette } from './palette';
import { PaymentUnavailableError, unconfiguredPaymentProvider, type PaymentProvider } from './payment';
import { renderTiledPrintExport } from './print';
import { createSessionService, type SessionService } from './session';
import { TaskStore } from './store';
import {
  PALETTE_TIERS,
  SIZE_TIERS,
  type Candidate,
  type PaletteTier,
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
  /** 测试注入时钟；缺省用系统时间。 */
  now?: () => Date;
  /** 291 进阶档的额外白名单（运营/测试用）；会员资格由服务端会员状态判定。 */
  isAdvancedPaletteAllowed?: (openId?: string) => boolean;
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

function contentKey(buffer: Buffer, sizeTier: string, paletteTier: string): string {
  return createHash('sha256').update(buffer).update(`|${sizeTier}|${paletteTier}`).digest('hex');
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

export function createServer(options: ServerOptions): Server {
  const moderation = options.moderation;
  const logger = options.logger ?? consoleLogger;
  const session = options.session ?? createSessionService();
  const store = new TaskStore();
  const exportStore = new ExportStore();
  const memberships = new MembershipStore();
  const now = options.now ?? (() => new Date());
  const payment = options.payment ?? unconfiguredPaymentProvider;
  /** 同一账号同一图纸的并发导出只渲染一次，避免重复扣次。 */
  const pendingExports = new Map<string, Promise<ExportRecord>>();
  const basicPalette = getBasicPalette();
  const advancedPalette = getAdvancedPalette();
  const extraAdvancedAllow = options.isAdvancedPaletteAllowed ?? (() => false);

  /** 291 档位以服务端会员状态为准，额外白名单只用于运营/测试。 */
  function isAdvancedPaletteAllowed(openId?: string): boolean {
    return extraAdvancedAllow(openId) || memberships.isMember(openId, now());
  }

  async function runTask(taskId: string, image: Buffer, sizeTier: SizeTier, paletteTier: PaletteTier): Promise<void> {
    store.markProcessing(taskId);
    try {
      const decoded = await decodeImage(image);
      const palette = paletteTier === 'advanced' ? advancedPalette : basicPalette;
      store.complete(taskId, generateCandidates(decoded, palette, { sizeTier, paletteTier }));
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

    const token = String(req.headers['x-session-token'] ?? '');
    const openId = token ? session.openIdFor(token) : undefined;
    if (paletteTier === 'advanced' && !isAdvancedPaletteAllowed(openId)) {
      sendError(res, 403, 'advanced-not-allowed', '291 进阶色卡仅对已开通会员开放');
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

    const key = contentKey(image, sizeTier, paletteTier);
    const reusable = store.findReusable(key);
    if (reusable) {
      sendJson(res, 202, { taskId: reusable.id, status: reusable.status });
      return;
    }

    let verdict: 'pass' | 'block' = 'pass';
    try {
      verdict = await moderation.check({
        buffer: image,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
      });
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
    const concurrent = store.findReusable(key);
    if (concurrent) {
      sendJson(res, 202, { taskId: concurrent.id, status: concurrent.status });
      return;
    }

    const task = store.create(key, openId);
    sendJson(res, 202, { taskId: task.id, status: task.status });
    setImmediate(() => void runTask(task.id, image, sizeTier, paletteTier));
  }

  async function handleCreateExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = String(req.headers['x-session-token'] ?? '');
    const openId = token ? session.openIdFor(token) : undefined;
    if (!openId) {
      sendError(res, 401, 'login-required', '请先登录再导出高清图纸');
      return;
    }
    // 会员无限导出；非会员按上海自然日计 1 次。额度一律由服务端判定。
    const quotaLimit = memberships.isMember(openId, now()) ? null : FREE_DAILY_EXPORT_LIMIT;

    let body: { taskId?: unknown; candidateId?: unknown; type?: unknown };
    try {
      const raw = await readBody(req, 4096);
      body = JSON.parse(raw.toString('utf8') || '{}') as {
        taskId?: unknown;
        candidateId?: unknown;
        type?: unknown;
      };
    } catch {
      sendError(res, 400, 'invalid-export', '导出参数不正确');
      return;
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
    const format: ExportFormat | undefined =
      body.type === undefined || body.type === 'hd'
        ? 'hd'
        : body.type === 'tiled'
          ? 'tiled'
          : undefined;
    if (!taskId || !candidateId || !format) {
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
    const candidate = view.candidates?.find((item) => item.id === candidateId);
    if (!candidate) {
      sendError(res, 400, 'invalid-export', '没有找到这张候选图纸');
      return;
    }
    const owner = store.ownerOf(taskId);
    if (owner && owner !== openId) {
      sendError(res, 403, 'export-forbidden', '无权导出该图纸');
      return;
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
