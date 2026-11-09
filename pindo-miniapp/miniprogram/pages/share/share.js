const api = require('../../utils/api');
const config = require('../../utils/config');

Page({
  data: {
    stage: 'loading', // loading | ready | error
    message: '',
    title: '',
    boardCount: 0,
    paletteLabel: '',
    coverUrl: '',
  },

  onLoad(options) {
    this.shareId = (options && options.id) || '';
    if (!this.shareId) {
      this.setData({ stage: 'error', message: '分享链接不完整' });
      return;
    }
    this.loadShare();
  },

  async loadShare() {
    try {
      const result = await api.getShare(this.shareId);
      const candidate = result && result.candidate;
      if (!candidate) throw new api.ApiError('分享已失效', 'unknown');
      this.setData({
        stage: 'ready',
        message: '',
        title: `${candidate.width}×${candidate.height} 拼豆图纸 · ${candidate.colors.length} 色`,
        boardCount: candidate.boardCount,
        paletteLabel: candidate.paletteTier === 'advanced' ? 'MARD 291' : 'MARD 221',
        coverUrl: `${config.BASE_URL}${result.coverUrl}`,
      });
    } catch (error) {
      this.setData({ stage: 'error', message: error.message });
    }
  },

  goCreate() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  /** 接收者再转发时继续使用同一分享号，仍只暴露这一张。 */
  onShareAppMessage() {
    if (!this.shareId) {
      return { title: '拼豆图纸生成', path: '/pages/index/index' };
    }
    return {
      title: this.data.title || '拼豆图纸',
      path: `/pages/share/share?id=${this.shareId}`,
      imageUrl: this.data.coverUrl || undefined,
    };
  },
});
