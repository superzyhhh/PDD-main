import type { CompiledBeadColor } from './vendor/pindo-engine/types';
import mardPalette from './data/mard.json';

/**
 * 基础档 221 = A–H 八个系列（206 色）+ M 系列（15 色）。
 * 进阶档 291 = 基础档再加 P/Q/R/T/Y/ZG 系列（70 色）。
 * 色卡数据来源与授权见 ADR-0002：license=community，非官方授权数据。
 * 2026-11-06 对照 pindou.shanwchuan.cn/color-charts.html：291 个色号完全一致，
 * 221 档集合完全一致，290/291 个 HEX 一致；仅 R11 蓝色通道差 1（该站 #FFEBFA，本地 #FFEBFB）。
 */
const BASIC_SERIES = /^(?:[A-H]|M)\d{2}$/;

const EXPECTED_BASIC_COUNT = 221;

const ALL_COLORS = mardPalette as CompiledBeadColor[];
const BASIC_COLORS = ALL_COLORS.filter((color) => BASIC_SERIES.test(color.code));

if (BASIC_COLORS.length !== EXPECTED_BASIC_COUNT) {
  throw new Error(`MARD 基础档应包含 ${EXPECTED_BASIC_COUNT} 色，当前数据为 ${BASIC_COLORS.length} 色`);
}

export function getBasicPalette(): CompiledBeadColor[] {
  return BASIC_COLORS;
}
