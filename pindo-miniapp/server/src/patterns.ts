import { randomUUID } from 'node:crypto';
import type { Candidate, PatternSummary } from './types';

/** 每个账号最多保留的图纸数；超出后淘汰最早保存的一张。 */
export const MAX_PATTERNS = 50;

export interface PatternRecord {
  id: string;
  openId: string;
  taskId: string;
  candidate: Candidate;
  /** 保存顺序，保证同一毫秒内的排序与淘汰结果稳定。 */
  seq: number;
  createdAt: number;
}

export interface SavePatternResult {
  pattern: PatternRecord;
  /** 本次保存因超出上限而淘汰的图纸数。 */
  evictedCount: number;
}

/** 按账号保存的图纸快照；同一任务只保留一条，换候选时原地更新。 */
export class PatternStore {
  private readonly byUser = new Map<string, Map<string, PatternRecord>>();
  private seq = 0;

  save(openId: string, taskId: string, candidate: Candidate): SavePatternResult {
    const bucket = this.bucketOf(openId);
    const existing = bucket.get(taskId);
    if (existing) {
      existing.candidate = candidate;
      return { pattern: existing, evictedCount: 0 };
    }

    const record: PatternRecord = {
      id: randomUUID(),
      openId,
      taskId,
      candidate,
      seq: (this.seq += 1),
      createdAt: Date.now(),
    };
    bucket.set(taskId, record);
    return { pattern: record, evictedCount: this.evictOverflow(openId) };
  }

  /** 最近保存的在前。 */
  list(openId: string): PatternRecord[] {
    return [...this.bucketOf(openId).values()].sort((a, b) => b.seq - a.seq);
  }

  get(openId: string, id: string): PatternRecord | undefined {
    for (const record of this.bucketOf(openId).values()) {
      if (record.id === id) return record;
    }
    return undefined;
  }

  remove(openId: string, id: string): boolean {
    const bucket = this.bucketOf(openId);
    for (const [taskId, record] of bucket) {
      if (record.id === id) {
        bucket.delete(taskId);
        return true;
      }
    }
    return false;
  }

  private bucketOf(openId: string): Map<string, PatternRecord> {
    let bucket = this.byUser.get(openId);
    if (!bucket) {
      bucket = new Map<string, PatternRecord>();
      this.byUser.set(openId, bucket);
    }
    return bucket;
  }

  private evictOverflow(openId: string): number {
    const bucket = this.bucketOf(openId);
    let evicted = 0;
    while (bucket.size > MAX_PATTERNS) {
      const oldest = [...bucket.values()].sort((a, b) => a.seq - b.seq)[0];
      if (!oldest) break;
      bucket.delete(oldest.taskId);
      evicted += 1;
    }
    return evicted;
  }
}

export function patternSummary(record: PatternRecord): PatternSummary {
  return {
    id: record.id,
    taskId: record.taskId,
    candidateId: record.candidate.id,
    width: record.candidate.width,
    height: record.candidate.height,
    boardCount: record.candidate.boardCount,
    colorCodeCount: record.candidate.colors.length,
    createdAt: new Date(record.createdAt).toISOString(),
  };
}
