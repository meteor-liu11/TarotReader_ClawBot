/* ClawBot 正式会话适配器：为共享仪式页接入会话、牌序、解读与微信投递。 */
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const pagesMode = query.has('api');
const pathToken = location.pathname.match(/\/s\/([^/]+)\/?$/)?.[1] ?? '';
const token = query.get('token') ?? (pathToken ? decodeURIComponent(pathToken) : '');
let apiBase = location.origin;

function configureApiBase() {
  const configured = query.get('api');
  if (!configured) {
    if (location.hostname.endsWith('.github.io') && token) {
      return '这个抽卡链接缺少本机服务连接，请回微信重新获取新链接。';
    }
    window.__CLAWBOT_API_BASE__ = apiBase;
    return '';
  }
  let url;
  try { url = new URL(configured); } catch { return '抽卡链接中的服务地址无效，请回微信重新获取新链接。'; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const pagesHost = location.hostname.endsWith('.github.io');
  const quickTunnel = url.protocol === 'https:'
    && url.hostname.endsWith('.trycloudflare.com') && !url.port;
  if ((pagesHost ? !quickTunnel : (!local && !quickTunnel && url.origin !== location.origin))
      || (local && pagesHost) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
    return '抽卡链接中的服务地址不安全或格式不正确。';
  }
  apiBase = url.origin;
  window.__CLAWBOT_API_BASE__ = apiBase;
  return '';
}

const api = async (path, opts) => {
  const res = await fetch(new URL(path.replace(/^\/+/, ''), `${apiBase}/`), opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
};

let session = null;
let timerId = null;
let readingStarted = false;

function expandSessionPage() {
  document.body.classList.add('session-result-ready');
  $('ritual-shell')?.classList.add('session-result-ready');
}

function showNotice(message, kind = '') {
  const el = $('notice');
  if (!el) return;
  el.textContent = message;
  el.className = `session-notice${kind ? ` ${kind}` : ''}`;
  el.hidden = !message;
  if (document.body.dataset.playStage === '3' && message) {
    expandSessionPage();
  }
}

function startTimer(remainingMs) {
  const deadline = Date.now() + Math.max(0, Number(remainingMs) || 0);
  const tick = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      clearInterval(timerId);
      $('timer').textContent = '已过期';
      $('timer').classList.add('warn');
      showNotice('这个抽卡链接已过期。回微信重新发一次「抽塔罗」即可获得新链接。', 'red');
      return;
    }
    const m = String(Math.floor(left / 60000)).padStart(2, '0');
    const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    $('timer').textContent = `${m}:${s}`;
    if (left < 60000) $('timer').classList.add('warn');
  };
  tick();
  timerId = setInterval(tick, 1000);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function pollDelivery(readingId) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    $('status-line').innerHTML = '<span class="spinner"></span><span>解读正在发送到微信；你可以返回本次对话查看。</span>';
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const res = await api(`/api/reading/${encodeURIComponent(readingId)}`);
    if (!res.ok) continue;
    if (res.data.delivered) {
      $('status-line').innerHTML = '<span class="badge green">已发送到微信</span><span class="t-small ink-3">请返回本次微信对话查看解读</span>';
      return;
    }
    if (!res.data.deliveryPending) {
      $('status-line').innerHTML = `<span class="badge red">暂未确认发送</span><span class="t-small ink-3">请返回微信稍后查看；如未收到，再重新发起抽牌。</span>`;
      return;
    }
  }
  $('status-line').innerHTML = '<span class="badge gold">后台仍在处理</span><span class="t-small ink-3">你可以返回微信等待解读；若未收到，再重新发起抽牌。</span>';
}

async function generateReading() {
  if (readingStarted) return;
  readingStarted = true;
  $('result').classList.remove('hidden');
  $('status-line').innerHTML = '<span class="spinner"></span><span>牌已抽好，正在整理解读并发回微信。你可以返回微信查看。</span>';
  $('btn-return-wechat').hidden = true;
  $('btn-retry-reading').hidden = true;
  expandSessionPage();

  let res;
  try {
    res = await api(`/api/callback/${encodeURIComponent(token)}`, { method: 'POST' });
  } catch (error) {
    readingStarted = false;
    $('status-line').textContent = error.message ?? '连接 ClawBot 失败';
    $('btn-retry-reading').hidden = false;
    return;
  }
  if (!res.ok) {
    readingStarted = false;
    $('status-line').innerHTML = `<span class="badge red">生成失败</span><span>${escapeHtml(res.data.error ?? '生成解读失败')}</span>`;
    $('btn-retry-reading').hidden = false;
    return;
  }

  const data = res.data;
  clearInterval(timerId);
  $('timer').textContent = '已完成';
  $('btn-return-wechat').hidden = false;
  $('wallet').classList.add('hidden');

  if (data.gatewayMode === 'mock') {
    $('status-line').innerHTML = '<span class="badge gold">本地 mock 模式</span><span class="t-small ink-3">当前环境不会真实投递；正式会话会把解读发回微信。</span>';
    $('btn-return-wechat').hidden = true;
    return;
  }
  await pollDelivery(data.readingId);
}

