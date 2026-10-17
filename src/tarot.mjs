import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CARDS, CARDS_BY_ID, SPREADS, SPREADS_BY_ID, DIMENSION_SPREAD_MAP, DOMAIN_PRESETS } from './tarot-data.mjs';

export { CARDS, CARDS_BY_ID, SPREADS, SPREADS_BY_ID, DIMENSION_SPREAD_MAP, DOMAIN_PRESETS };

// ── 可复现的伪随机流 ────────────────────────────────────
// 用 SHA-256 计数器模式派生 keystream：给定 seed + salt 完全可复现，
// 但 seed 由 CSPRNG 生成，所以外部无法预测下一次抽牌。
function makeStream(seed, salt = '') {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  return function nextUint32() {
    if (pos + 4 > buf.length) {
      buf = createHash('sha256').update(`${seed}|${salt}|${counter++}`).digest();
      pos = 0;
    }
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };
}

export function newSeed() {
  return randomBytes(16).toString('hex');
}

/**
 * 把用户的手势（洗牌时长/次数、切牌位置、抽牌序号）混进 seed。
 *
 * 这样「洗得久一点」真的会改变结果 —— 用户有参与感；
 * 但 seed 由服务端 CSPRNG 生成、手势参数全部落库，
 * 所以结果依然完全可复现、可审计。AI 依旧是碰不到"生成牌"这一步的。
 */
export function mixEntropy(seed, entropy = {}) {
  const gesture = JSON.stringify({
    rounds: entropy.rounds ?? 0,        // 洗了几轮
    durationMs: entropy.durationMs ?? 0, // 长按累计时长
    cutPile: entropy.cutPile ?? null,    // 切牌选了哪一叠
    picks: entropy.picks ?? [],          // 用户在滚轮上点的序号
  });
  return createHash('sha256').update(`${seed}|${gesture}`).digest('hex');
}

