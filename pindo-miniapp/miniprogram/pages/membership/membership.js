const api = require('../../utils/api');

const BENEFITS = ['无限次高清导出', 'MARD 291 进阶色卡档位', '后续风格化次数包'];

Page({
  data: {
    loading: true,
    error: '',
    isIOS: false,
    purchaseAvailable: false,
    plans: [],
    membership: null,
    membershipLabel: '',
    purchasing: '',
    benefits: BENEFITS,
  },

  onLoad() {
    this.setData({ isIOS: isIOS() });
  },

  onShow() {
    this.loadMembership();
  },

  async loadMembership() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await api.getMembership(this.platform());
      this.setData({
        loading: false,
        purchaseAvailable: !!result.purchaseAvailable,
        plans: result.plans || [],
        membership: result.membership || null,
        membershipLabel: describeMembership(result.membership),
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message || '会员信息加载失败，请重试' });
    }
  },

  platform() {
    return this.data.isIOS ? 'ios' : 'android';
  },

  retryLoad() {
    this.loadMembership();
  },

  async buy(event) {
    const plan = event.currentTarget.dataset.id;
    // ADR-0003：iOS 不提供任何可触发的购买路径。
    if (!plan || this.data.purchasing || this.data.isIOS || !this.data.purchaseAvailable) return;
    this.setData({ purchasing: plan });
    try {
      const order = await api.createMembershipOrder(plan, this.platform());
      const payment = order.payment || {};
      // 服务端未返回真实支付参数时不拉起支付，避免伪造成功。
      if (!payment.timeStamp || !payment.nonceStr || !payment.package || !payment.paySign) {
        throw new api.ApiError('支付暂未开通，请稍后再试', 'payment-unavailable');
      }
      await requestPayment(payment);
      wx.showToast({ title: '支付成功，正在确认权益', icon: 'none' });
      await this.confirmMembership();
    } catch (error) {
      wx.showToast({ title: error.message || '支付未完成，请重试', icon: 'none' });
    } finally {
      this.setData({ purchasing: '' });
    }
  },

  /** 支付回调可能略晚于客户端成功，短轮询几次再给出「确认中」提示。 */
  async confirmMembership() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await api.getMembership(this.platform());
      if (result.membership && result.membership.active) {
        this.setData({
          purchaseAvailable: !!result.purchaseAvailable,
          plans: result.plans || [],
          membership: result.membership,
          membershipLabel: describeMembership(result.membership),
        });
        wx.showToast({ title: '会员已生效', icon: 'none' });
        return;
      }
      await delay(800);
    }
    wx.showToast({ title: '支付结果确认中，请稍后刷新', icon: 'none' });
  },
});

function describeMembership(membership) {
  if (!membership) return '当前为免费账号，每日可导出高清图纸';
  if (membership.active) return `会员有效至 ${formatDate(membership.expiresAt)}`;
  return `会员已于 ${formatDate(membership.expiresAt)} 到期，权益已收回`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestPayment(payment) {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: payment.timeStamp,
      nonceStr: payment.nonceStr,
      package: payment.package,
      signType: payment.signType || 'RSA',
      paySign: payment.paySign,
      success: resolve,
      fail: (err) => {
        const cancelled = /cancel/i.test((err && err.errMsg) || '');
        reject(new api.ApiError(cancelled ? '支付已取消' : '支付未完成，请重试', 'payment-failed'));
      },
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
