import { STYLE_IDS, type StyleId } from './style';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 验证期看板只保留最近的埋点，避免进程内数组无界增长。 */
const MAX_METRIC_RECORDS = 2000;
/** 「7 日内二次生成」的观察窗口。 */
export const RETENTION_WINDOW_DAYS = 7;

/** 渠道只接受短小写标识，其余一律归为直接访问，避免脏值污染统计。 */
const CHANNEL_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const DEFAULT_CHANNEL = 'direct';

export function sanitizeChannel(raw: string | undefined): string {
  return raw && CHANNEL_PATTERN.test(raw) ? raw : DEFAULT_CHANNEL;
}

export const BLIND_TEST_WINNERS = ['ours', 'competitor', 'tie'] as const;

export type BlindTestWinner = (typeof BLIND_TEST_WINNERS)[number];

export interface BlindTestInput {
  testerId: string;
  group: string;
  competitor: string;
  winner: BlindTestWinner;
}

interface BlindTestRecord extends BlindTestInput {
  at: number;
}

export interface BlindTestSummaryEntry {
  competitor: string;
  wins: number;
  losses: number;
  ties: number;
  /** 平票不计入分母；没有胜负记录时为 null。 */
  winRate: number | null;
}

export interface BlindTestSummary {
  total: number;
  /** 去重后的测试者人数与组数，用于核对 20 人 × 5 组的录入完整性。 */
  testers: number;
  groups: number;
  competitors: BlindTestSummaryEntry[];
}

export interface MetricRange {
  /** 含端点，毫秒时间戳。 */
  from?: number;
  to?: number;
}

export function inTimeRange(at: number, range: MetricRange): boolean {
  return (range.from === undefined || at >= range.from) && (range.to === undefined || at <= range.to);
}

export interface MetricFilter extends MetricRange {
  channel?: string;
}

export interface StyleSummaryEntry {
  style: StyleId;
  generation: { tasks: number; users: number };
  firstAcceptance: { count: number; rate: number | null };
  /**
   * 风格转换失败次数与失败率：免费风格的本地算法失败与高级风格的外部依赖失败都计入，
   * 风格转换结果不符合内容规范不计入。分母为该风格的生成任务数加风格转换失败数。
   */
  styleConversionFailure: { count: number; rate: number | null };
}

export interface MetricsSummary {
  generation: { tasks: number; users: number };
  firstAcceptance: { count: number; rate: number | null };
  funnel: {
    generatedUsers: number;
    quotaExhaustedUsers: number;
    paidUsers: number;
    quotaToPaidUsers: number;
    quotaToPaidRate: number | null;
  };
  retention: {
    windowDays: number;
    eligibleUsers: number;
    repeatUsers: number;
    rate: number | null;
  };
  blindTests: BlindTestSummary;
  /** 既有时间与渠道过滤下的按风格拆分。 */
  byStyle: StyleSummaryEntry[];
}

interface TaskEvent {
  taskId: string;
  openId?: string;
  channel: string;
  style: StyleId;
  at: number;
}

interface UserEvent {
  openId: string;
  at: number;
}

/** 验证看板的唯一数据源：生成、首图接受、额度耗尽、会员开通与盲测记录。 */
export class MetricsStore {
  private readonly generations: TaskEvent[] = [];
  private readonly acceptances: TaskEvent[] = [];
  private readonly styleConversionFailures: TaskEvent[] = [];
  private readonly quotaExhausted: UserEvent[] = [];
  private readonly activations: UserEvent[] = [];
  private readonly blindTests = new Map<string, BlindTestRecord>();

  /** 同一任务完成只记一次；缓存复用不会重复计入生成量。 */
  recordGeneration(event: TaskEvent): void {
    this.recordOnce(this.generations, event);
  }

  /** 同一任务的首图接受只记一次，客户端重试上报不会把接受率刷过 100%。 */
  recordAcceptance(event: TaskEvent): void {
    this.recordOnce(this.acceptances, event);
  }

  /** 风格转换失败同一任务只计一次；成功生成与内容不合规都不计入失败口径。 */
  recordStyleConversionFailure(event: TaskEvent): void {
    this.recordOnce(this.styleConversionFailures, event);
  }

  recordQuotaExhausted(openId: string, at: number): void {
    this.push(this.quotaExhausted, { openId, at });
  }

  recordMembershipActivated(openId: string, at: number): void {
    this.push(this.activations, { openId, at });
  }

  /** 同一测试者对同一组同一对比项重复录入按覆盖处理。 */
  recordBlindTest(input: BlindTestInput, at: number): void {
    this.blindTests.set(blindKey(input), { ...input, at });
    while (this.blindTests.size > MAX_METRIC_RECORDS) {
      const oldest = this.blindTests.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.blindTests.delete(oldest);
    }
  }

  blindTestSummary(): BlindTestSummary {
    const buckets = new Map<string, { wins: number; losses: number; ties: number }>();
    const testers = new Set<string>();
    const groups = new Set<string>();
    for (const record of this.blindTests.values()) {
      testers.add(record.testerId);
      groups.add(record.group);
      const bucket = buckets.get(record.competitor) ?? { wins: 0, losses: 0, ties: 0 };
      if (record.winner === 'ours') bucket.wins += 1;
      else if (record.winner === 'competitor') bucket.losses += 1;
      else bucket.ties += 1;
      buckets.set(record.competitor, bucket);
    }
    const competitors = [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([competitor, bucket]) => {
        const decided = bucket.wins + bucket.losses;
        return {
          competitor,
          ...bucket,
          winRate: decided === 0 ? null : bucket.wins / decided,
        };
      });
    return { total: this.blindTests.size, testers: testers.size, groups: groups.size, competitors };
  }

