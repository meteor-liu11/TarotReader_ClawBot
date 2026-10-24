#!/usr/bin/env node
/**
 * 第 1 周验证清单（V1–V6）自动化跑批
 *
 *   node scripts/verify.mjs
 *
 * 用临时数据库在随机端口拉起服务，跑完自动关闭，不污染开发库。
 * V2（微信外链可点性）与 V4（微信消息长度）需要真机，脚本只给出待办与结论口径。
 */

import { spawn } from 'node:child_process';
import { rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildPages } from './build-pages.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VERIFY_WORK = resolve(ROOT, '.work');
mkdirSync(VERIFY_WORK, { recursive: true });

const PORT = 8000 + Math.floor(Math.random() * 900);
const PROXY_PORT = 10_000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;
const PAGES_BASE = 'https://meteor-liu11.github.io/TarotReader_ClawBot/';
const PAGES_ORIGIN = 'https://meteor-liu11.github.io';
const DB = resolve(VERIFY_WORK, `tarot-verify-${randomBytes(4).toString('hex')}.db`);
const PAGES_TEST_DIR = resolve(VERIFY_WORK, `pages-verify-${randomBytes(4).toString('hex')}`);

const R = { pass: 0, fail: 0, warn: 0, manual: 0 };

const C = {
  pass: (s) => `\x1b[32m${s}\x1b[0m`,
  fail: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  ok ? R.pass++ : R.fail++;
  console.log(`  ${ok ? C.pass('PASS') : C.fail('FAIL')}  ${label}`);
  if (detail) console.log(`        ${C.dim(detail)}`);
}

function manual(label, detail) {
  R.manual++;
  console.log(`  ${C.warn('TODO')}  ${label}`);
  if (detail) console.log(`        ${C.dim(detail)}`);
}

function section(t) { console.log(`\n${C.bold(t)}`); }

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
};

