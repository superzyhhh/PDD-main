const api = require('../../utils/api');
const config = require('../../utils/config');
const { labelForCandidate } = require('../../utils/candidate-labels');

const THUMB_WIDTH = 145;
const DETAIL_MAX_PX = 812;
const MAX_CELL = 28;
const MIN_CELL_FOR_CODES = 14;
const PAGE_H_PADDING_RPX = 48;
const PATTERN_LIMIT = 50;
const DEFAULT_PICK_HINT = '三个候选，选一张你更愿意照着拼的';
const REOPEN_HINT = '已从「我的图纸」打开，可直接导出';

const BASIC_SERIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'];
const ADVANCED_SERIES = ['P', 'Q', 'R', 'T', 'Y', 'ZG'];

const DEFAULT_ADVANCED_SETTINGS = {
  dithering: 'auto',
  background: 'auto',
  maxColors: 'auto',
  downscale: 'auto',
  series: [],
};

const SETTING_LABELS = {
  dithering: {
    auto: '自动抖动',
    none: '无抖动',
    'floyd-steinberg': 'Floyd–Steinberg 抖动',
  },
  background: { auto: '自动裁背景', keep: '保留整图' },
  downscale: {
    auto: '自动降采样',
    average: '平均降采样',
    'edge-aware': '边缘感知降采样',
    dominant: '主色降采样',
  },
};