/** 用 seed 洗整副 78 张牌，返回完整牌序 */
export function shuffleDeck(seed, salt = 'deck') {
  const rnd = makeStream(seed, salt);
  const deck = CARDS.map((c) => c.id);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rnd() % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** 正逆位单独一条随机流，避免和洗牌互相干扰 */
export function dealReversals(seed, indexes, reversalRate = 0.35) {
  const rnd = makeStream(seed, 'reversal');
  const out = {};
  for (const idx of indexes) out[idx] = rnd() / 2 ** 32 < reversalRate;
  return out;
}

/**
 * 从已洗好的牌堆里，按用户点选的序号取牌。
 * 这就是物理塔罗的做法：牌堆早洗好了，用户只是决定"抽第几张"。
 */
export function pickFromDeck(deck, picks, seed, reversalRate = 0.35) {
  const rev = dealReversals(seed, picks, reversalRate);
  return picks.map((n, positionIndex) => ({
    positionIndex,
    pickIndex: n,                    // 用户点的是第几张（1-78）
    cardId: deck[n - 1],
    reversed: rev[n],
  }));
}

/**
 * 便捷封装（保留给验证脚本与无手势场景）：一次性抽 n 张
 */
export function drawCards({ seed, spreadId, reversalRate = 0.35, count, entropy }) {
  const spread = SPREADS_BY_ID.get(spreadId);
  const n = count ?? spread?.count;
  if (!n) throw new Error(`未知牌阵: ${spreadId}`);
  const effective = entropy ? mixEntropy(seed, entropy) : seed;
  const deck = shuffleDeck(effective, spreadId);
  const picks = Array.from({ length: n }, (_, i) => i + 1);
  return pickFromDeck(deck, picks, effective, reversalRate);
}

export const DECK_SIZE = CARDS.length;

/** 把抽牌结果补上可读信息 */
export function enrichDraw(draw, spreadId) {
  const spread = SPREADS_BY_ID.get(spreadId);
  return draw.map((d, i) => {
    const card = CARDS_BY_ID.get(d.cardId);
    return {
      ...d,
      position: spread?.positions?.[i]?.key ?? `pos${i}`,
      positionLabel: spread?.positions?.[i]?.label ?? `第 ${i + 1} 张`,
      name: card.name,
      nameEn: card.nameEn,
      arcana: card.arcana,
      suit: card.suit,
      keywords: d.reversed ? card.reversed : card.upright,
      img: card.img,
    };
  });
}

/** 人类可读的牌面描述，用于回注微信 */
export function formatCardsForMessage(enriched) {
  return enriched
    .map((c) => `${c.positionLabel}: ${c.name}${c.reversed ? '（逆位）' : '（正位）'} — ${c.keywords.join('、')}`)
    .join('\n');
}

/** 按分析维度选择牌阵（AI 只做选模板 + 填槽，不自由生成） */
export function pickSpread(dimensions, domain) {
  const n = dimensions?.length;
  if (n && DIMENSION_SPREAD_MAP[n]) return DIMENSION_SPREAD_MAP[n];
  if (domain && DOMAIN_PRESETS[domain]) return DOMAIN_PRESETS[domain].spreadId;
  return 'dim3-relation';
}

// ── 意图识别（demo 版）──────────────────────────────────
// 三层判断：
//   ① 显式占卜指令            → 直接进入占卜
//   ② 情绪困扰 / 对结果的不确定（没主动提占卜）→ 主动询问（PRD 5.1 要求）
//   ③ 其他                    → 普通对话
const DIVINATION_WORDS = ['抽塔罗', '塔罗', '占卜', '算一卦', '算卦', '测算', '解牌', '抽牌', '运势', '看牌', '帮我看看'];

// 情绪困扰
const DISTRESS_WORDS = [
  '迷茫', '不知道怎么办', '好纠结', '很难受', '焦虑', '睡不着', '很累',
  '内耗', '不知道选', '撑不住', 'emo', '心烦', '想不通',
];

// 对未定结果的不确定 —— 这类话看着像聊天，其实是在求一个"会不会/能不能"
const OUTCOME_SEEKING = [
  '还有可能吗', '有没有可能', '有没有希望', '还有希望吗', '会好吗', '能好吗',
  '会不会', '能不能', '还能不能', '要不要继续', '该不该', '要不要',
  '会成功吗', '能成吗', '怎么样才能', '是不是没戏', '有戏吗',
  '缘分', '正缘', '复合', '他喜欢我吗', '她喜欢我吗', '怎么想',
  '多久能', '什么时候能', '好不好', '值不值得',
];

export function detectIntent(text = '') {
  const t = String(text);

  const explicit = DIVINATION_WORDS.filter((w) => t.includes(w));
  if (explicit.length) return { intent: 'divination', matched: explicit, confidence: 'high' };

  const distressed = DISTRESS_WORDS.filter((w) => t.includes(w));
  const seeking = OUTCOME_SEEKING.filter((w) => t.includes(w));
  if (distressed.length || seeking.length) {
    return {
      intent: 'maybe_divination',
      matched: [...distressed, ...seeking],
      confidence: seeking.length ? 'medium' : 'low',
      // PRD 5.1：用户没有主动提起占卜，但显得迷茫 / 在问未定结果时，应主动询问
      prompt: '听起来你正在为这件事耗神。要不要我陪你抽一组牌，把现在的处境看得清楚一点？'
        + '\n（想抽的话回我「抽塔罗」就行）',
    };
  }
  return { intent: 'chat', matched: [], confidence: 'none' };
}

/** 去掉指令词，留下用户真正在问的那句话 */
export function cleanQuestion(text = '') {
  return String(text)
    .replace(/^(抽塔罗|抽牌|占卜|塔罗|算一卦|算卦|测算|解牌|看牌|帮我看看)?[，,、:：\s]*/g, '')
    .replace(/^(帮我看看|帮我算算|帮忙看看)[，,、:：\s]*/g, '')
    .trim() || String(text).trim();
}

// ── 场景深挖：产出结构化「占卜需求卡」────────────────────
// PRD 5.1 原文提到"要先提问你们现在是什么关系、进展如何，确定关键线索后再发送抽卡链接"
const DOMAIN_KEYWORDS = {
  感情: ['感情', '喜欢', '爱', '恋爱', '对象', '男朋友', '女朋友', '他', '她', '复合', '分手', '暧昧', '结婚'],
  事业: ['工作', '事业', '跳槽', '面试', '升职', '老板', '同事', '创业', '项目', 'offer'],
  选择: ['选择', '选哪个', '要不要', '该不该', '两个', '纠结'],
  财运: ['钱', '财运', '收入', '投资', '理财', '亏损'],
  自我: ['自己', '迷茫', '焦虑', '方向', '状态', '成长'],
};

export function buildNeedCard({ text = '', domain, clues = [] } = {}) {
  let pickedDomain = domain;
  if (!pickedDomain) {
    for (const [d, words] of Object.entries(DOMAIN_KEYWORDS)) {
      if (words.some((w) => text.includes(w))) { pickedDomain = d; break; }
    }
  }
  const preset = DOMAIN_PRESETS[pickedDomain] ?? DOMAIN_PRESETS.日常;
  return {
    domain: pickedDomain ?? '日常',
    clues: clues.length ? clues : extractClues(text),
    dimensions: preset.dimensions,
    spreadId: preset.spreadId,
  };
}

function extractClues(text) {
  const clues = [];
  if (/异地|不在一个城市|两地/.test(text)) clues.push('异地');
  if (/冷战|不理我|没回消息|不回/.test(text)) clues.push('近期沟通中断');
  if (/多久|几个月|几年|两周|一个月/.test(text)) {
    const m = text.match(/(\d+\s*(?:天|周|个月|年|星期))/);
    if (m) clues.push(`持续 ${m[1]}`);
  }
  if (/复合|重来|回头/.test(text)) clues.push('涉及是否复合');
  if (/分手|分开|离开/.test(text)) clues.push('涉及分离');
  if (/面试|跳槽|辞职|换工作/.test(text)) clues.push('职业变动');
  return clues;
}

/** 逐字段填空式深挖提问：缺什么问什么，最多两轮 */
export function nextClarifyingQuestion(needCard) {
  if (!needCard.clues?.length) {
    return '在抽牌之前，我想先确认两件事：你们现在是什么关系？这件事大概持续多久了？';
  }
  if (needCard.domain === '感情' || needCard.domain === '复合') {
    return '我大概了解了。还想确认一句：你更想知道「对方怎么想」，还是「接下来该怎么走」？';
  }
  return '收到，关键信息够了。我这就为你准备牌阵。';
}

// ── 工具 ────────────────────────────────────────────────
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function imageUrl(img) {
  return `/deck/${encodeURIComponent(img)}`;
}
