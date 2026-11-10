import { randomUUID } from 'node:crypto';
import type { AdvancedSettings } from './advanced-settings';
import type { StyleId } from './style';
import type { Candidate, SizeTier } from './types';

/** 失败样本只保留最近 50 条，避免长期占用内存。 */
export const MAX_FAILURE_SAMPLES = 50;

export interface FailureSampleInput {
  taskId: string;
  openId?: string;
  sizeTier: SizeTier;
  settings: AdvancedSettings;
  style: StyleId;
  candidates: Candidate[];
  /** 用户上传的原图，用于运营回看。 */
  image: Buffer;
  imageContentType: string;
}

export interface FailureSample extends FailureSampleInput {
  id: string;
  createdAt: number;
}

/** 三候选全部不满意时留档：原图、参数与三候选，供后台按时间查询。 */
export class FailureSampleStore {
  private readonly samples: FailureSample[] = [];

  add(input: FailureSampleInput, at = Date.now()): FailureSample {
    // 同一任务重复进入不满意只留档第一份，避免重复反馈把样本列表刷满。
    const existing = this.samples.find((sample) => sample.taskId === input.taskId);
    if (existing) return existing;
    const sample: FailureSample = { id: randomUUID(), createdAt: at, ...input };
    this.samples.push(sample);
    while (this.samples.length > MAX_FAILURE_SAMPLES) this.samples.shift();
    return sample;
  }

  /** 最近上报的在前。 */
  list(limit: number): FailureSample[] {
    return this.samples.slice(-limit).reverse();
  }

  get(id: string): FailureSample | undefined {
    return this.samples.find((sample) => sample.id === id);
  }
}
