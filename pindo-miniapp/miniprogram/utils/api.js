const config = require('./config');

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'unknown';
  }
}

function apiErrorFrom(response, fallbackMessage) {
  const error = response.data && response.data.error;
  return new ApiError((error && error.message) || fallbackMessage, (error && error.code) || 'unknown');
}

function request(options) {
  return new Promise((resolve, reject) => {
    wx.request({
      ...options,
      success: resolve,
      fail: () => reject(new ApiError('网络连接失败，请检查网络后重试', 'network')),
    });
  });
}

let sessionToken = '';

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('no code'))),
      fail: () => reject(new Error('wx.login failed')),
    });
  });
}

// 静默登录，失败也不阻塞预览。
async function ensureSession() {
  if (sessionToken) return sessionToken;
  try {
    const code = await wxLogin();
    const response = await request({
      url: `${config.BASE_URL}/api/session`,
      method: 'POST',
      data: { code },
      header: { 'content-type': 'application/json' },
    });
    if (response.statusCode === 200 && response.data && response.data.token) {
      sessionToken = response.data.token;
    }
  } catch {
    // 未登录可预览，忽略。
  }
  return sessionToken;
}

// 强制重新登录，用于导出遇到 401 后重新引导。
async function login() {
  sessionToken = '';
  return ensureSession();
}

async function generate(arrayBuffer, options = {}) {
  const token = await ensureSession();
  const header = {
    'content-type': 'application/octet-stream',
    'x-size-tier': options.sizeTier || 'small',
    'x-palette-tier': options.paletteTier || 'basic',
  };
  if (token) header['x-session-token'] = token;

  const response = await request({
    url: `${config.BASE_URL}/api/generate`,
    method: 'POST',
    data: arrayBuffer,
    timeout: 20000,
    header,
  });

  if (response.statusCode === 202) return response.data;
  throw apiErrorFrom(response, '生成失败，请稍后重试');
}

async function getTask(taskId) {
  const response = await request({
    url: `${config.BASE_URL}/api/tasks/${encodeURIComponent(taskId)}`,
    method: 'GET',
    timeout: 10000,
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '任务查询失败，请重新生成');
}

// 高清导出：服务端校验登录与每日额度，返回可下载资源。
async function createExport(taskId, candidateId) {
  const token = await ensureSession();
  const header = { 'content-type': 'application/json' };
  if (token) header['x-session-token'] = token;
  const response = await request({
    url: `${config.BASE_URL}/api/exports`,
    method: 'POST',
    data: { taskId, candidateId },
    timeout: 30000,
    header,
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '导出失败，请稍后重试');
}

// 下载已生成的导出资源；服务端要求登录且只能取本账号的资源。
async function downloadExport(path) {
  const token = await ensureSession();
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: `${config.BASE_URL}${path}`,
      header: token ? { 'x-session-token': token } : {},
      success: (res) => {
        if (res.statusCode === 200) resolve(res.tempFilePath);
        else reject(new ApiError('图纸下载失败，请重试', 'network'));
      },
      fail: () => reject(new ApiError('网络连接失败，请检查网络后重试', 'network')),
    });
  });
}

// 埋点上报为尽力而为：失败不打断主流程，但把结果交给调用方决定是否重试。
function reportEvent(name, payload) {
  const header = { 'content-type': 'application/json' };
  if (sessionToken) header['x-session-token'] = sessionToken;
  return new Promise((resolve) => {
    wx.request({
      url: `${config.BASE_URL}/api/events`,
      method: 'POST',
      data: { ...payload, name },
      header,
      timeout: 5000,
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}

module.exports = {
  ApiError,
  generate,
  getTask,
  reportEvent,
  createExport,
  downloadExport,
  login,
};
