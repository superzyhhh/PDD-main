import type { CandidateColor, CandidateMaterial, CandidateUsage } from './types';

/** MARD 拼豆按每包 1000 颗售卖；材料包清单按整包向上取整。 */
export const BEADS_PER_PACKAGE = 1000;

/** 把逐色号用量换算成材料包清单。 */
export function buildMaterials(
  usage: CandidateUsage[],
  colors: CandidateColor[],
): CandidateMaterial[] {
  const colorsByCode = new Map(colors.map((color) => [color.code, color]));
  return usage.map(({ code, count }) => {
    const color = colorsByCode.get(code);
    return {
      code,
      name: color ? color.name : '',
      hex: color ? color.hex : '',
      count,
      packages: Math.ceil(count / BEADS_PER_PACKAGE),
    };
  });
}
