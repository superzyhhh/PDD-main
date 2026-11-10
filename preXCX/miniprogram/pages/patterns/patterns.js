const api = require('../../utils/api');
const { labelForCandidate } = require('../../utils/candidate-labels');

Page({
  data: {
    loading: true,
    error: '',
    limit: 50,
    patterns: [],
  },

  onShow() {
    this.loadPatterns();
  },

  async loadPatterns() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await api.listPatterns();
      const patterns = (result.patterns || []).map((item) => ({
        ...item,
        label: labelForCandidate(item.candidateId),
        meta: `${item.width} × ${item.height} · ${item.colorCodeCount} 个色号 · ${item.boardCount} 块板`,
        date: formatDate(item.createdAt),
      }));
      this.setData({ loading: false, limit: result.limit || 50, patterns });
    } catch (error) {
      this.setData({ loading: false, error: error.message || '图纸列表加载失败，请重试' });
    }
  },

  /** 把选中的图纸交给首页消费，返回后直接进入可导出的预览。 */
  openPattern(event) {
    const patternId = event.currentTarget.dataset.id;
    if (!patternId) return;
    getApp().globalData.pendingPattern = { patternId };
    wx.navigateBack({
      fail: () => wx.redirectTo({ url: '/pages/index/index' }),
    });
  },

  deletePattern(event) {
    const patternId = event.currentTarget.dataset.id;
    if (!patternId) return;
    wx.showModal({
      title: '删除这张图纸？',
      content: '删除后将从「我的图纸」移除，已保存到相册的图片不受影响。',
      confirmText: '删除',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.deletePattern(patternId);
          wx.showToast({ title: '已删除', icon: 'none' });
          this.loadPatterns();
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败，请重试', icon: 'none' });
        }
      },
    });
  },

  retryLoad() {
    this.loadPatterns();
  },
});

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => (value < 10 ? `0${value}` : `${value}`);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
