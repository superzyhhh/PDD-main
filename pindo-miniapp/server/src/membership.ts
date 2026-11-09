import { randomUUID } from 'node:crypto';

export const PLAN_IDS = ['monthly', 'yearly'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export interface MembershipPlan {
  id: PlanId;
  label: string;
  priceFen: number;
  /** 客户端直接展示的价格文案，避免端侧做浮点运算。 */
  priceLabel: string;
  durationDays: number;
}

export const MEMBERSHIP_PLANS: Record<PlanId, MembershipPlan> = {
  monthly: { id: 'monthly', label: '月卡', priceFen: 990, priceLabel: '9.9 元/月', durationDays: 30 },
  yearly: { id: 'yearly', label: '年卡', priceFen: 6900, priceLabel: '69 元/年', durationDays: 365 },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ORDERS = 500;
/** 未支付订单的保留时长；超过后视为用户放弃，避免订单表无界增长。 */
const PENDING_ORDER_TTL_MS = 2 * 60 * 60 * 1000;

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'failed';

export interface MembershipOrder {
  id: string;
  openId: string;
  plan: PlanId;
  amountFen: number;
  status: OrderStatus;
  createdAt: number;
  paidAt?: number;
  transactionId?: string;
}

export interface MembershipRecord {
  openId: string;
  plan: PlanId;
  orderId: string;
  startedAt: number;
  expiresAt: number;
}

export interface MembershipStatus {
  active: boolean;
  plan: PlanId;
  expiresAt: number;
}

/** 会员状态与订单的唯一权威；额度、291 档位等权益都以这里为准。 */
export class MembershipStore {
  private readonly orders = new Map<string, MembershipOrder>();
  private readonly memberships = new Map<string, MembershipRecord>();

  createOrder(openId: string, plan: PlanId, now: Date): MembershipOrder {
    this.expirePending(now);
    const order: MembershipOrder = {
      id: randomUUID(),
      openId,
      plan,
      amountFen: MEMBERSHIP_PLANS[plan].priceFen,
      status: 'pending',
      createdAt: now.getTime(),
    };
    this.orders.set(order.id, order);
    this.evictIfNeeded();
    return order;
  }

  orderOf(id: string): MembershipOrder | undefined {
    return this.orders.get(id);
  }

  /** 关闭未支付订单；已支付订单不受影响，避免回调乱序抹掉已授予的权益。 */
  closeOrder(id: string, status: 'cancelled' | 'failed'): boolean {
    const order = this.orders.get(id);
    if (!order || order.status !== 'pending') return false;
    order.status = status;
    return true;
  }

  /**
   * 支付成功回调。同一订单重复通知只授予一次；未支付订单可正常授予，
   * 已取消/失败的订单不再授予，防止「取消后又变会员」。
   */
  confirmPaid(id: string, transactionId: string, now: Date): boolean {
    const order = this.orders.get(id);
    if (!order || order.status !== 'pending') return false;
    order.status = 'paid';
    order.paidAt = now.getTime();
    order.transactionId = transactionId;

    const current = this.memberships.get(order.openId);
    const base = current && current.expiresAt > now.getTime() ? current.expiresAt : now.getTime();
    this.memberships.set(order.openId, {
      openId: order.openId,
      plan: order.plan,
      orderId: order.id,
      startedAt: now.getTime(),
      expiresAt: base + MEMBERSHIP_PLANS[order.plan].durationDays * DAY_MS,
    });
    return true;
  }

  /** 到期后仍返回记录（active=false），让客户端能说明权益已收回而不是丢失状态。 */
  statusOf(openId: string, now: Date): MembershipStatus | undefined {
    const record = this.memberships.get(openId);
    if (!record) return undefined;
    return { active: record.expiresAt > now.getTime(), plan: record.plan, expiresAt: record.expiresAt };
  }

  isMember(openId: string | undefined, now: Date): boolean {
    if (!openId) return false;
    return this.statusOf(openId, now)?.active === true;
  }

  private expirePending(now: Date): void {
    const cutoff = now.getTime() - PENDING_ORDER_TTL_MS;
    for (const order of [...this.orders.values()]) {
      if (order.status === 'pending' && order.createdAt <= cutoff) this.orders.delete(order.id);
    }
  }

  private evictIfNeeded(): void {
    if (this.orders.size <= MAX_ORDERS) return;
    const finished = [...this.orders.values()]
      .filter((order) => order.status !== 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    const victim = finished ?? [...this.orders.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (victim) this.orders.delete(victim.id);
  }
}