  /** 按时间与渠道汇总；漏斗各步都只统计同一批生成用户。 */
  summary(filter: MetricFilter = {}): MetricsSummary {
    const inRange = (at: number): boolean => inTimeRange(at, filter);
    const inChannel = (channel: string): boolean =>
      filter.channel === undefined || channel === filter.channel;

    const generations = this.generations.filter(
      (item) => inRange(item.at) && inChannel(item.channel),
    );
    const generationIds = new Set(generations.map((item) => item.taskId));
    const acceptanceIds = new Set(
      this.acceptances
        .filter((item) => inRange(item.at) && inChannel(item.channel))
        .map((item) => item.taskId),
    );
    const acceptedCount = [...generationIds].filter((id) => acceptanceIds.has(id)).length;
    const failures = this.styleConversionFailures.filter(
      (item) => inRange(item.at) && inChannel(item.channel),
    );

    // 按风格拆分叠加在时间与渠道过滤之上，不改变原有漏斗与留存口径。
    const byStyle: StyleSummaryEntry[] = STYLE_IDS.map((style) => {
      const styleGenerations = generations.filter((item) => item.style === style);
      const styleTaskIds = new Set(styleGenerations.map((item) => item.taskId));
      const styleAccepted = [...styleTaskIds].filter((id) => acceptanceIds.has(id)).length;
      const styleUsers = new Set<string>();
      for (const item of styleGenerations) if (item.openId) styleUsers.add(item.openId);
      const styleConversionFailures = failures.filter((item) => item.style === style).length;
      const attempts = styleGenerations.length + styleConversionFailures;
      return {
        style,
        generation: { tasks: styleGenerations.length, users: styleUsers.size },
        firstAcceptance: {
          count: styleAccepted,
          rate: styleGenerations.length === 0 ? null : styleAccepted / styleGenerations.length,
        },
        styleConversionFailure: {
          count: styleConversionFailures,
          rate: attempts === 0 ? null : styleConversionFailures / attempts,
        },
      };
    });

    const generatedUsers = new Set<string>();
    for (const item of generations) if (item.openId) generatedUsers.add(item.openId);

    const quotaInRange = this.quotaExhausted.filter((item) => inRange(item.at));
    const quotaExhaustedUsers = new Set(
      quotaInRange.map((item) => item.openId).filter((openId) => generatedUsers.has(openId)),
    );

    const activationsInRange = this.activations.filter((item) => inRange(item.at));
    const paidUsers = new Set(
      activationsInRange.map((item) => item.openId).filter((openId) => generatedUsers.has(openId)),
    );

    const earliestQuota = new Map<string, number>();
    for (const item of quotaInRange) {
      if (!generatedUsers.has(item.openId)) continue;
      const current = earliestQuota.get(item.openId);
      if (current === undefined || item.at < current) earliestQuota.set(item.openId, item.at);
    }
    const quotaToPaidUsers = new Set<string>();
    for (const item of activationsInRange) {
      const firstQuotaAt = earliestQuota.get(item.openId);
      if (firstQuotaAt !== undefined && item.at >= firstQuotaAt) quotaToPaidUsers.add(item.openId);
    }

    // 复购以「首次生成」为锚点：只有首次生成落在查询窗口内的用户才具备观察资格。
    const channelGenerations = this.generations.filter(
      (item) => item.openId && inChannel(item.channel),
    );
    const firstGeneration = new Map<string, number>();
    for (const item of channelGenerations) {
      const openId = item.openId as string;
      const current = firstGeneration.get(openId);
      if (current === undefined || item.at < current) firstGeneration.set(openId, item.at);
    }
    let eligibleUsers = 0;
    let repeatUsers = 0;
    for (const [openId, firstAt] of firstGeneration) {
      if (!inRange(firstAt)) continue;
      eligibleUsers += 1;
      const repeat = channelGenerations.some(
        (item) =>
          item.openId === openId &&
          item.at > firstAt &&
          item.at <= firstAt + RETENTION_WINDOW_DAYS * DAY_MS,
      );
      if (repeat) repeatUsers += 1;
    }

    return {
      generation: { tasks: generations.length, users: generatedUsers.size },
      firstAcceptance: {
        count: acceptedCount,
        rate: generations.length === 0 ? null : acceptedCount / generations.length,
      },
      funnel: {
        generatedUsers: generatedUsers.size,
        quotaExhaustedUsers: quotaExhaustedUsers.size,
        paidUsers: paidUsers.size,
        quotaToPaidUsers: quotaToPaidUsers.size,
        quotaToPaidRate:
          quotaExhaustedUsers.size === 0 ? null : quotaToPaidUsers.size / quotaExhaustedUsers.size,
      },
      retention: {
        windowDays: RETENTION_WINDOW_DAYS,
        eligibleUsers,
        repeatUsers,
        rate: eligibleUsers === 0 ? null : repeatUsers / eligibleUsers,
      },
      blindTests: this.blindTestSummary(),
      byStyle,
    };
  }

  private recordOnce(list: TaskEvent[], event: TaskEvent): void {
    if (list.some((item) => item.taskId === event.taskId)) return;
    this.push(list, event);
  }

  private push<T>(list: T[], item: T): void {
    list.push(item);
    while (list.length > MAX_METRIC_RECORDS) list.shift();
  }
}

function blindKey(input: BlindTestInput): string {
  return `${input.testerId}\u0000${input.group}\u0000${input.competitor}`;
}
