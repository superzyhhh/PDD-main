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
  if (options.settings) header['x-advanced-settings'] = JSON.stringify(options.settings);

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

// 三候选全不满意：带上原图与任务号，服务端留档参数与三候选供后台回看。
async function reportFailureSample(taskId, arrayBuffer, contentType = 'image/png') {
  const token = await ensureSession();
  const header = {
    'content-type': contentType || 'image/png',
    'x-task-id': taskId,
  };
  if (token) header['x-session-token'] = token;
  const response = await request({
    url: `${config.BASE_URL}/api/failure-samples`,
    method: 'POST',
    data: arrayBuffer,
    timeout: 20000,
    header,
  });
  if (response.statusCode === 201) return response.data;
  throw apiErrorFrom(response, '反馈提交失败，请稍后重试');
}

// 导出：服务端校验登录与每日额度，返回可下载资源；type 为 hd（PNG）或 tiled（A4 PDF）。
// 从「我的图纸」重开时只传 patternId，服务端用保存的快照出图并命中缓存。
async function createExport(payload = {}) {
  const { taskId = '', candidateId = '', type = 'hd', patternId = '' } = payload;
  const token = await ensureSession();
  const header = { 'content-type': 'application/json' };
  if (token) header['x-session-token'] = token;
  const data = patternId ? { patternId, type } : { taskId, candidateId, type };
  const response = await request({
    url: `${config.BASE_URL}/api/exports`,
    method: 'POST',
    data,
    timeout: 60000,
    header,
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '导出失败，请稍后重试');
}

async function requireToken(message) {
  const token = await ensureSession();
  if (!token) throw new ApiError(message, 'login-required');
  return token;
}

// 「我的图纸」只返回摘要；打开某一张时再取逐格矩阵。
async function listPatterns() {
  const token = await requireToken('请先登录再查看「我的图纸」');
  const response = await request({
    url: `${config.BASE_URL}/api/patterns`,
    method: 'GET',
    timeout: 10000,
    header: { 'x-session-token': token },
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '图纸列表加载失败，请重试');
}

async function getPattern(patternId) {
  const token = await requireToken('请先登录再查看「我的图纸」');
  const response = await request({
    url: `${config.BASE_URL}/api/patterns/${encodeURIComponent(patternId)}`,
    method: 'GET',
    timeout: 10000,
    header: { 'x-session-token': token },
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '图纸加载失败，请重试');
}

// 选中候选后原地更新已保存的图纸；失败不打断预览。
async function savePattern(taskId, candidateId) {
  const token = await ensureSession();
  const header = { 'content-type': 'application/json' };
  if (token) header['x-session-token'] = token;
  const response = await request({
    url: `${config.BASE_URL}/api/patterns`,
    method: 'POST',
    data: { taskId, candidateId },
    timeout: 10000,
    header,
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '保存失败，请稍后重试');
}

async function deletePattern(patternId) {
  const token = await requireToken('请先登录再删除图纸');
  const response = await request({
    url: `${config.BASE_URL}/api/patterns/${encodeURIComponent(patternId)}`,
    method: 'DELETE',
    timeout: 10000,
    header: { 'x-session-token': token },
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '删除失败，请稍后重试');
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

// 会员状态与可购套餐；权益一律以服务端返回为准，iOS 端不请求价格。
async function getMembership(platform) {
  const token = await ensureSession();
  const header = { 'x-platform': platform || 'android' };
  if (token) header['x-session-token'] = token;
  const response = await request({
    url: `${config.BASE_URL}/api/membership`,
    method: 'GET',
    timeout: 10000,
    header,
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '会员信息加载失败，请重试');
}

// 创建会员订单，返回 wx.requestPayment 所需参数；是否可开通由服务端判定。
async function createMembershipOrder(plan, platform) {
  const token = await ensureSession();
  const header = {
    'content-type': 'application/json',
    'x-platform': platform || 'android',
  };
  if (token) header['x-session-token'] = token;
  const response = await request({
    url: `${config.BASE_URL}/api/membership/orders`,
    method: 'POST',
    data: { plan },
    timeout: 15000,
    header,
  });
  if (response.statusCode === 200) return response.data;
  throw apiErrorFrom(response, '开通失败，请稍后重试');
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
  reportFailureSample,
  reportEvent,
  createExport,
  downloadExport,
  listPatterns,
  getPattern,
  savePattern,
  deletePattern,
  getMembership,
  createMembershipOrder,
  login,
};
