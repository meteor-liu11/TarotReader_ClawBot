import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

const DB_PATH = resolve(process.env.DB_PATH ?? './data/demo.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    credits     INTEGER NOT NULL DEFAULT 0,
    is_minor    INTEGER NOT NULL DEFAULT 0
  );

  -- ⚠️ 显式白名单：不依赖微信插件的默认放行行为
  CREATE TABLE IF NOT EXISTS wechat_bindings (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    channel     TEXT NOT NULL,
    account_id  TEXT NOT NULL DEFAULT '',
    peer_id     TEXT NOT NULL,
    nickname    TEXT,
    allowlisted INTEGER NOT NULL DEFAULT 0,
    waitlist_status TEXT NOT NULL DEFAULT 'none',
    waitlist_requested_at INTEGER,
    created_at  INTEGER NOT NULL,
    UNIQUE(channel, account_id, peer_id)
  );

  CREATE TABLE IF NOT EXISTS draw_sessions (
    token        TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    peer_id      TEXT NOT NULL,
    channel      TEXT NOT NULL,
    account_id   TEXT NOT NULL DEFAULT '',
    question     TEXT,
    need_card    TEXT NOT NULL,
    spread_id    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    expires_at   INTEGER NOT NULL,
    consumed_at  INTEGER,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS draws (
    id            TEXT PRIMARY KEY,
    session_token TEXT NOT NULL REFERENCES draw_sessions(token),
    user_id       TEXT NOT NULL,
    spread_id     TEXT NOT NULL,
    seed          TEXT NOT NULL,
    cards         TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS readings (
    id            TEXT PRIMARY KEY,
    draw_id       TEXT NOT NULL REFERENCES draws(id),
    mode          TEXT NOT NULL,
    model         TEXT,
    content       TEXT NOT NULL,
    delivered     INTEGER NOT NULL DEFAULT 0,
    delivery_note TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_ledger (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    delta         INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    ref_id        TEXT,
    balance_after INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS redeem_codes (
    code        TEXT PRIMARY KEY,
    batch_id    TEXT NOT NULL,
    credits     INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'unused',
    used_by     TEXT,
    used_at     INTEGER,
    expires_at  INTEGER,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency (
    key         TEXT PRIMARY KEY,
    response    TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    payload     TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user   ON draw_sessions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_draws_user      ON draws(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ledger_user     ON credit_ledger(user_id, created_at DESC);
`);

export const now = () => Date.now();
export const uid = () => randomUUID();
export const newToken = () => randomBytes(32).toString('base64url');

/** 轻量迁移：给已存在的表补列（重复执行安全） */
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

addColumnIfMissing('wechat_bindings', 'waitlist_status', "TEXT NOT NULL DEFAULT 'none'");
addColumnIfMissing('wechat_bindings', 'waitlist_requested_at', 'INTEGER');

// 洗牌 / 切牌阶段产生的手势与牌序，都要落库以便复现
addColumnIfMissing('draw_sessions', 'seed', 'TEXT');
addColumnIfMissing('draw_sessions', 'deck', 'TEXT');
addColumnIfMissing('draw_sessions', 'entropy', 'TEXT');
addColumnIfMissing('draw_sessions', 'shuffled_at', 'INTEGER');

export function logEvent(kind, payload) {
  db.prepare('INSERT INTO events (id, kind, payload, created_at) VALUES (?,?,?,?)')
    .run(uid(), kind, JSON.stringify(payload ?? null), now());
}

// New policy: a user who explicitly applies is granted access immediately.
const legacyApprovals = db.prepare(
  `UPDATE wechat_bindings
      SET allowlisted = 1, waitlist_status = 'approved'
    WHERE waitlist_status = 'pending'`,
).run();
if (legacyApprovals.changes > 0) {
  logEvent('application.legacy_auto_approved', { count: legacyApprovals.changes });
}

// ── 用户 & 绑定 ─────────────────────────────────────────
export function findOrCreateBinding({ channel, accountId = '', peerId, nickname }) {
  const existing = db.prepare(
    'SELECT * FROM wechat_bindings WHERE channel = ? AND account_id = ? AND peer_id = ?',
  ).get(channel, accountId, peerId);
  if (existing) return existing;

  // 新用户赠送体验点数（否则高级牌阵一上来就付不了费，转化会崩）
  const welcome = Number(process.env.WELCOME_CREDITS ?? 5);
  const userId = uid();
  const ts = now();
  db.prepare('INSERT INTO users (id, created_at, credits) VALUES (?,?,?)').run(userId, ts, welcome);
  if (welcome > 0) {
    db.prepare(
      'INSERT INTO credit_ledger (id, user_id, delta, reason, ref_id, balance_after, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(uid(), userId, welcome, 'welcome', null, welcome, ts);
  }
  const id = uid();
  // 新绑定初始关闭；本机真实入站请求到达时会自动授权。
  db.prepare(
    `INSERT INTO wechat_bindings (id, user_id, channel, account_id, peer_id, nickname, allowlisted, created_at)
     VALUES (?,?,?,?,?,?,0,?)`,
  ).run(id, userId, channel, accountId, peerId, nickname ?? null, ts);
  logEvent('binding.created', { channel, accountId, peerId, userId, welcomeCredits: welcome });
  return db.prepare('SELECT * FROM wechat_bindings WHERE id = ?').get(id);
}

export function setAllowlisted(peerId, allowlisted, { channel = 'openclaw-weixin', accountId = '' } = {}) {
  const info = db.prepare(
    `UPDATE wechat_bindings
        SET allowlisted = ?,
            waitlist_status = CASE WHEN ? = 1 THEN 'approved'
                                   WHEN waitlist_status = 'approved' THEN 'revoked'
                                   ELSE waitlist_status END
      WHERE channel = ? AND account_id = ? AND peer_id = ?`,
  ).run(allowlisted ? 1 : 0, allowlisted ? 1 : 0, channel, accountId, peerId);
  logEvent('binding.allowlist', { peerId, allowlisted });
  return info.changes > 0;
}

export function applyForAccess({ channel = 'openclaw-weixin', accountId = '', peerId }) {
  const binding = findOrCreateBinding({ channel, accountId, peerId });
  const created = !binding.allowlisted;
  const ts = now();
  db.prepare(
    `UPDATE wechat_bindings
        SET allowlisted = 1,
            waitlist_status = 'approved',
            waitlist_requested_at = COALESCE(waitlist_requested_at, ?)
      WHERE id = ?`,
  ).run(ts, binding.id);
  const updated = db.prepare('SELECT waitlist_requested_at FROM wechat_bindings WHERE id = ?').get(binding.id);
  if (created) logEvent('application.auto_approved', { channel, accountId, status: 'approved' });
  return { status: 'approved', created, requestedAt: updated.waitlist_requested_at };
}

export function listApplications(limit = 100) {
  return db.prepare(
    `SELECT channel, account_id AS accountId, peer_id AS peerId,
            waitlist_status AS status, allowlisted,
            waitlist_requested_at AS requestedAt
       FROM wechat_bindings
      WHERE waitlist_requested_at IS NOT NULL
      ORDER BY waitlist_requested_at ASC
      LIMIT ?`,
  ).all(limit);
}

export function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

// ── 会话 ────────────────────────────────────────────────
export function createSession({ userId, peerId, channel, accountId, question, needCard, spreadId, ttlMinutes }) {
  const token = newToken();
  const ts = now();
  db.prepare(
    `INSERT INTO draw_sessions (token, user_id, peer_id, channel, account_id, question, need_card, spread_id, status, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
  ).run(token, userId, peerId, channel, accountId, question ?? '', JSON.stringify(needCard),
    spreadId, ts + ttlMinutes * 60_000, ts);
  logEvent('session.created', { token: token.slice(0, 8), spreadId, userId });
  return getSession(token);
}

export function getSession(token) {
  return db.prepare('SELECT * FROM draw_sessions WHERE token = ?').get(token);
}

export function expireSessions() {
  return db.prepare(
    "UPDATE draw_sessions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
  ).run(now()).changes;
}

/** 洗牌阶段：把牌序和手势参数一起落库 */
export function saveShuffle(token, { seed, deck, entropy }) {
  db.prepare(
    `UPDATE draw_sessions
        SET status = 'shuffled', seed = ?, deck = ?, entropy = ?, shuffled_at = ?
      WHERE token = ? AND status = 'pending'`,
  ).run(seed, JSON.stringify(deck), JSON.stringify(entropy ?? {}), now(), token);
  return getSession(token);
}

// ── 抽卡 & 解读 ─────────────────────────────────────────
export function saveDraw({ sessionToken, userId, spreadId, seed, cards }) {
  const id = uid();
  db.prepare(
    'INSERT INTO draws (id, session_token, user_id, spread_id, seed, cards, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(id, sessionToken, userId, spreadId, seed, JSON.stringify(cards), now());
  return id;
}

export function getDraw(id) {
  return db.prepare('SELECT * FROM draws WHERE id = ?').get(id);
}

export function saveReading({ drawId, mode, model, content, delivered, deliveryNote }) {
  const id = uid();
  db.prepare(
    `INSERT INTO readings (id, draw_id, mode, model, content, delivered, delivery_note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, drawId, mode, model ?? null, content, delivered ? 1 : 0, deliveryNote ?? null, now());
  return id;
}

/** 后台投递完成后回写状态（H5 轮询用） */
export function updateReadingDelivery(id, { delivered, deliveryNote }) {
  db.prepare('UPDATE readings SET delivered = ?, delivery_note = ? WHERE id = ?')
    .run(delivered ? 1 : 0, deliveryNote ?? null, id);
}

export function getReading(id) {
  return db.prepare('SELECT * FROM readings WHERE id = ?').get(id);
}

export function historyFor(userId, limit = 20) {
  return db.prepare(
    `SELECT d.id, d.spread_id, d.cards, d.created_at, r.content, s.question
     FROM draws d
     JOIN draw_sessions s ON s.token = d.session_token
     LEFT JOIN readings r ON r.draw_id = d.id
     WHERE d.user_id = ?
     ORDER BY d.created_at DESC LIMIT ?`,
  ).all(userId, limit);
}

// ── 点数 ────────────────────────────────────────────────
export function credit(userId, delta, reason, refId = null) {
  const tx = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  if (!tx) throw new Error('用户不存在');
  const balance = tx.credits + delta;
  if (balance < 0) throw new Error('点数不足');
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(balance, userId);
  db.prepare(
    'INSERT INTO credit_ledger (id, user_id, delta, reason, ref_id, balance_after, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(uid(), userId, delta, reason, refId, balance, now());
  return balance;
}

export function redeemCode(code, userId) {
  const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(code);
  if (!row) return { ok: false, reason: '兑换码不存在' };
  if (row.status !== 'unused') return { ok: false, reason: '兑换码已被使用' };
  if (row.expires_at && row.expires_at < now()) return { ok: false, reason: '兑换码已过期' };

  db.prepare('UPDATE redeem_codes SET status = ?, used_by = ?, used_at = ? WHERE code = ?')
    .run('used', userId, now(), code);
  const balance = credit(userId, row.credits, 'redeem', code);
  logEvent('redeem.used', { code, userId, credits: row.credits });
  return { ok: true, credits: row.credits, balance };
}

// ── 幂等 ────────────────────────────────────────────────
export function idempotencyGet(key) {
  const row = db.prepare('SELECT response FROM idempotency WHERE key = ?').get(key);
  return row ? JSON.parse(row.response) : null;
}

export function idempotencySet(key, response) {
  db.prepare('INSERT OR REPLACE INTO idempotency (key, response, created_at) VALUES (?,?,?)')
    .run(key, JSON.stringify(response), now());
}

// ── 限流（滑动窗口，落在 events 表上）────────────────────
export function rateLimit(peerId, { perMinute = 5, perDay = 30 }) {
  const ts = now();
  const minute = db.prepare(
    "SELECT COUNT(*) c FROM events WHERE kind = 'rate.hit' AND payload LIKE ? AND created_at > ?",
  ).get(`%"${peerId}"%`, ts - 60_000).c;
  const day = db.prepare(
    "SELECT COUNT(*) c FROM events WHERE kind = 'rate.hit' AND payload LIKE ? AND created_at > ?",
  ).get(`%"${peerId}"%`, ts - 86_400_000).c;

  if (minute >= perMinute) return { ok: false, reason: `请求太频繁，请稍后再试（每分钟上限 ${perMinute} 次）` };
  if (day >= perDay) return { ok: false, reason: `今日次数已用完（每天上限 ${perDay} 次）` };

  db.prepare('INSERT INTO events (id, kind, payload, created_at) VALUES (?,?,?,?)')
    .run(uid(), 'rate.hit', JSON.stringify({ peerId }), ts);
  return { ok: true, usedToday: day + 1, remaining: perDay - day - 1 };
}

export { DB_PATH };