Page({
  data: {
    stage: 'idle', // idle | uploading | processing | preview | error | dissatisfied
    statusText: '',
    message: '',
    canRetry: false,
    taskId: '',
    patternId: '',
    previewHint: DEFAULT_PICK_HINT,
    hasImage: false,
    sizeTier: 'small',
    paletteTier: 'basic',
    advancedOpen: false,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    advancedDirty: false,
    appliedSettings: '',
    sampleReporting: false,
    sampleReported: false,
    maxColorsId: 'auto',
    ditheringOptions: [
      { id: 'auto', label: '自动' },
      { id: 'none', label: '无抖动' },
      { id: 'floyd-steinberg', label: 'Floyd–Steinberg' },
    ],
    backgroundOptions: [
      { id: 'auto', label: '自动裁背景' },
      { id: 'keep', label: '保留整图' },
    ],
    downscaleOptions: [
      { id: 'auto', label: '自动' },
      { id: 'average', label: '平均' },
      { id: 'edge-aware', label: '边缘感知' },
      { id: 'dominant', label: '主色' },
    ],
    maxColorsOptions: [
      { id: 'auto', label: '自动' },
      { id: '16', label: '16 色' },
      { id: '24', label: '24 色' },
      { id: '32', label: '32 色' },
      { id: '48', label: '48 色' },
    ],
    seriesOptions: seriesOptionsFor([], 'basic'),
    sizeOptions: [
      { id: 'small', label: '小 29×29' },
      { id: 'medium', label: '中 58×58' },
      { id: 'large', label: '大 87×87' },
    ],
    paletteOptions: [
      { id: 'basic', label: 'MARD 221' },
      { id: 'advanced', label: 'MARD 291' },
    ],
    candidates: [],
    selectedIndex: -1,
    candidate: null,
    canvasSize: 0,
    thumbSize: 0,
    exporting: false,
    exportingType: '',
  },

  onUnload() {
    this.cancelPoll();
  },

  /** 从「我的图纸」选了一张后返回本页：取快照并直接进入可导出的预览。 */
  onShow() {
    const pending = getApp().globalData.pendingPattern;
    if (!pending || !pending.patternId) return;
    getApp().globalData.pendingPattern = null;
    this.openSavedPattern(pending.patternId);
  },

  openPatterns() {
    wx.navigateTo({ url: '/pages/patterns/patterns' });
  },

  /** 用服务端保存的快照重新打开一张旧图纸；导出走 patternId，缓存命中不重复扣次。 */
  async openSavedPattern(patternId) {
    this.cancelPoll();
    this.setData({
      stage: 'processing',
      statusText: '正在打开图纸',
      message: '',
      canRetry: false,
      hasImage: false,
      advancedDirty: false,
      appliedSettings: '',
      candidates: [],
      selectedIndex: -1,
      candidate: null,
      canvasSize: 0,
      thumbSize: 0,
    });
    try {
      const result = await api.getPattern(patternId);
      const saved = result.pattern && result.pattern.candidate;
      if (!saved) throw new api.ApiError('图纸不存在或已删除', 'unknown');
      const labeled = {
        ...saved,
        label: labelForCandidate(saved.id),
      };
      const thumbCell = Math.max(1, Math.floor(THUMB_WIDTH / labeled.width));
      const cell = detailCell(labeled);
      this.setData({
        stage: 'preview',
        taskId: result.pattern.taskId || '',
        patternId,
        previewHint: REOPEN_HINT,
        candidates: [labeled],
        selectedIndex: 0,
        candidate: labeled,
        canvasSize: labeled.width * cell,
        thumbSize: labeled.width * thumbCell,
      });
      wx.nextTick(() => {
        this.paint('#thumb-0', labeled, thumbCell, false);
        this.paint('#pattern', labeled, cell, true);
      });
    } catch (error) {
      this.showError(error.message, false);
    }
  },

  selectSize(event) {
    this.setData({ sizeTier: event.currentTarget.dataset.id });
  },

  selectPalette(event) {
    const paletteTier = event.currentTarget.dataset.id;
    const advanced = { ...this.data.advanced };
    let trimmed = false;
    if (paletteTier === 'basic') {
      const kept = advanced.series.filter((code) => BASIC_SERIES.includes(code));
      trimmed = kept.length !== advanced.series.length;
      advanced.series = kept;
    }
    const update = {
      paletteTier,
      advanced,
      seriesOptions: seriesOptionsFor(advanced.series, paletteTier),
    };
    if (trimmed) {
      update.advancedDirty = true;
      update.appliedSettings = '';
    }
    this.setData(update);
    if (trimmed) wx.showToast({ title: '已移除进阶系列色', icon: 'none' });
  },

  toggleAdvanced() {
    this.setData({ advancedOpen: !this.data.advancedOpen });
  },

  selectAdvancedOption(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.currentTarget.dataset.value;
    if (!field || !value) return;
    if (field === 'maxColors') {
      const maxColors = value === 'auto' ? 'auto' : Number(value);
      this.applyAdvancedChange({ maxColors }, String(maxColors));
      return;
    }
    this.applyAdvancedChange({ [field]: value });
  },

  toggleSeries(event) {
    const code = event.currentTarget.dataset.code;
    if (code === undefined) return;
    const series =
      code === ''
        ? []
        : this.data.advanced.series.includes(code)
          ? this.data.advanced.series.filter((item) => item !== code)
          : [...this.data.advanced.series, code];
    this.applyAdvancedChange({ series });
  },

  /** 改动立即标脏：下一次生成才生效，预览页给出重新生成入口。 */
  applyAdvancedChange(patch, maxColorsId) {
    const advanced = { ...this.data.advanced, ...patch };
    this.setData({
      advanced,
      advancedDirty: true,
      appliedSettings: '',
      maxColorsId: maxColorsId === undefined ? String(advanced.maxColors) : maxColorsId,
      seriesOptions: seriesOptionsFor(advanced.series, this.data.paletteTier),
    });
  },

  regenerate() {
    if (!this.imageBuffer) {
      wx.showToast({ title: '请先选择一张图片', icon: 'none' });
      return;
    }
    this.startGenerate();
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        if (file.size > config.MAX_IMAGE_BYTES) {
          this.showError('图片太大，请换一张小于 10MB 的图片', false);
          return;
        }
        wx.getFileSystemManager().readFile({
          filePath: file.tempFilePath,
          success: (result) => {
            this.imageBuffer = result.data;
            this.imagePath = file.tempFilePath;
            this.imageContentType = contentTypeForPath(file.tempFilePath);
            this.startGenerate();
          },
          fail: () => this.showError('读取图片失败，请换一张图', false),
        });
      },
      fail: (err) => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        this.showError('无法打开相册，请重试', true);
      },
    });
  },

  retry() {
    if (this.imageBuffer) this.startGenerate();
    else this.chooseImage();
  },

  async startGenerate() {
    this.cancelPoll();
    this.reportedSelections = {};
    this.reportingSelections = {};
    this.setData({
      stage: 'uploading',
      statusText: '正在上传图片',
      message: '',
      canRetry: false,
      hasImage: true,
      patternId: '',
      previewHint: DEFAULT_PICK_HINT,
      advancedDirty: false,
      appliedSettings: '',
      sampleReporting: false,
      sampleReported: false,
      candidates: [],
      selectedIndex: -1,
      candidate: null,
      canvasSize: 0,
      thumbSize: 0,
    });

    try {
      const task = await api.generate(this.imageBuffer, {
        sizeTier: this.data.sizeTier,
        paletteTier: this.data.paletteTier,
        settings: this.data.advanced,
      });
      this.setData({
        stage: 'processing',
        statusText: '正在抠主体、配 MARD 色号',
        taskId: task.taskId,
      });
      this.poll(task.taskId);
    } catch (error) {
      const fallback = error.code === 'advanced-not-allowed';
      if (fallback) {
        const advanced = { ...this.data.advanced };
        advanced.series = advanced.series.filter((code) => BASIC_SERIES.includes(code));
        this.setData({
          paletteTier: 'basic',
          advanced,
          seriesOptions: seriesOptionsFor(advanced.series, 'basic'),
        });
      }
      this.showError(
        error.message,
        fallback || error.code === 'network' || error.code === 'internal',
      );
    }
  },

  poll(taskId) {
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const task = await api.getTask(taskId);
        if (task.status === 'completed') {
          this.showCandidates(task);
          return;
        }
        if (task.status === 'failed') {
          const failure = task.failure || {};
          const retryable = failure.code !== 'image-unsupported' && failure.code !== 'image-too-large';
          this.showError(failure.message || '生成失败，请稍后重试', retryable);
          return;
        }
        if (Date.now() - startedAt > config.POLL_TIMEOUT_MS) {
          this.showError('等待时间过长，请重试', true);
          return;
        }
        this.pollTimer = setTimeout(tick, config.POLL_INTERVAL_MS);
      } catch (error) {
        this.showError(error.message, true);
      }
    };
    tick();
  },

  cancelPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  },

  showCandidates(task) {
    const candidates = task.candidates || [];
    if (!candidates.length) {
      this.showError('没有拿到图纸，请重试', true);
      return;
    }
    const list = candidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      label: labelForCandidate(candidate.id),
    }));
    const thumbCell = Math.max(1, Math.floor(THUMB_WIDTH / list[0].width));
    const thumbSize = list[0].width * thumbCell;
    const applied = task.settings || DEFAULT_ADVANCED_SETTINGS;
    this.setData({
      stage: 'preview',
      message: '',
      canRetry: false,
      patternId: '',
      previewHint: DEFAULT_PICK_HINT,
      candidates: list,
      selectedIndex: -1,
      candidate: null,
      canvasSize: 0,
      thumbSize,
      advanced: applied,
      maxColorsId: String(applied.maxColors),
      seriesOptions: seriesOptionsFor(applied.series, this.data.paletteTier),
      advancedDirty: false,
      appliedSettings: isCustomSettings(applied) ? describeSettings(applied) : '',
    });
    wx.nextTick(() => {
      list.forEach((candidate, index) => this.paint(`#thumb-${index}`, candidate, thumbCell, false));
    });
    if (task.savedPattern && task.savedPattern.evictedCount > 0) {
      this.showPatternEvictionNotice(task.savedPattern.evictedCount);
    }
  },

  /** 入列表时超出上限：明确告诉用户哪些旧图被清理了。 */
  showPatternEvictionNotice(count) {
    wx.showModal({
      title: '「我的图纸」已满',
      content: `只保留最近 ${PATTERN_LIMIT} 张图纸，最早的 ${count} 张已自动清理。已保存到相册的图片不受影响。`,
      showCancel: false,
      confirmText: '知道了',
    });
  },

  selectCandidate(event) {
    const index = Number(event.currentTarget.dataset.index);
    const candidate = this.data.candidates[index];
    if (!candidate) return;
    const cell = detailCell(candidate);
    this.setData({
      selectedIndex: index,
      candidate,
      canvasSize: candidate.width * cell,
    });
    wx.nextTick(() => this.paint('#pattern', candidate, cell, true));
    this.reportSelection(index, candidate);
    this.savePattern(candidate);
  },

  /** 选中的候选就是「我的图纸」里这张图纸当前展示的候选；保存失败不打断预览。 */
  savePattern(candidate) {
    const taskId = this.data.taskId;
    if (!taskId) return;
    api.savePattern(taskId, candidate.id).catch(() => {});
  },

  /** 选中即上报；同一任务同一候选只报一次，上报失败则允许下次点击重试。 */
  reportSelection(index, candidate) {
    const taskId = this.data.taskId;
    if (!taskId) return;
    const key = `${taskId}:${index}`;
    this.reportedSelections = this.reportedSelections || {};
    this.reportingSelections = this.reportingSelections || {};
    if (this.reportedSelections[key] || this.reportingSelections[key]) return;

    this.reportingSelections[key] = true;
    const pending = [api.reportEvent('candidate_selected', { taskId, candidateId: candidate.id, index })];
    if (index === 0) {
      pending.push(api.reportEvent('first_pattern_accepted', { taskId, candidateId: candidate.id, index: 0 }));
    }
    Promise.all(pending).then((results) => {
      delete this.reportingSelections[key];
      if (results.every(Boolean)) this.reportedSelections[key] = true;
    });
  },

  /** 三张都不满意：进入逃生状态，并把原图与参数留档给后台回看。 */
  async openDissatisfied() {
    if (this.data.stage !== 'preview' || !this.imageBuffer) return;
    this.setData({
      stage: 'dissatisfied',
      message: '',
      canRetry: false,
      sampleReporting: true,
      sampleReported: false,
    });
    const reported = await this.reportFailureSample();
    this.setData({ sampleReporting: false, sampleReported: reported });
  },

  /** 上报失败样本；同一任务只报一次，失败自动再试一次，结果决定页面文案。 */
  async reportFailureSample() {
    const taskId = this.data.taskId;
    const image = this.imageBuffer;
    if (!taskId || !image) return false;
    this.reportedFailureSamples = this.reportedFailureSamples || {};
    if (this.reportedFailureSamples[taskId]) return true;

    const contentType = this.imageContentType || 'image/png';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await api.reportFailureSample(taskId, image, contentType);
        this.reportedFailureSamples[taskId] = true;
        return true;
      } catch {
        if (attempt === 0) await delay(800);
      }
    }
    return false;
  },

  /** 打开微信自带裁剪界面让用户圈出主体，裁完按当前设置重新生成。 */
  cropSubject() {
    if (!this.imagePath) {
      wx.showToast({ title: '没有可裁剪的原图，请换一张图', icon: 'none' });
      return;
    }
    if (typeof wx.editImage !== 'function') {
      wx.showToast({ title: '当前微信版本不支持裁主体，请换一张图', icon: 'none' });
      return;
    }
    wx.editImage({
      src: this.imagePath,
      success: (res) => {
        const croppedPath = res.tempFilePath;
        wx.getFileSystemManager().readFile({
          filePath: croppedPath,
          success: (result) => {
            this.imageBuffer = result.data;
            this.imagePath = croppedPath;
            this.imageContentType = contentTypeForPath(croppedPath);
            this.startGenerate();
          },
          fail: () => wx.showToast({ title: '读取裁剪图失败，请换一张图', icon: 'none' }),
        });
      },
      fail: (err) => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        wx.showToast({ title: '无法打开裁剪，请换一张图', icon: 'none' });
      },
    });
  },

  /** 导出遇到 401 时静默重新登录再试一次，登录后额度按账号继承。 */
  async requestExport(payload) {
    try {
      return await api.createExport(payload);
    } catch (error) {
      if (error.code !== 'login-required') throw error;
      const token = await api.login();
      if (!token) throw error;
      return api.createExport(payload);
    }
  },

  async exportCurrent() {
    await this.doExport('hd');
  },

  async exportTiled() {
    await this.doExport('tiled');
  },

  async doExport(type) {
    const candidate = this.data.candidate;
    const taskId = this.data.taskId;
    const patternId = this.data.patternId;
    if (!candidate || (!taskId && !patternId) || this.data.exporting) return;

    this.setData({ exporting: true, exportingType: type });
    try {
      const payload = { taskId, candidateId: candidate.id, patternId, type };
      const result = await this.requestExport(payload);
      const filePath = await api.downloadExport(result.url);
      if (type === 'tiled') {
        await openPdf(filePath);
        wx.showToast({ title: '已打开分块打印图', icon: 'none' });
      } else {
        await saveToAlbum(filePath);
        wx.showToast({ title: '已保存到相册', icon: 'none' });
      }
    } catch (error) {
      if (error.code === 'quota-exceeded') this.showQuotaDialog(error.message);
      else if (error.code === 'album-denied') this.guideAlbumSetting();
      else wx.showToast({ title: error.message, icon: 'none' });
    } finally {
      this.setData({ exporting: false, exportingType: '' });
    }
  },

  showQuotaDialog(message) {
    if (isIOS()) {
      // ADR-0003：iOS 不出现购买入口或虚拟商品文案。
      wx.showModal({
        title: '今日免费导出已用完',
        content: '明天再来，或先继续预览其他图纸',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    wx.showModal({
      title: '今日免费导出已用完',
      content: message,
      cancelText: '知道了',
      confirmText: '会员权益',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/membership/membership' });
      },
    });
  },

  guideAlbumSetting() {
    wx.showModal({
      title: '需要相册权限',
      content: '请在设置中允许保存图片到相册',
      confirmText: '去设置',
      success: (res) => {
        if (res.confirm) wx.openSetting();
      },
    });
  },

  paint(selector, candidate, cell, showCodes) {
    wx.createSelectorQuery()
      .in(this)
      .select(selector)
      .fields({ node: true, size: true })
      .exec((result) => {
        const node = result && result[0] && result[0].node;
        if (!node) return;
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 2;
        const size = candidate.width * cell;
        node.width = size * dpr;
        node.height = size * dpr;
        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);

        const colors = {};
        candidate.colors.forEach((color) => {
          colors[color.code] = color.hex;
        });

        for (let y = 0; y < candidate.height; y++) {
          for (let x = 0; x < candidate.width; x++) {
            const code = candidate.grid[y][x];
            const hex = colors[code] || '#FFFFFF';
            ctx.fillStyle = hex;
            ctx.fillRect(x * cell, y * cell, cell, cell);
            if (!showCodes || cell < MIN_CELL_FOR_CODES) continue;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
            ctx.fillStyle = luminance(hex) > 150 ? '#2B2622' : '#FFFFFF';
            ctx.font = `${cell >= 24 ? 10 : 8}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(code, x * cell + cell / 2, y * cell + cell / 2 + 0.5);
          }
        }
      });
  },

  showError(message, canRetry) {
    this.cancelPoll();
    this.setData({
      stage: 'error',
      message: message || '生成失败，请稍后重试',
      canRetry: !!canRetry,
      candidates: [],
      selectedIndex: -1,
      candidate: null,
      canvasSize: 0,
    });
  },
});

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 系列色 chips：第一项「全部」清空过滤，基础档只给基础系列，进阶档追加进阶系列。 */
function seriesOptionsFor(series, paletteTier) {
  const codes = paletteTier === 'advanced' ? [...BASIC_SERIES, ...ADVANCED_SERIES] : BASIC_SERIES;
  return [
    { key: 'all', code: '', label: '全部', active: series.length === 0 },
    ...codes.map((code) => ({ key: code, code, label: code, active: series.includes(code) })),
  ];
}

/** 只有动过高级参数才回显「本次已应用」，保持零参数主流程干净。 */
function isCustomSettings(settings) {
  return (
    settings.dithering !== 'auto' ||
    settings.background !== 'auto' ||
    settings.downscale !== 'auto' ||
    settings.maxColors !== 'auto' ||
    settings.series.length > 0
  );
}

function describeSettings(settings) {
  const parts = [
    `抖动：${SETTING_LABELS.dithering[settings.dithering]}`,
    `背景：${SETTING_LABELS.background[settings.background]}`,
    `色号：${settings.maxColors === 'auto' ? '自动' : `${settings.maxColors} 色上限`}`,
    `降采样：${SETTING_LABELS.downscale[settings.downscale]}`,
    `系列：${settings.series.length ? settings.series.join('/') : '全部'}`,
  ];
  return `本次已应用 · ${parts.join(' · ')}`;
}

function contentTypeForPath(path) {
  const ext = String(path || '')
    .split('.')
    .pop()
    .toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单块板保留可读色号格宽（超出屏幕时横向滚动）；多块板按可用画布宽度铺满，
 * 格宽过密时 paint 会隐藏格内色号。
 */
function detailCell(candidate) {
  if (candidate.boardCount <= 1) {
    return Math.min(MAX_CELL, Math.floor(DETAIL_MAX_PX / candidate.width));
  }
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const rpx = (info.windowWidth || 375) / 750;
  const availableWidth = Math.max(1, Math.floor(info.windowWidth - PAGE_H_PADDING_RPX * rpx));
  return Math.max(1, Math.floor(availableWidth / candidate.width));
}

function saveToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: resolve,
      fail: (err) => {
        const denied = /auth|deny|permission/i.test((err && err.errMsg) || '');
        reject(
          new api.ApiError(
            denied ? '需要相册权限才能保存图纸' : '保存失败，请重试',
            denied ? 'album-denied' : 'unknown',
          ),
        );
      },
    });
  });
}

/** 分块打印图是 PDF，打开后用右上角菜单保存或打印。 */
function openPdf(filePath) {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      fileType: 'pdf',
      showMenu: true,
      success: resolve,
      fail: () => reject(new api.ApiError('无法打开打印图，请重试', 'unknown')),
    });
  });
}

function isIOS() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    return info.platform === 'ios';
  } catch {
    return false;
  }
}