/** 投递是后台跑的（真机上要等 40-90 秒），所以轮询而不是同步断言 */
async function waitDelivered(readingId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api(`/api/reading/${readingId}`);
    last = r.data;
    if (last?.delivered) return last;
    if (last && !last.deliveryPending) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

function startServer() {
  const child = spawn(process.execPath, [resolve(ROOT, 'src/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      PUBLIC_BASE_URL: BASE,
      PUBLIC_H5_BASE_URL: PAGES_BASE,
      PUBLIC_API_BASE_URL: 'https://test-api.trycloudflare.com',
      SESSION_TTL_MINUTES: '10',
      GATEWAY_MODE: 'mock',
      READING_MODE: 'template',
      HOOK_TOKEN: 'verify-token',
      AGENT_ID: 'tarot',
      CHANNEL: 'openclaw-weixin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (!s.includes('ExperimentalWarning')) process.stderr.write(C.dim(`  [server] ${s}`));
  });
  return child;
}

function startPublicProxy() {
  const child = spawn(process.execPath, [resolve(ROOT, 'scripts/public-proxy.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PUBLIC_PROXY_HOST: '127.0.0.1',
      PUBLIC_PROXY_PORT: String(PROXY_PORT),
      PUBLIC_PROXY_UPSTREAM_HOST: '127.0.0.1',
      PUBLIC_PROXY_UPSTREAM_PORT: String(PORT),
      PAGES_ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(C.dim(`  [proxy] ${String(d)}`)));
  return child;
}

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitProxyReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${PROXY_BASE}/_local-health`);
      if (response.ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function proxyRequest(path, opts = {}) {
  const response = await fetch(PROXY_BASE + path, {
    ...opts,
    headers: { Origin: PAGES_ORIGIN, ...(opts.headers ?? {}) },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: response.status, ok: response.ok, data, headers: response.headers };
}

function renderManualCurl(payload, readingId) {
  if (!payload) return '(no payload)';
  return [
    'curl --include http://127.0.0.1:18789/hooks/agent \\',
    "  -H 'Authorization: Bearer $HOOK_TOKEN' \\",
    "  -H 'Content-Type: application/json' \\",
    `  -H 'Idempotency-Key: draw_${readingId}' \\`,
    `  --data '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`,
  ].join('\n        ');
}

async function main() {
  console.log(C.bold('\n  塔罗 ClawBot - 第 1 周验证清单\n'));
  console.log(C.dim(`  服务 ${BASE}   数据库 ${DB}\n`));

  const server = startServer();
  let proxy = null;
  if (!(await waitReady())) {
    console.log(C.fail('  服务启动失败。先单独跑一次 npm start 看报错。'));
    server.kill();
    process.exit(1);
  }

  try {
    buildPages(PAGES_TEST_DIR);
    const pagesHtml = readFileSync(resolve(PAGES_TEST_DIR, 'index.html'), 'utf8');
    check('Pages 构建只包含正式抽牌 H5 且静态路径兼容项目子目录',
      pagesHtml.includes('static/draw.js') && !pagesHtml.includes('src="/static/')
        && existsSync(resolve(PAGES_TEST_DIR, 'static/play.js'))
        && existsSync(resolve(PAGES_TEST_DIR, 'deck'))
        && !existsSync(resolve(PAGES_TEST_DIR, 'admin')));
    const pagesDraw = readFileSync(resolve(ROOT, 'public/static/draw.js'), 'utf8');
    const envBuilder = readFileSync(resolve(ROOT, 'scripts/make-env.mjs'), 'utf8');
    check('Pages H5 只接受 HTTPS Cloudflare Quick Tunnel API 地址',
      pagesDraw.includes("url.hostname.endsWith('.trycloudflare.com')"));
    check('动态 Tunnel 地址不写入生成的 .env',
      envBuilder.includes('PUBLIC_API_BASE_URL=\n') && envBuilder.includes('PUBLIC_H5_BASE_URL=\n'));

    proxy = startPublicProxy();
    if (!(await waitProxyReady())) throw new Error('Filtered public API proxy did not start in verification.');

    // ══ V1 ═══════════════════════════════════════════════
    section('V1 - 服务与通道可用性');
    const health = await api('/health');
    check('服务健康检查、分类与 direct-access 路由版本通过', health.ok && health.data.agentClassify === 1 && health.data.agentApplications === 2,
      `cards=${health.data.cards} spreads=${health.data.spreads} classify=${health.data.agentClassify} applications=${health.data.agentApplications}`);
    check('服务器已启用 Pages H5 + HTTPS API 地址模式', health.data.publicPages === 1);
    check('牌库为完整 78 张', health.data.cards === 78, `实际 ${health.data.cards} 张`);

    const classifyExplicit = await api('/api/agent/classify', {
      method: 'POST', body: JSON.stringify({ text: '我要抽一个今日运势' }),
    });
    check('无副作用分类能识别“今日运势”并返回 divination',
      classifyExplicit.ok && classifyExplicit.data.intent === 'divination');
    const classifyMaybe = await api('/api/agent/classify', {
      method: 'POST', body: JSON.stringify({ text: '我和他还有可能吗' }),
    });
    check('无副作用分类能识别未定结果并提供澄清话术',
      classifyMaybe.ok && classifyMaybe.data.intent === 'maybe_divination'
        && typeof classifyMaybe.data.prompt === 'string');
    const classifyChat = await api('/api/agent/classify', {
      method: 'POST', body: JSON.stringify({ text: '今天天气不错' }),
    });
    check('无副作用分类让普通闲聊继续交给 Agent',
      classifyChat.ok && classifyChat.data.intent === 'chat');

    // 牌面素材完整性：任何一张卡缺图都会在 H5 上开天窗
    const { CARDS: ALL_CARDS } = await import('../src/tarot-data.mjs');
    const { readdirSync } = await import('node:fs');
    const deckFiles = new Set(readdirSync(resolve(ROOT, 'public/deck')));
    const missingImg = ALL_CARDS.filter((c) => !deckFiles.has(c.img));
    check('78 张卡的牌面文件全部存在（无空白卡）',
      missingImg.length === 0,
      missingImg.length ? `缺图 ${missingImg.length} 张：${missingImg.slice(0, 5).map((c) => c.id).join(', ')}` : `素材目录 ${deckFiles.size} 个文件`);
    const gw = await api('/api/gateway/probe');
    check('verify 固定使用 mock 网关（防止误发真实微信消息）', gw.data.mode === 'mock');
    manual('真实微信扫码登录 + 私聊收发',
      'openclaw plugins install @tencent-weixin/openclaw-weixin && openclaw channels login --channel openclaw-weixin');
    manual('多账号 dmScope 隔离', 'openclaw config set session.dmScope per-account-channel-peer');

    // ══ V5 ═══════════════════════════════════════════════
    section('V5 - 全用户直接开通与安全边界');
    const stranger = `wx_stranger_${randomBytes(3).toString('hex')}`;
    const directAccess = await api('/api/agent/inbound', {
      method: 'POST', body: JSON.stringify({ text: '我要测算一下今日运势', peerId: stranger }),
    });
    const directLink = new URL(directAccess.data.link);
    check('未申请用户首次发起今日运势即可直接取得服务端抽卡链接',
      directAccess.data.allowed === true && directAccess.data.intent === 'divination'
        && directLink.origin === PAGES_ORIGIN
        && directLink.pathname === '/TarotReader_ClawBot/'
        && directLink.searchParams.get('token') === directAccess.data.sessionToken
        && directLink.searchParams.get('api') === 'https://test-api.trycloudflare.com');

    const publicSession = await proxyRequest(`/api/session/${directAccess.data.sessionToken}`);
    check('Pages 跨域可通过代理读取本次抽卡会话',
      publicSession.ok && publicSession.data.question === '我要测算一下今日运势'
        && publicSession.headers.get('access-control-allow-origin') === PAGES_ORIGIN);
    const publicCredits = await proxyRequest(`/api/credits/${directAccess.data.sessionToken}`);
    check('公网 token 只读余额，不暴露用户历史',
      publicCredits.ok && Number.isFinite(publicCredits.data.credits)
        && !Object.hasOwn(publicCredits.data, 'history')
        && (await proxyRequest(`/api/me/${directAccess.data.sessionToken}`)).status === 404);
    const redeemAttempts = [];
    for (let i = 0; i < 6; i++) {
      redeemAttempts.push(await proxyRequest('/api/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: directAccess.data.sessionToken, code: `INVALID-${i}` }),
      }));
    }
    check('公开兑换码失败尝试按会话用户限流（每分钟 5 次）',
      redeemAttempts.slice(0, 5).every((attempt) => attempt.status === 400)
        && redeemAttempts[5].status === 429);
    const publicPreflight = await proxyRequest(`/api/draw/${directAccess.data.sessionToken}`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    check('Pages 抽牌 POST 的 CORS 预检允许 content-type',
      publicPreflight.status === 204
        && publicPreflight.headers.get('access-control-allow-origin') === PAGES_ORIGIN);
    const hiddenRoute = await proxyRequest('/api/agent/applications');
    check('公开代理拒绝内部管理接口和健康接口',
      hiddenRoute.status === 404 && (await proxyRequest('/health')).status === 404);
    const hostileOrigin = await fetch(`${PROXY_BASE}/api/session/${directAccess.data.sessionToken}`, {
      headers: { Origin: 'https://attacker.example' },
    });
    check('公开代理拒绝非 Pages 来源', hostileOrigin.status === 403);

    const applicant = `wx_apply_${randomBytes(3).toString('hex')}`;
    const application = await api('/api/agent/apply', {
      method: 'POST', body: JSON.stringify({ peerId: applicant }),
    });
    check('可选的“申请”入口仍会立即开通权限',
      application.ok && application.data.status === 'approved' && application.data.created === true
        && application.data.allowlisted === true && String(application.data.reply).includes('权限已开通'), application.data.reply);
    const duplicateApplication = await api('/api/agent/apply', {
      method: 'POST', body: JSON.stringify({ peerId: applicant }),
    });
    check('重复申请幂等，不重复执行授权',
      duplicateApplication.ok && duplicateApplication.data.status === 'approved'
        && duplicateApplication.data.created === false);
    const applications = await api('/api/agent/applications');
    check('本机操作员可查到已开通的申请审计记录',
      applications.ok && applications.data.applications.some((item) =>
        item.peerId === applicant && item.status === 'approved' && item.allowlisted === 1));

    const rlUser = `wx_rl_${randomBytes(3).toString('hex')}`;
    await api('/api/agent/whitelist', { method: 'POST', body: JSON.stringify({ peerId: rlUser }) });
    let limited = false;
    for (let i = 0; i < 8; i++) {
      const r = await api('/api/agent/inbound', {
        method: 'POST', body: JSON.stringify({ text: '抽塔罗', peerId: rlUser }),
      });
      if (typeof r.data.reply === 'string' && r.data.reply.includes('太频繁')) { limited = true; break; }
    }
    check('分钟级限流生效', limited, '连续请求后触发限流');

    // ══ V6 ═══════════════════════════════════════════════
    section('V6 - 抽牌确定性与会话生命周期');
    const { drawCards } = await import('../src/tarot.mjs');
    const a = JSON.stringify(drawCards({ seed: 'verify-seed-0001', spreadId: 'dim4-relation' }));
    const b = JSON.stringify(drawCards({ seed: 'verify-seed-0001', spreadId: 'dim4-relation' }));
    const c = JSON.stringify(drawCards({ seed: 'verify-seed-0001', spreadId: 'dim3-relation' }));
    check('同一 seed + 同一牌阵 => 结果完全可复现', a === b);
    check('不同牌阵 => 不同结果', a !== c);
    check('不同 seed => 不同结果（不可预测）',
      JSON.stringify(drawCards({ seed: 'x1', spreadId: 'celtic-cross' }))
      !== JSON.stringify(drawCards({ seed: 'x2', spreadId: 'celtic-cross' })));

    // 先测「用户没主动提占卜，但明显在问未定结果」→ 应主动询问（PRD 5.1）
    const user = `wx_life_${randomBytes(3).toString('hex')}`;
    await api('/api/agent/whitelist', { method: 'POST', body: JSON.stringify({ peerId: user }) });
    const softAsk = await api('/api/agent/inbound', {
      method: 'POST',
      body: JSON.stringify({ text: '我和他异地，冷战两周了，还有可能吗', peerId: user }),
    });
    check('未主动提占卜但问未定结果 -> 主动询问是否要占卜',
      softAsk.data.intent === 'maybe_divination' && String(softAsk.data.reply).includes('要不要我陪你抽一组牌'),
      `intent=${softAsk.data.intent} matched=${JSON.stringify(softAsk.data.matched)}`);

    check('普通闲聊不触发占卜',
      (await api('/api/agent/inbound', {
        method: 'POST', body: JSON.stringify({ text: '今天天气不错', peerId: user }),
      })).data.intent === 'chat');

    // 显式指令 -> 场景深挖 -> 出链接
    const inbound = await api('/api/agent/inbound', {
      method: 'POST',
      body: JSON.stringify({ text: '抽塔罗，我和他异地，冷战两周了，还有可能吗', peerId: user }),
    });
    const token = inbound.data.sessionToken;
    check('意图识别 + 场景深挖 + 生成带 token 的链接',
      Boolean(token) && String(inbound.data.link).includes(token),
      `domain=${inbound.data.needCard?.domain} clues=${JSON.stringify(inbound.data.needCard?.clues)} spread=${inbound.data.spreadId}`);

    const sess = await api(`/api/session/${token}`);
    check('H5 能拉取会话（含牌阵与维度）',
      sess.ok && sess.data.spread.positions.length === sess.data.spread.count);

    // ── 洗牌 / 切牌 / 滚轮选牌 ──
    const nCards = sess.data.spread.count;

    const sh = await api(`/api/shuffle/${token}`, {
      method: 'POST',
      body: JSON.stringify({ entropy: { rounds: 3, durationMs: 3200, cutPile: 1 } }),
    });
    check('洗牌阶段接受手势参数（轮数 / 时长 / 切牌位）',
      sh.ok && sh.data.deckSize === 78, `deckSize=${sh.data.deckSize} rounds=${sh.data.rounds}`);

    // 参数非法要拦住
    const badDup = await api(`/api/draw/${token}`, {
      method: 'POST', body: JSON.stringify({ picks: Array(nCards).fill(7) }),
    });
    check('重复序号被拒', badDup.status === 400, badDup.data.error);

    const badRange = await api(`/api/draw/${token}`, {
      method: 'POST', body: JSON.stringify({ picks: Array.from({ length: nCards }, (_, i) => i + 90) }),
    });
    check('超出 1–78 被拒', badRange.status === 400, badRange.data.error);

    const badCount = await api(`/api/draw/${token}`, {
      method: 'POST', body: JSON.stringify({ picks: [1, 2] }),
    });
    check('数量与牌阵不符被拒', badCount.status === 400, badCount.data.error);

    const goodPicks = Array.from({ length: nCards }, (_, i) => 5 + i * 7);
    const drawRes = await api(`/api/draw/${token}`, {
      method: 'POST', body: JSON.stringify({ picks: goodPicks }),
    });
    check('按滚轮点选的序号抽牌',
      drawRes.ok && drawRes.data.cards.length === nCards,
      drawRes.data.cards?.map((c) => `第${c.pickIndex}张→${c.name}`).join(' / '));

    check('每张牌都记录了用户点的是第几张',
      drawRes.data.cards?.every((c, i) => c.pickIndex === goodPicks[i]));

    const drawAgain = await api(`/api/draw/${token}`, { method: 'POST' });
    check('同一会话不能重复抽牌', drawAgain.status === 409, `HTTP ${drawAgain.status}`);

    const cbResponses = await Promise.all([
      api(`/api/callback/${token}`, { method: 'POST' }),
      api(`/api/callback/${token}`, { method: 'POST' }),
    ]);
    const cb = cbResponses.find((response) => response.ok) ?? cbResponses[0];
    const cbRace = cbResponses.find((response) => !response.ok) ?? cbResponses[1];
    check('抽牌完成后 H5 只收到投递状态，不收到解读正文',
      cb.ok && typeof cb.data.readingId === 'string' && !Object.hasOwn(cb.data, 'content')
        && cb.data.deliveryPending === true,
      `mode=${cb.data.mode} 待投递=${cb.data.deliveryPending}`);
    check('并发重复回调只允许生成一次解读和投递',
      cbRace.status === 409 && typeof cb.data.readingId === 'string',
      `first=${cb.status} second=${cbRace.status}`);

    const delivered = await waitDelivered(cb.data.readingId);
    check('后台投递到微信会话成功',
      delivered?.delivered === true,
      `delivered=${delivered?.delivered} note=${String(delivered?.deliveryNote ?? '').slice(0, 80)}`);

    const eventRes = await api('/api/events');
    const reqEvent = (eventRes.data.events ?? []).find((e) =>
      e.kind === 'gateway.request' && e.payload?.readingId === cb.data.readingId);
    const payload = reqEvent?.payload?.payload ?? null;
    const content = String(payload?.message ?? '');
    const paragraphs = content.split(/\n\s*\n/).filter(Boolean);
    check('微信解读按自然段保留五段逻辑且不带标题',
      paragraphs.length >= sess.data.spread.count + 4
        && !/(^|\n)\s*(?:#{1,6}\s*|(?:\*\*)?[一二三四五]、(?:总体印象|逐张解读|牌与牌之间|结论与建议|接下来))/.test(content),
      `自然段 ${paragraphs.length}，牌阵 ${sess.data.spread.count} 张`);

    check('解读覆盖每张真实抽牌及其位置（无编造、无遗漏）',
      drawRes.data.cards.every((card) => content.includes(card.name) && content.includes(card.positionLabel)));
    check('解读不再附加固定免责声明或结果标题',
      !content.includes('以上内容基于塔罗象征体系')
        && !/牌已经为你抽好了|完整解读：|你的塔罗解读/.test(content)
        && !/一定会|百分百|保证会|必然/.test(content));

    const obstacleCard = drawRes.data.cards.find((card) => /阻碍/.test(card.positionLabel));
    const obstacleParagraph = obstacleCard
      ? paragraphs.find((paragraph) => paragraph.includes(obstacleCard.positionLabel)) ?? '' : '';
    check('阻碍位的解读不会被误说成"资源"', !obstacleParagraph.includes('可以放心调用'));

    const replay = await api(`/api/callback/${token}`, { method: 'POST' });
    check('重复回调被拦截（幂等）', replay.status === 409 || replay.data.replayed === true, `HTTP ${replay.status}`);

    const consumed = await api(`/api/session/${token}`);
    check('会话用后即焚（consumed）', consumed.status === 409, `HTTP ${consumed.status}`);

    // 并发隔离
    section('V6 - 并发隔离（20 组）');
    const peers = Array.from({ length: 20 }, (_, i) => `wx_cc_${i}_${randomBytes(2).toString('hex')}`);
    await Promise.all(peers.map((p) =>
      api('/api/agent/whitelist', { method: 'POST', body: JSON.stringify({ peerId: p }) })));
    const runs = await Promise.all(peers.map(async (p) => {
      const inb = await api('/api/agent/inbound', {
        method: 'POST', body: JSON.stringify({ text: '抽塔罗', peerId: p }),
      });
      const t = inb.data.sessionToken;
      await api(`/api/draw/${t}`, { method: 'POST' });
      const done = await api(`/api/callback/${t}`, { method: 'POST' });
      const del = await waitDelivered(done.data.readingId);
      const me = await api(`/api/me/${t}`);
      return { delivered: del?.delivered === true, historyCount: me.data.history?.length ?? 0 };
    }));
    check('20 组并发全部投递成功', runs.every((r) => r.delivered));
    check('每个用户只看到自己的记录（无串号）',
      runs.every((r) => r.historyCount === 1),
      `历史条数集合: ${[...new Set(runs.map((r) => r.historyCount))].join(',')}`);

    // ══ V3 ═══════════════════════════════════════════════
    section('V3 - 后端主动投递进微信会话（PRD 4.1 第 6 步）');
    const detail = await api(`/api/reading/${cb.data.readingId}`);
    check('H5 投递状态查询不返回解读正文、牌面或 Gateway 消息',
      detail.ok && !Object.hasOwn(detail.data, 'content') && !Object.hasOwn(detail.data, 'cards')
        && !Object.hasOwn(detail.data, 'gatewayRequest') && !Object.hasOwn(detail.data, 'deliveryNote'));
    check('已构造 hooks/agent payload', Boolean(payload));
    check('payload 含 channel + to（官方文档要求的直投条件）',
      Boolean(payload?.channel && payload?.to),
      `channel=${payload?.channel} to=${String(payload?.to).slice(0, 20)}`);
    check('deliver=true / waitForCompletion=true 已设置',
      payload?.deliver === true && payload?.waitForCompletion === true);
    manual('真实投递到手机微信（最关键的一步）',
      '把 .env 改成 GATEWAY_MODE=live + 真实 HOOK_TOKEN 后重跑；或手动执行:\n        '
      + renderManualCurl(payload, cb.data.readingId));

    // ══ V2 / V4 ══════════════════════════════════════════
    section('V2 - 微信外链可点性（需真机）');
    manual('GitHub Pages 链接在微信里是否可点、是否被拦', '部署成功后用两个微信号互测；抽牌 API 需同时保持本机 Quick Tunnel 在线');
    manual('微信内置浏览器渲染 H5 是否正常', '手机微信里打开链接，检查翻牌动画与布局');

    section('V4 - 微信消息长度限制（需真机）');
    const msgLen = content.length + 120;
    check('已记录当前解读的发送长度', true, `约 ${msgLen} 字（含投递协议开销）`);
    manual('实测微信单条消息截断临界值', '让 Agent 依次发 200/500/1000/2000 字，记录从哪档开始截断');
    manual('确认是否需要拆条发送', `若临界值 < ${msgLen}，五段式解读需拆成 3-4 条`);

  } finally {
    if (proxy && !proxy.killed) proxy.kill('SIGTERM');
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
      if (existsSync(f)) { try { rmSync(f); } catch { /* ignore */ } }
    }
    if (existsSync(PAGES_TEST_DIR)) { try { rmSync(PAGES_TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  console.log('\n' + '-'.repeat(62));
  console.log(C.bold(`  自动通过 ${R.pass}   自动失败 ${R.fail}   待真机 ${R.manual}`));
  if (R.fail === 0) {
    console.log(C.pass('\n  自动化部分全部通过'));
    console.log('  剩下 V2 / V3 真实投递 / V4 需要真机与在线本机服务验证。');
    console.log('  自动测试不连接真实微信、Gateway 或 Cloudflare tunnel。\n');
  } else {
    console.log(C.fail('\n  有失败项，先修完再继续。\n'));
  }
  process.exit(R.fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n验证脚本异常：', err);
  process.exit(1);
});
