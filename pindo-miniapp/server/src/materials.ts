import { BASIC_SERIES, seriesOfCode } from './advanced-settings';
import type { CandidateColor, CandidateMaterial, CandidateUsage, PaletteTier } from './types';

/** MARD 拼豆按每包 1000 颗售卖；材料包清单按整包向上取整。 */
export const BEADS_PER_PACKAGE = 1000;

/** 把逐色号用量换算成材料包清单；291 档额外标出 221 套装之外的色号。 */
export function buildMaterials(
  usage: CandidateUsage[],
  colors: CandidateColor[],
  paletteTier: PaletteTier,
): CandidateMaterial[] {
  const colorsByCode = new Map(colors.map((color) => [color.code, color]));
  const basicSeries: readonly string[] = BASIC_SERIES;
  return usage.map(({ code, count }) => {
    const color = colorsByCode.get(code);
    return {
      code,
      name: color ? color.name : '',
      hex: color ? color.hex : '',
      count,
      packages: Math.ceil(count / BEADS_PER_PACKAGE),
      extraPurchase: paletteTier === 'advanced' && !basicSeries.includes(seriesOfCode(code)),
    };
  });
}
