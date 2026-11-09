const config = require('../../utils/config');

Page({
  data: {
    url: '',
  },

  onLoad() {
    const url = config.PURCHASE_URL;
    if (url && /^https:\/\//.test(url)) this.setData({ url });
  },
});
