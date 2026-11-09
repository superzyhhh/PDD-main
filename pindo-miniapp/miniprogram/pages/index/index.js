const api = require('../../utils/api');
const config = require('../../utils/config');

const THUMB_WIDTH = 145;
const DETAIL_MAX_PX = 812;
const MAX_CELL = 28;
const MIN_CELL_FOR_CODES = 14;
const PAGE_H_PADDING_RPX = 48;
const CANDIDATE_LABELS = ['保主体细节', '保色彩层次', '保少色号'];

Page({
  data: {
    stage: 'idle', // idle | uploading | processing | preview | error
    statusText: '',
    message: '',
    canRetry: false,
    taskId: '',
    sizeTier: 'small',
    paletteTier: 'basic',
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
  },

  onUnload() {
    this.cancelPoll();
  },

  selectSize(event) {
    this.setData({ sizeTier: event.currentTarget.dataset.id });
  },

  selectPalette(event) {
    this.setData({ paletteTier: event.currentTarget.dataset.id });
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
      });
      this.setData({
        stage: 'processing',
        statusText: '正在抠主体、配 MARD 色号',
        taskId: task.taskId,
      });
      this.poll(task.taskId);
    } catch (error) {
      const fallback = error.code === 'advanced-not-allowed';
      if (fallback) this.setData({ paletteTier: 'basic' });
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
          this.showCandidates(task.candidates || []);
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

  showCandidates(candidates) {
    if (!candidates.length) {
      this.showError('没有拿到图纸，请重试', true);
      return;
    }
    const list = candidates.slice(0, CANDIDATE_LABELS.length).map((candidate, index) => ({
      ...candidate,
      label: CANDIDATE_LABELS[index],
    }));
    const thumbCell = Math.max(1, Math.floor(THUMB_WIDTH / list[0].width));
    const thumbSize = list[0].width * thumbCell;
    this.setData({
      stage: 'preview',
      message: '',
      canRetry: false,
      candidates: list,
      selectedIndex: -1,
      candidate: null,
      canvasSize: 0,
      thumbSize,
    });
    wx.nextTick(() => {
      list.forEach((candidate, index) => this.paint(`#thumb-${index}`, candidate, thumbCell, false));
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
