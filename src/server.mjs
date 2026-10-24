import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db, now, uid, logEvent, findOrCreateBinding, setAllowlisted, getUser,
  createSession, getSession, expireSessions, saveDraw, getDraw, saveReading,
  saveShuffle,
  updateReadingDelivery, getReading,
  historyFor, credit, redeemCode, idempotencyGet, idempotencySet, rateLimit,
  applyForAccess, listApplications, DB_PATH,
} from './db.mjs';
import {
  SPREADS, SPREADS_BY_ID, CARDS, CARDS_BY_ID,
  drawCards, enrichDraw, newSeed, detectIntent, buildNeedCard, pickSpread, formatCardsForMessage,
  cleanQuestion, mixEntropy, shuffleDeck, pickFromDeck, DECK_SIZE,
} from './tarot.mjs';
import { renderTemplateReading, normalizeReadingOutput, buildPrompt, callLLM } from './reading.mjs';
import { deliverToWechat, gatewayConfig, probeGateway, buildHookPayload } from './gateway.mjs';

// 读取 demo/.env（Node 内置，不需要 dotenv）
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* 没有 .env 就用默认值 */ }

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO = resolve(ROOT, '..');
const PUBLIC_DIR = join(ROOT, 'public');

const PORT = Number(process.env.PORT ?? 8787);
// 默认只监听回环地址。要让手机访问（真机验证翻牌动画）时设 HOST=0.0.0.0
const HOST = process.env.HOST ?? '127.0.0.1';
const BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const PUBLIC_H5_BASE_URL = String(process.env.PUBLIC_H5_BASE_URL ?? '').trim();
const PUBLIC_API_BASE_URL = String(process.env.PUBLIC_API_BASE_URL ?? '').trim();
const TTL_MIN = Number(process.env.SESSION_TTL_MINUTES ?? 10);
const RATE_MIN = Number(process.env.RATE_PER_MINUTE ?? 5);
const RATE_DAY = Number(process.env.RATE_PER_DAY ?? 30);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── 工具 ────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const json = (res, status, obj, headers) => send(res, status, obj, headers);

function drawLinkFor(token) {
  if (!PUBLIC_H5_BASE_URL) return `${BASE_URL}/s/${encodeURIComponent(token)}`;
  if (!PUBLIC_API_BASE_URL) throw new Error('Pages link mode requires PUBLIC_API_BASE_URL.');

  const page = new URL(PUBLIC_H5_BASE_URL);
  const api = new URL(PUBLIC_API_BASE_URL);
  const localApi = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
  const githubPages = page.hostname.endsWith('.github.io');
  const quickTunnel = api.protocol === 'https:'
    && api.hostname.endsWith('.trycloudflare.com') && !api.port;
  if (page.protocol !== 'https:' || page.username || page.password || page.search || page.hash) {
    throw new Error('PUBLIC_H5_BASE_URL must be a clean HTTPS page URL.');
  }
  if ((githubPages && !quickTunnel)
      || (!githubPages && !localApi && api.protocol !== 'https:')
      || api.username || api.password || api.search || api.hash) {
    throw new Error('PUBLIC_API_BASE_URL must be HTTPS (or loopback for local testing).');
  }
  page.searchParams.set('token', token);
  page.searchParams.set('api', api.origin);
  return page.toString();
}

function isLoopbackRequest(req) {
  const remote = String(req.socket.remoteAddress ?? '').toLowerCase();
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求体不是合法 JSON'); }
}

