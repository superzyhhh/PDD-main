// 开发期指向本地服务端；上线时替换为微信云托管的外网地址，并在小程序后台配置合法域名。
module.exports = {
  BASE_URL: 'http://127.0.0.1:3000',
  POLL_INTERVAL_MS: 800,
  POLL_TIMEOUT_MS: 30000,
  MAX_IMAGE_BYTES: 10 * 1024 * 1024,
};