function returnToWechat() {
  try {
    if (window.WeixinJSBridge?.invoke) {
      window.WeixinJSBridge.invoke('closeWindow', {}, () => {});
      return;
    }
  } catch { /* 非微信浏览器继续尝试浏览器历史 */ }
  if (history.length > 1) history.back();
  else showNotice('请使用微信左上角返回，回到本次对话查看解读。');
}

async function loadWallet() {
  const res = await api(`/api/credits/${encodeURIComponent(token)}`);
  if (res.ok) $('credits').textContent = `${res.data.credits} 点`;
}

$('btn-history').hidden = pagesMode;
$('btn-retry-reading').addEventListener('click', () => generateReading());
$('btn-return-wechat').addEventListener('click', returnToWechat);
$('btn-redeem').addEventListener('click', async () => {
  const code = $('code').value.trim();
  if (!code) return;
  const res = await api('/api/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, code }),
  });
  const msg = $('wallet-msg');
  if (res.data.ok) {
    msg.textContent = `兑换成功，+${res.data.credits} 点，当前 ${res.data.balance} 点。`;
    msg.className = 't-small k-ok mt';
    await loadWallet();
  } else {
    msg.textContent = res.data.reason ?? res.data.error ?? '兑换失败';
    msg.className = 't-small k-danger mt';
  }
});
$('btn-history').addEventListener('click', async () => {
  if (pagesMode) return;
  const res = await api(`/api/me/${encodeURIComponent(token)}`);
  if (!res.ok) return;
  const rows = res.data.history ?? [];
  $('history').innerHTML = rows.length ? rows.map((row) => {
    const cards = (row.cards ?? []).map((card) => `${escapeHtml(card.name)}${card.reversed ? '（逆）' : ''}`).join('、');
    const when = new Date(row.createdAt).toLocaleString('zh-CN');
    return `<div class="history-item"><div class="q">${escapeHtml(row.question || '（未记录问题）')}</div><div class="t-small ink-2">${cards}</div><div class="t-micro ink-3">${escapeHtml(when)}</div></div>`;
  }).join('') : '<span class="t-small ink-3">还没有记录</span>';
});

async function init() {
  const apiError = configureApiBase();
  if (apiError) throw new Error(apiError);
  if (!token) throw new Error('链接中缺少会话编号');
  const res = await api(`/api/session/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(res.data.error ?? '链接无效或已过期');
  session = res.data;
  if (!session.spread?.positions?.length || !session.spread.count) throw new Error('会话牌阵资料不完整');

  $('spread-kind').textContent = `当前牌阵：${session.spread.name}`;
  const question = String(session.question ?? '').replace(/\s+/g, ' ').trim();
  $('spread-name').textContent = question || '想一想你要问的事';
  $('spread-name').setAttribute('aria-label', question ? `本次问题：${question}` : '想一想你要问的事');
  $('spread-desc').textContent = '静下心，来回洗牌';
  const cost = session.creditCost > 0 ? `消耗 ${session.creditCost} 点` : '免费牌阵';
  $('meta').textContent = `${session.spread.count} 张 · ${cost}`;
  $('ritual-shell').hidden = false;
  $('session-error').hidden = true;

  // play.js 在拿到正式会话后再加载，因此同一套仪式 UI 能直接接入业务后端。
  window.__CLAWBOT_RITUAL = {
    token,
    session,
    shuffle: (entropy) => api(`/api/shuffle/${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entropy }),
    }),
    draw: async (picks) => {
      const result = await api(`/api/draw/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ picks }),
      });
      if (result.status === 402) {
        $('wallet').classList.remove('hidden');
        expandSessionPage();
        await loadWallet();
      }
      return result;
    },
    showNotice,
    clearNotice: () => showNotice(''),
    afterReveal: () => generateReading(),
  };
  await import(new URL('./play.js?v=20261024-pages-v1', import.meta.url));
  startTimer(session.remainingMs);
}

init().catch((error) => {
  $('session-error').textContent = error.message || '无法载入抽卡会话';
  $('session-error').classList.add('is-error');
});
