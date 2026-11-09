import type { CompiledBeadColor } from './vendor/pindo-engine/types';
import mardPalette from './data/mard.json';

/**
 * 基础档 221 = A–H 八个系列（206 色）+ M 系列（15 色）。
 * 进阶档 291 = 基础档再加 P/Q/R/T/Y/ZG 系列（70 色）。
 * 色卡数据来源与授权见 ADR-0002：license=community，非官方授权数据。
 * 2026-11-06 对照 pindou.shanwchuan.cn/color-charts.html：291 个色号完全一致，
 * 221 档集合完全一致，291 个 HEX 已全部对齐（R11 原为 #FFEBFB，已改为站点值 #FFEBFA）。
 */
const BASIC_SERIES = /^(?:[A-H]|M)\d{2}$/;

const ADVANCED_SERIES = /^(?:(?:[A-H]|M|P|Q|R|T|Y)\d{2}|ZG\d)$/;

const EXPECTED_BASIC_COUNT = 221;

const EXPECTED_ADVANCED_COUNT = 291;

const ALL_COLORS = mardPalette as CompiledBeadColor[];
const BASIC_COLORS = ALL_COLORS.filter((color) => BASIC_SERIES.test(color.code));
const ADVANCED_COLORS = ALL_COLORS.filter((color) => ADVANCED_SERIES.test(color.code));

if (BASIC_COLORS.length !== EXPECTED_BASIC_COUNT) {
  throw new Error(`MARD 基础档应包含 ${EXPECTED_BASIC_COUNT} 色，当前数据为 ${BASIC_COLORS.length} 色`);
}

if (ADVANCED_COLORS.length !== EXPECTED_ADVANCED_COUNT) {
  throw new Error(`MARD 进阶档应包含 ${EXPECTED_ADVANCED_COUNT} 色，当前数据为 ${ADVANCED_COLORS.length} 色`);
}

export function getBasicPalette(): CompiledBeadColor[] {
  return BASIC_COLORS;
}

export function getAdvancedPalette(): CompiledBeadColor[] {
  return ADVANCED_COLORS;
}
