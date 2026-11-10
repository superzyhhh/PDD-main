import { describe, expect, it } from 'vitest';
import { BEADS_PER_PACKAGE, buildMaterials } from '../src/materials';
import type { CandidateColor, CandidateUsage } from '../src/types';

const colors: CandidateColor[] = [
  { code: 'A01', name: '白', hex: '#FFFFFF' },
  { code: 'B02', name: '红', hex: '#D93A3A' },
  { code: 'M01', name: '灰', hex: '#999999' },
  { code: 'H08', name: '蓝', hex: '#3A6FD9' },
];

describe('材料包换算', () => {
  it('每包按 1000 颗向上取整，逐色号保留实际用量', () => {
    const usage: CandidateUsage[] = [
      { code: 'A01', count: 1 },
      { code: 'B02', count: 999 },
      { code: 'M01', count: 1000 },
      { code: 'H08', count: 2501 },
    ];

    const materials = buildMaterials(usage, colors);

    expect(BEADS_PER_PACKAGE).toBe(1000);
    expect(materials.map((item) => item.code)).toEqual(['A01', 'B02', 'M01', 'H08']);
    expect(materials.map((item) => item.count)).toEqual([1, 999, 1000, 2501]);
    expect(materials.map((item) => item.packages)).toEqual([1, 1, 1, 3]);
    expect(materials[0]).toMatchObject({ name: '白', hex: '#FFFFFF' });
  });

  it('免费版材料清单不再包含额外采购字段', () => {
    const usage: CandidateUsage[] = [{ code: 'A01', count: 10 }];

    const materials = buildMaterials(usage, colors);
    expect(materials[0]).not.toHaveProperty('extraPurchase');
  });
});
