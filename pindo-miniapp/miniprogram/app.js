App({
  onLaunch(options) {
    const raw = options && options.query && options.query.channel;
    this.globalData.channel = typeof raw === 'string' ? raw : '';
  },
  globalData: {
    lastTaskId: '',
    /** 从「我的图纸」打开某张图纸时，交给首页消费后置空。 */
    pendingPattern: null,
    /** 投放渠道，由链接或小程序卡片参数带入，随生成请求上报，用于看板按渠道归因。 */
    channel: ''
  }
});
