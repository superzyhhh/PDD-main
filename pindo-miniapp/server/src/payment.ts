import type { IncomingHttpHeaders } from 'node:http';
import type { PlanId } from './membership';

export class PaymentUnavailableError extends Error {}

export interface PaymentOrderInput {
  orderId: string;
  openId: string;
  plan: PlanId;
  amountFen: number;
  description: string;
}

/** 直接交给 wx.requestPayment 的参数（字段由真实支付渠道决定）。 */
export type PaymentParams = Record<string, unknown>;

export type PaymentOutcome = 'success' | 'cancelled' | 'failed';

export interface PaymentNotification {
  orderId: string;
  outcome: PaymentOutcome;
  transactionId?: string;
}

/**
 * 支付渠道边界：微信支付需要商户号 / API v3 密钥 / 证书，未配置时保持 unavailable，
 * 客户端不展示价格与购买入口，服务端也绝不放行「假支付成功」。
 */
export interface PaymentProvider {
  readonly available: boolean;
  createPayment(input: PaymentOrderInput): Promise<PaymentParams>;
  /** 校验支付平台回调并归一化为支付事实；签名或格式不合法时返回 undefined。 */
  parseNotification(raw: Buffer, headers: IncomingHttpHeaders): Promise<PaymentNotification | undefined>;
}

export const unconfiguredPaymentProvider: PaymentProvider = {
  available: false,
  async createPayment() {
    throw new PaymentUnavailableError('支付渠道未配置');
  },
  async parseNotification() {
    return undefined;
  },
};

/**
 * 本地/测试用的支付沙箱：只由调用方显式注入，生产入口禁止启用。
 * 它模拟「下单返回参数」与「渠道回调」，让会员状态机可在不接商户号的情况下验证。
 */
export function createSandboxPaymentProvider(): PaymentProvider {
  return {
    available: true,
    async createPayment(input) {
      return { sandbox: true, orderId: input.orderId, amountFen: input.amountFen };
    },
    async parseNotification(raw) {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return undefined;
      }
      if (!payload || typeof payload !== 'object') return undefined;
      const body = payload as { orderId?: unknown; outcome?: unknown; transactionId?: unknown };
      if (typeof body.orderId !== 'string' || body.orderId.length === 0) return undefined;
      if (body.outcome !== 'success' && body.outcome !== 'cancelled' && body.outcome !== 'failed') return undefined;
      const transactionId =
        typeof body.transactionId === 'string' && body.transactionId.length > 0
          ? body.transactionId
          : `sandbox-${body.orderId}`;
      return { orderId: body.orderId, outcome: body.outcome, transactionId };
    },
  };
}
