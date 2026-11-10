import { CANDIDATE_IDS, type CandidateId } from './types';

/**
 * 埋点事件契约（工单 02）。看板按 `audit` 日志消费：
 * `candidate_selected` —— 用户选中任一候选，字段 taskId / candidateId / index；
 * `first_pattern_accepted` —— 用户选中第一张（保主体细节），字段同上，index 恒为 0。
 * 时间戳 `at` 由服务端补写，客户端不参与，避免设备时钟偏差。
 */
export const ANALYTICS_EVENT_NAMES = ['candidate_selected', 'first_pattern_accepted'] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  taskId: string;
  candidateId: CandidateId;
  index: number;
}

/** 校验客户端上报；非法输入返回 undefined，由调用方回 400。 */
export function parseAnalyticsEvent(input: unknown): AnalyticsEvent | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { name, taskId, candidateId, index } = input as Record<string, unknown>;

  if (!ANALYTICS_EVENT_NAMES.includes(name as AnalyticsEventName)) return undefined;
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 64) return undefined;
  if (!CANDIDATE_IDS.includes(candidateId as CandidateId)) return undefined;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > CANDIDATE_IDS.length - 1) {
    return undefined;
  }
  // 首图接受只由「选中第一张」触发。
  if (name === 'first_pattern_accepted' && (index !== 0 || candidateId !== 'detail')) return undefined;

  return {
    name: name as AnalyticsEventName,
    taskId,
    candidateId: candidateId as CandidateId,
    index: index as number,
  };
}