async function serveStatic(res, urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  const full = join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const s = await stat(full);
    if (!s.isFile()) throw new Error('not a file');
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': extname(full) === '.jpg' ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

// ── 生成解读（快）────────────────────────────────────────
async function generateReading({ spreadId, draw, question, needCard }) {
  const mode0 = process.env.READING_MODE ?? 'template';
  let content = null;
  let model = null;
  let mode = mode0;

  if (mode0 === 'llm' && process.env.OPENAI_API_KEY) {
    try {
      const prompt = buildPrompt({ draw, spreadId, needCard, question });
      model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
      content = await callLLM({
        prompt, model,
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      });
    } catch (err) {
      logEvent('reading.llm_failed', { error: err.message });
      content = null;
    }
  }
  if (!content) {
    mode = 'template';
    content = renderTemplateReading({ draw, spreadId, needCard, question }).content;
  }
  content = normalizeReadingOutput(content);
  if (!content) {
    mode = 'template';
    content = renderTemplateReading({ draw, spreadId, needCard, question }).content;
  }
  return { content, mode, model };
}

// ── 投递回微信（慢，放后台）──────────────────────────────
// 这一跳要等 agent 跑完整轮 LLM 生成，实测 40~90 秒。
// 如果让 H5 同步等，用户会以为页面卡死 —— 所以放后台，前端轮询状态。
async function deliverReading({ readingId, session, content, idempotencyKey }) {
  const message = content;

  const { payload } = buildHookPayload({
    peerId: session.peer_id,
    accountId: session.account_id,
    message,
    idempotencyKey,
  });
  logEvent('gateway.request', { readingId, mode: gatewayConfig().mode, payload });

  const delivery = await deliverToWechat({
    peerId: session.peer_id,
    accountId: session.account_id,
    message,
    idempotencyKey,
  });

  updateReadingDelivery(readingId, { delivered: delivery.delivered, deliveryNote: delivery.note });
  logEvent('reading.delivered', {
    readingId, gatewayMode: delivery.mode, delivered: delivery.delivered,
  });
  return delivery;
}

// ── 事件流（demo 控制台用）──────────────────────────────
function recentEvents(limit = 40) {
  return db.prepare('SELECT kind, payload, created_at FROM events ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}

// ── 路由 ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;

  try {
    // ── 静态资源 ──
    if (p === '/' || p === '/index.html') return serveStatic(res, '/index.html');
    // 浏览器会默认请求 favicon，别让它污染控制台报错
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p.startsWith('/static/')) return serveStatic(res, p);
    if (p.startsWith('/deck/')) return serveStatic(res, p);
    if (p.startsWith('/s/')) return serveStatic(res, '/draw.html');

    // ── 微信扫码登录页（demo 辅助功能）──
    // 二维码约 1 分钟过期，页面每 2 秒对齐一次状态，并且会如实报告
    // "正在刷新 / 已登录成功 / 刷新器没在跑" 三种情况，不会拿死码骗人。
    if (p === '/qr') return serveStatic(res, '/qr.html');
    // 仪式交互预览：不绑定 token；正式 /s/:token 共用同一套仪式前端。
    if (p === '/play') return serveStatic(res, '/play.html');
    // 预览用牌面目录；正式会话以 /api/draw/:token 返回的服务端结果为准。
    if (p === '/api/cards' && req.method === 'GET') {
      return json(res, 200, { cards: CARDS.map(({ id, name, img }) => ({ id, name, img })) });
    }
    if (p === '/wechat-login-qr.png') {
      try {
        const data = await readFile(join(REPO, 'wechat-login-qr.png'));
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
          'X-Qr-Mtime': String((await stat(join(REPO, 'wechat-login-qr.png'))).mtimeMs),
        });
        return res.end(data);
      } catch { return send(res, 404, 'Not found'); }
    }

    // 二维码新鲜度：脚本停了页面就看不出来，所以单独给个状态接口
    if (p === '/api/qr-status') {
      let ageSec = null;
      try {
        const s = await stat(join(REPO, 'wechat-login-qr.png'));
        ageSec = Math.round((Date.now() - s.mtimeMs) / 1000);
      } catch { /* 还没有图片 */ }
      return json(res, 200, {
        hasImage: ageSec !== null,
        ageSec,
        // 二维码约 60 秒过期；超过 90 秒没刷新就认为刷新器已经停了
        live: ageSec !== null && ageSec < 90,
        loggedIn: existsSync(join(REPO, '.secrets/wechat-login-ok')),
        loggedInAt: existsSync(join(REPO, '.secrets/wechat-login-ok'))
          ? (await readFile(join(REPO, '.secrets/wechat-login-ok'), 'utf8')).trim()
          : null,
      });
    }

    if (p === '/health') {
      return json(res, 200, {
        ok: true, db: DB_PATH,
        cards: CARDS.length, spreads: SPREADS.length, agentClassify: 1, agentApplications: 2,
        publicPages: Number(Boolean(PUBLIC_H5_BASE_URL && PUBLIC_API_BASE_URL)),
        gateway: gatewayConfig().mode,
        reading: process.env.READING_MODE ?? 'template',
      });
    }

    // ══════════════════════════════════════════════════
    // 微信侧（由 OpenClaw Agent 调用）
    // ══════════════════════════════════════════════════

    // 本机只读分类：供 Gateway 插件在模型调度前判断意图，不写会话、限流或日志。
    if (p === '/api/agent/classify' && req.method === 'POST') {
      if (!isLoopbackRequest(req)) return json(res, 403, { error: '此接口仅限本机 Gateway 调用' });
      const body = await readBody(req, 16_384);
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return json(res, 400, { error: '缺少 text' });
      }
      const intent = detectIntent(body.text);
      return json(res, 200, { intent: intent.intent, prompt: intent.prompt ?? null });
    }

    // 本机 Gateway 的真实入站消息；有效请求首次到达时自动开通权限。
    if (p === '/api/agent/inbound' && req.method === 'POST') {
      if (!isLoopbackRequest(req)) return json(res, 403, { error: '此接口仅限本机 Gateway 调用' });
      const body = await readBody(req);
      const { text = '', peerId, nickname, channel = 'openclaw-weixin', accountId = '', domain, clues } = body;
      if (!peerId) return json(res, 400, { error: '缺少 peerId（微信用户标识）' });

      const binding = findOrCreateBinding({ channel, accountId, peerId, nickname });
      expireSessions();
      if (!binding.allowlisted) {
        setAllowlisted(peerId, true, { channel, accountId });
      }

      const rl = rateLimit(peerId, { perMinute: RATE_MIN, perDay: RATE_DAY });
      if (!rl.ok) {
        logEvent('inbound.ratelimited', { peerId, text });
        return json(res, 200, { allowed: true, reply: rl.reason });
      }

      const intent = detectIntent(text);
      logEvent('inbound.message', { peerId, text, intent: intent.intent });

      // 非占卜意图
      if (intent.intent === 'chat') {
        return json(res, 200, {
          allowed: true, intent: 'chat', userId: binding.user_id,
          reply: '我在的。有什么想聊的都可以说，也可以随时跟我说「抽塔罗」，我陪你看看现在这件事。',
        });
      }

      // 迷茫但没主动提占卜 → 主动询问（PRD 5.1）
      if (intent.intent === 'maybe_divination') {
        return json(res, 200, {
          allowed: true, intent: 'maybe_divination', userId: binding.user_id,
          reply: intent.prompt,
        });
      }

      // 占卜意图 → 深挖场景 → 出链接
      const question = cleanQuestion(text);
      const needCard = buildNeedCard({ text: question, domain, clues });
      const spreadId = pickSpread(needCard.dimensions, needCard.domain);
      const spread = SPREADS_BY_ID.get(spreadId);

      const session = createSession({
        userId: binding.user_id, peerId, channel, accountId,
        question, needCard, spreadId, ttlMinutes: TTL_MIN,
      });

      const link = drawLinkFor(session.token);
      const dims = needCard.dimensions.join(' / ');
      const reply = [
        `我梳理了一下：你问的是「${needCard.domain}」这块的事。`,
        needCard.clues.length ? `我注意到的线索：${needCard.clues.join('、')}。` : null,
        `我准备了「${spread.name}」，从 ${needCard.dimensions.length} 个角度看：${dims}。`,
        ``,
        `点这里抽牌（${TTL_MIN} 分钟内有效）：${link}`,
        `抽完我会直接把解读发回这里。`,
      ].filter((l) => l !== null).join('\n');

      return json(res, 200, {
        allowed: true, intent: 'divination', userId: binding.user_id,
        sessionToken: session.token, spreadId, link, needCard, reply,
      });
    }

    // 可选申请入口；无需申请的用户也会在首次有效占卜请求时自动开通。
    if (p === '/api/agent/apply' && req.method === 'POST') {
      if (!isLoopbackRequest(req)) return json(res, 403, { error: '此接口仅限本机 Gateway 调用' });
      const body = await readBody(req, 16_384);
      const peerId = typeof body.peerId === 'string' ? body.peerId.trim() : '';
      if (!peerId) return json(res, 400, { error: '缺少 peerId' });
      const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
      const result = applyForAccess({ channel: 'openclaw-weixin', accountId, peerId });
      const reply = result.created
        ? '申请已通过，抽卡权限已开通。现在可以直接告诉我你想测算什么。'
        : '你已经有抽卡权限，可以直接告诉我你想测算什么。';
      return json(res, 200, {
        ok: true, status: result.status, created: result.created, allowlisted: true, reply,
      });
    }

    // 仅本机操作员可以查看申请审计记录及 peer ID；不在用户回复中暴露。
    if (p === '/api/agent/applications' && req.method === 'GET') {
      if (!isLoopbackRequest(req)) return json(res, 403, { error: '此接口仅限本机操作员查看' });
      return json(res, 200, { applications: listApplications(100) });
    }

    // 管理：放行/封禁
    if (p === '/api/agent/whitelist' && req.method === 'POST') {
      if (!isLoopbackRequest(req)) return json(res, 403, { error: '此接口仅限本机操作员调用' });
      const { peerId, allow = true, channel = 'openclaw-weixin', accountId = '' } = await readBody(req);
      if (!peerId) return json(res, 400, { error: '缺少 peerId' });
      // 确保绑定存在
      findOrCreateBinding({ channel, accountId, peerId });
      setAllowlisted(peerId, allow, { channel, accountId });
      return json(res, 200, { ok: true, peerId, allowlisted: allow });
    }

    // ══════════════════════════════════════════════════
    // 网页侧
    // ══════════════════════════════════════════════════

    // 会话信息（H5 打开时拉取）
    const sessionMatch = p.match(/^\/api\/session\/(.+)$/);
    if (sessionMatch && req.method === 'GET') {
      expireSessions();
      const s = getSession(decodeURIComponent(sessionMatch[1]));
      if (!s) return json(res, 404, { error: '会话不存在或链接已失效' });
      if (s.status === 'expired') return json(res, 410, { error: '这个链接已经过期了，回微信重新发一次「抽塔罗」就好' });
      if (s.status === 'consumed') return json(res, 409, { error: '这个链接已经用过了，回微信重新发一次「抽塔罗」' });

      const spread = SPREADS_BY_ID.get(s.spread_id);
      return json(res, 200, {
        status: s.status,
        deckSize: DECK_SIZE,
        question: s.question,
        needCard: JSON.parse(s.need_card),
        spread,
        expiresAt: s.expires_at,
        remainingMs: Math.max(0, s.expires_at - now()),
        creditCost: spread.creditCost,
        userCredits: getUser(s.user_id).credits,
      });
    }

    // ── 洗牌：把用户的手势折进 seed，牌序落库 ──
    // 前端「长按洗牌 → 切牌」结束后调这里。
    const shuffleMatch = p.match(/^\/api\/shuffle\/(.+)$/);
    if (shuffleMatch && req.method === 'POST') {
      const s = getSession(decodeURIComponent(shuffleMatch[1]));
      if (!s) return json(res, 404, { error: '会话不存在' });
      if (s.expires_at < now()) {
        db.prepare("UPDATE draw_sessions SET status='expired' WHERE token=?").run(s.token);
        return json(res, 410, { error: '链接已过期' });
      }
      if (s.status === 'drawn' || s.status === 'consumed') {
        return json(res, 409, { error: '这一局已经抽过了' });
      }

      const body = await readBody(req).catch(() => ({}));
      const entropy = body.entropy ?? {};
      const seed = newSeed();
      const effective = mixEntropy(seed, entropy);
      const deck = shuffleDeck(effective, s.spread_id);

      saveShuffle(s.token, { seed, deck, entropy });
      logEvent('shuffle.done', {
        token: s.token.slice(0, 8),
        rounds: entropy.rounds ?? 0,
        durationMs: entropy.durationMs ?? 0,
        cutPile: entropy.cutPile ?? null,
      });

      return json(res, 200, {
        ok: true,
        deckSize: DECK_SIZE,
        rounds: entropy.rounds ?? 0,
        message: '牌已洗匀',
      });
    }

    // ── 抽牌：用户已在滚轮上点好序号，这里只做「取第几张」──
    const drawMatch = p.match(/^\/api\/draw\/(.+)$/);
    if (drawMatch && req.method === 'POST') {
      const s = getSession(decodeURIComponent(drawMatch[1]));
      if (!s) return json(res, 404, { error: '会话不存在' });
      if (s.expires_at < now()) {
        db.prepare("UPDATE draw_sessions SET status='expired' WHERE token=?").run(s.token);
        return json(res, 410, { error: '链接已过期' });
      }
      if (s.status === 'drawn' || s.status === 'consumed') {
        return json(res, 409, { error: '该会话已抽过牌或已失效' });
      }

      const spread = SPREADS_BY_ID.get(s.spread_id);
      const user = getUser(s.user_id);
      if (spread.creditCost > user.credits) {
        return json(res, 402, { error: `点数不足，「${spread.name}」需要 ${spread.creditCost} 点，你还有 ${user.credits} 点。` });
      }

      // 没走过洗牌阶段就自动补一个（兼容旧流程与自动化测试）
      let sess = s;
      if (!sess.deck) {
        const seed0 = newSeed();
        const deck0 = shuffleDeck(mixEntropy(seed0, {}), s.spread_id);
        sess = saveShuffle(s.token, { seed: seed0, deck: deck0, entropy: {} });
      }

      const body = await readBody(req).catch(() => ({}));
      const deck = JSON.parse(sess.deck);
      const seed = sess.seed;

      // 用户点选的序号；没给就按顺序取前 n 张
      let picks = Array.isArray(body.picks) ? body.picks.map(Number) : null;
      if (!picks || picks.length === 0) {
        picks = Array.from({ length: spread.count }, (_, i) => i + 1);
      }
      if (picks.length !== spread.count) {
        return json(res, 400, { error: `需要选 ${spread.count} 张，收到 ${picks.length} 张` });
      }
      if (new Set(picks).size !== picks.length) {
        return json(res, 400, { error: '不能重复选同一张牌' });
      }
      if (picks.some((n) => !Number.isInteger(n) || n < 1 || n > DECK_SIZE)) {
        return json(res, 400, { error: `序号必须在 1–${DECK_SIZE} 之间` });
      }

      const raw = pickFromDeck(deck, picks, seed);
      const drawId = saveDraw({
        sessionToken: s.token, userId: s.user_id, spreadId: s.spread_id, seed,
        cards: raw.map((c) => ({
          cardId: c.cardId, reversed: c.reversed,
          positionIndex: c.positionIndex, pickIndex: c.pickIndex,
        })),
      });
      db.prepare("UPDATE draw_sessions SET status='drawn' WHERE token=?").run(s.token);

      if (spread.creditCost > 0) credit(s.user_id, -spread.creditCost, 'draw', drawId);
      logEvent('draw.created', { drawId, spreadId: s.spread_id, seed: seed.slice(0, 8), picks });

      const enriched = enrichDraw(raw, s.spread_id);
      return json(res, 200, {
        drawId, seed, spread,
        cards: enriched.map((c) => ({
          positionIndex: c.positionIndex, position: c.position, positionLabel: c.positionLabel,
          cardId: c.cardId, name: c.name, nameEn: c.nameEn, reversed: c.reversed,
          keywords: c.keywords, img: c.img, arcana: c.arcana, suit: c.suit,
          pickIndex: c.pickIndex,
        })),
      });
    }

    // 抽牌完成回调 → 生成解读 → 投递回微信
    const cbMatch = p.match(/^\/api\/callback\/(.+)$/);
    if (cbMatch && req.method === 'POST') {
      const token = decodeURIComponent(cbMatch[1]);
      const s = getSession(token);
      if (!s) return json(res, 404, { error: '会话不存在' });
      if (s.status === 'consumed') return json(res, 409, { error: '已经处理过了' });
      if (s.status === 'processing') return json(res, 409, { error: '解读正在生成，请稍后查看微信' });
      if (s.status !== 'drawn') return json(res, 409, { error: '还没有抽牌' });
      if (s.expires_at < now()) {
        db.prepare("UPDATE draw_sessions SET status='expired' WHERE token=? AND status='drawn'").run(token);
        return json(res, 410, { error: '链接已过期' });
      }

      const drawRow = db.prepare('SELECT * FROM draws WHERE session_token = ? ORDER BY created_at DESC LIMIT 1').get(token);
      if (!drawRow) return json(res, 404, { error: '找不到抽牌记录' });

      const idempotencyKey = `draw_${drawRow.id}`;
      const cached = idempotencyGet(idempotencyKey);
      if (cached) return json(res, 200, { ...cached, replayed: true, gatewayMode: gatewayConfig().mode });

      const draw = JSON.parse(drawRow.cards);
      const needCard = JSON.parse(s.need_card);

      // 抢占回调。公开 tunnel 上相同 token 可能被并发提交；必须在任何 await 前原子锁住，防止重复 LLM 费用/微信投递。
      const claimed = db.prepare(
        "UPDATE draw_sessions SET status='processing', consumed_at=? WHERE token=? AND status='drawn'",
      ).run(now(), token);
      if (claimed.changes !== 1) return json(res, 409, { error: '解读已开始处理，请稍后查看微信' });

      // 在服务端生成供微信投递的解读；H5 只收到 readingId 和投递状态
      let gen;
      try {
        gen = await generateReading({
          spreadId: s.spread_id, draw, question: s.question, needCard,
        });
      } catch (error) {
        db.prepare("UPDATE draw_sessions SET status='drawn', consumed_at=NULL WHERE token=? AND status='processing'").run(token);
        throw error;
      }
      const readingId = saveReading({
        drawId: drawRow.id, mode: gen.mode, model: gen.model,
        content: gen.content, delivered: false, deliveryNote: 'pending',
      });

      db.prepare("UPDATE draw_sessions SET status='consumed', consumed_at=? WHERE token=?").run(now(), token);
      logEvent('session.consumed', { token: token.slice(0, 8) });
      idempotencySet(idempotencyKey, { readingId, mode: gen.mode, gatewayMode: gatewayConfig().mode });

      // 投递回微信放在后台跑，不阻塞用户页面
      deliverReading({
        readingId, session: s,
        content: gen.content,
        idempotencyKey,
      }).catch((err) => {
        updateReadingDelivery(readingId, { delivered: false, deliveryNote: `后台投递异常：${err.message}` });
        logEvent('reading.delivery_error', { readingId, error: err.message });
      });

      return json(res, 200, {
        ok: true,
        readingId,
        mode: gen.mode,
        delivered: false,
        deliveryPending: true,
        gatewayMode: gatewayConfig().mode,
      });
    }

    // 抽卡 H5 的余额小接口；不返回历史记录，避免分享链接暴露用户过往牌面。
    const creditsMatch = p.match(/^\/api\/credits\/(.+)$/);
    if (creditsMatch && req.method === 'GET') {
      const s = getSession(decodeURIComponent(creditsMatch[1]));
      if (!s) return json(res, 404, { error: '会话不存在' });
      return json(res, 200, { credits: getUser(s.user_id).credits });
    }

    // 本机个人中心（完整历史只供本机页面使用）
    const meMatch = p.match(/^\/api\/me\/(.+)$/);
    if (meMatch && req.method === 'GET') {
      const s = getSession(decodeURIComponent(meMatch[1]));
      if (!s) return json(res, 404, { error: '会话不存在' });
      const user = getUser(s.user_id);
      return json(res, 200, {
        userId: user.id,
        credits: user.credits,
        history: historyFor(user.id, 20).map((h) => ({
          id: h.id, spreadId: h.spread_id, question: h.question,
          createdAt: h.created_at, hasReading: Boolean(h.content),
          cards: JSON.parse(h.cards).map((c) => ({
            ...c, name: CARDS_BY_ID.get(c.cardId)?.name,
          })),
        })),
      });
    }

    // 兑换码
    if (p === '/api/redeem' && req.method === 'POST') {
      const { token, code } = await readBody(req);
      const s = getSession(token);
      if (!s) return json(res, 404, { error: '会话不存在' });
      const limit = rateLimit(s.user_id, { perMinute: 5, perDay: 30 });
      if (!limit.ok) return json(res, 429, { error: limit.reason });
      const r = redeemCode(String(code ?? '').trim().toUpperCase(), s.user_id);
      return json(res, r.ok ? 200 : 400, r);
    }

    // 管理 / 调试
    if (p === '/api/events' && req.method === 'GET') {
      if (!isLoopbackRequest(req)) return json(res, 403, { error: '仅本机可查看调试事件' });
      return json(res, 200, { events: recentEvents(60) });
    }
    if (p === '/api/spreads' && req.method === 'GET') return json(res, 200, { spreads: SPREADS });
    if (p === '/api/cards' && req.method === 'GET') return json(res, 200, { cards: CARDS.map(({ upright, reversed, ...c }) => c) });
    if (p === '/api/gateway/probe' && req.method === 'GET') return json(res, 200, await probeGateway());

    const readMatch = p.match(/^\/api\/reading\/(.+)$/);
    if (readMatch && req.method === 'GET') {
      const r = db.prepare(
        'SELECT id, mode, delivered, delivery_note FROM readings WHERE id = ?',
      ).get(decodeURIComponent(readMatch[1]));
      if (!r) return json(res, 404, { error: '解读不存在' });

      return json(res, 200, {
        readingId: r.id,
        mode: r.mode,
        delivered: Boolean(r.delivered),
        deliveryPending: r.delivery_note === 'pending',
      });
    }

    send(res, 404, 'Not found');
  } catch (err) {
    logEvent('server.error', { path: p, error: err.message });
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = gatewayConfig();
  console.log('');
  console.log('  🔮  塔罗 ClawBot Demo');
  console.log('  ───────────────────────────────────────────');
  console.log(`  监听                  ${HOST}:${PORT}`);
  console.log(`  控制台（模拟微信侧）  ${BASE_URL}/`);
  console.log(`  健康检查              ${BASE_URL}/health`);
  console.log(`  数据库                ${DB_PATH}`);
  console.log(`  网关模式              ${cfg.mode}${cfg.mode === 'mock' ? '（未真实发送，仅打印 payload）' : ` → ${cfg.url}`}`);
  console.log(`  解读模式              ${process.env.READING_MODE ?? 'template'}`);
  console.log(`  牌库                  ${CARDS.length} 张 / ${SPREADS.length} 种牌阵`);
  if (HOST === '127.0.0.1') console.log('  ℹ️  手机访问请用 HOST=0.0.0.0 启动');
  console.log('');
});
