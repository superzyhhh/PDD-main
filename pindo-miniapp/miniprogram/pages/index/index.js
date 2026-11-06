const api = require('../../utils/api');
const config = require('../../utils/config');

const CELL = 28;

Page({
  data: {
    stage: 'idle', // idle | uploading | processing | preview | error
    statusText: '',
    message: '',
    canRetry: false,
    taskId: '',
    candidate: null,
    canvasSize: 0,
  },

  onUnload() {
    this.cancelPoll();
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
    this.setData({
      stage: 'uploading',
      statusText: '正在上传图片',
      message: '',
      canRetry: false,
      candidate: null,
      canvasSize: 0,
    });

    try {
      const task = await api.generate(this.imageBuffer);
      this.setData({
        stage: 'processing',
        statusText: '正在抠主体、配 MARD 色号',
        taskId: task.taskId,
      });
      this.poll(task.taskId);
    } catch (error) {
      this.showError(error.message, error.code === 'network' || error.code === 'internal');
    }
  },

  poll(taskId) {
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const task = await api.getTask(taskId);
        if (task.status === 'completed') {
          this.showCandidate(task.candidates[0]);
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

  showCandidate(candidate) {
    if (!candidate) {
      this.showError('没有拿到图纸，请重试', true);
      return;
    }
    this.setData({
      stage: 'preview',
      message: '',
      canRetry: false,
      candidate,
      canvasSize: candidate.width * CELL,
    });
    wx.nextTick(() => this.drawCandidate(candidate));
  },

  drawCandidate(candidate) {
    wx.createSelectorQuery()
      .in(this)
      .select('#pattern')
      .fields({ node: true, size: true })
      .exec((result) => {
        const node = result && result[0] && result[0].node;
        if (!node) return;
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 2;
        const size = candidate.width * CELL;
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
            ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
            ctx.fillStyle = luminance(hex) > 150 ? '#2B2622' : '#FFFFFF';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(code, x * CELL + CELL / 2, y * CELL + CELL / 2 + 0.5);
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
    });
  },
});

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
