import { CARDS_BY_ID, SUITS } from './tarot-data.mjs';
import { enrichDraw } from './tarot.mjs';

// ══════════════════════════════════════════════════════════
// 解读生成：固定五段式结构，AI 只填内容不改结构
//   ① 一句话总览  ② 逐维度解读  ③ 牌间关系
//   ④ 结论与建议  ⑤ 行动项 + 时间窗；输出不带小标题和固定免责声明
// ══════════════════════════════════════════════════════════

const ELEMENT_CN = { 火: '火', 水: '水', 风: '风', 土: '土' };

function elementOf(cardId) {
  const c = CARDS_BY_ID.get(cardId);
  if (!c) return null;
  if (c.arcana === 'major') return '大阿卡纳';
  return SUITS[c.suit].element;
}

/** 牌间关系分析：元素分布、大牌密度、正逆比例、同花色聚集 */
export function analyzeRelations(enriched) {
  const elements = {};
  let majors = 0;
  let reversed = 0;
  const suits = {};

  for (const c of enriched) {
    const el = elementOf(c.cardId);
    elements[el] = (elements[el] ?? 0) + 1;
    const card = CARDS_BY_ID.get(c.cardId);
    if (card.arcana === 'major') majors++;
    else suits[card.suit] = (suits[card.suit] ?? 0) + 1;
    if (c.reversed) reversed++;
  }

  const total = enriched.length;
  const dominantSuit = Object.entries(suits).sort((a, b) => b[1] - a[1])[0];
  const notes = [];

  if (majors / total >= 0.5) {
    notes.push('大阿卡纳占比很高 —— 这件事不完全由你个人的努力决定，有更大的结构或时机在起作用，硬推不如顺势。');
  } else if (majors === 0 && total >= 3) {
    notes.push('全部是小阿卡纳 —— 这说明问题落在具体、日常、可操作的层面，不是命运级的转折，处理细节就能改善。');
  }

  if (reversed / total >= 0.5) {
    notes.push('逆位牌偏多 —— 能量是往里收的，现在更适合先整理内部状态，而不是对外做大动作。');
  } else if (reversed === 0 && total >= 3) {
    notes.push('全部正位 —— 能量是通畅的，牌面在鼓励你往前走，阻力主要来自犹豫本身。');
  }

  if (dominantSuit && dominantSuit[1] >= 3) {
    const s = SUITS[dominantSuit[0]];
    notes.push(`${s.name}出现 ${dominantSuit[1]} 次，议题高度集中在「${s.theme}」这一块，其它都是枝节。`);
  }

  // 元素冲突
  const fire = elements['火'] ?? 0;
  const water = elements['水'] ?? 0;
  if (fire >= 2 && water >= 2) {
    notes.push('火（想行动）与水（想感受）同时出现 —— 你心里有一部分想冲，有一部分想等，这种内耗本身就是答案的一部分。');
  }
  const air = elements['风'] ?? 0;
  const earth = elements['土'] ?? 0;
  if (air >= 2 && earth >= 2) {
    notes.push('风（想清楚）与土（要落地）拉扯 —— 你在"想明白再做"和"先做起来"之间卡住了。');
  }

  return {
    elements, majors, reversed, suits, notes, total,
    dominantSuit: dominantSuit?.[0] ?? null,
    dominantCount: dominantSuit?.[1] ?? 0,
  };
}

// ── ① 一句话总览 ────────────────────────────────────────
function overview(enriched, rel, needCard) {
  const first = enriched[0];
  const firstCard = CARDS_BY_ID.get(first.cardId);
  const domain = needCard?.domain ?? '这件事';
  const stance = rel.reversed / rel.total >= 0.5
    ? '整体更适合先观察、整理，再决定下一步。'
    : '整体呈现出向外推进的势头，重点是把行动方向落到具体处。';

  if (enriched.length === 1) {
    return `围绕「${domain}」，这张牌的核心提醒是「${firstCard.prototype}」；${first.name}${first.reversed ? '逆位' : '正位'}落在「${first.positionLabel}」，${stance}`;
  }

  const last = enriched[enriched.length - 1];
  const lastCard = CARDS_BY_ID.get(last.cardId);
  return `围绕「${domain}」，牌阵的核心张力集中在「${firstCard.prototype}」与「${lastCard.prototype}」之间；${stance}`;
}

// ── ② 逐维度解读 ────────────────────────────────────────
// 关键：同一张牌放在「优势位」和放在「阻碍位」，解读必须不同。
// 只按正逆位套模板会说出「权杖十是你的资源，可以放心用」这种胡话。
const ROLE = {
  资源: ['focus', 'strength', 'chance', 'advice'],
  阻碍: ['block', 'obstacle', 'resist', 'challenge', 'hidden', 'hopes'],
};

function roleOf(positionKey) {
  if (ROLE.资源.includes(positionKey)) return '资源';
  if (ROLE.阻碍.includes(positionKey)) return '阻碍';
  return '中性';
}

function perDimension(enriched) {
  return enriched.map((c, i) => {
    const role = roleOf(c.position);
    const kw = c.keywords.slice(0, 3).join('、');
    const face = `${c.name}（${c.reversed ? '逆位' : '正位'}）的牌义指向${kw}。`;
    const V = i % 2; // 交替措辞，避免同一段话在牌阵里重复出现

    let body;
    if (role === '阻碍') {
      body = c.reversed
        ? `${face}作为「${c.positionLabel}」所代表的阻碍，它正在松动，或更多来自内部的预期、恐惧与未说出口的话。`
        : `${face}出现在「${c.positionLabel}」这个阻碍位置，说明有一项具体因素确实需要处理；先把它拆成可核实的小问题。`;
    } else if (role === '资源') {
      body = c.reversed
        ? `${face}这本可成为资源，但目前像是被压住了；先确认什么条件能让它重新发挥作用。`
        : `${face}它在「${c.positionLabel}」位置上可以作为可调用的资源。`;
    } else {
      const rev = [
        '逆位说明这一块的能量是往内收的，现在还不宜对外发力，先整理内部状态。',
        '逆位意味着这里的进展被推迟或被你自己压着 —— 不是你做错了什么，是时机还没到。',
      ];
      const up = [
        '正位说明这一块的能量是向外显的，你可以在这里观察事情的实际走向。',
        '正位意味着这里是透明的、可读的 —— 你在这块看到的感受，大概率是准的。',
      ];
      body = `${face}${c.reversed ? rev[V] : up[V]}`;
    }
    return `在「${c.positionLabel}」位置，${body}`;
  }).join('\n\n');
}

// ── ③ 牌间关系 ──────────────────────────────────────────
function relations(rel, enriched) {
  if (enriched.length === 1) {
    return '这次只有一张牌，没有牌与牌之间的对照；解读重点放在这张牌所对应的指引上。';
  }
  if (!rel.notes.length) {
    return '牌面之间没有明显的冲突或扎堆，各个位置呈现的侧面相对均衡，可以按顺序逐项处理。';
  }
  return rel.notes.join(' ');
}

// ── ④ 结论与建议 ────────────────────────────────────────
function advice(enriched, rel, needCard) {
  const out = [];
  const domain = needCard?.domain ?? '这件事';

  if (rel.reversed / rel.total >= 0.5) {
    out.push(`先别急着对${domain}下判断。给自己一周，只做一件事：把你现在能确认的事实和你的猜测分开写下来。你会发现真正确定的东西比想象中少。`);
  } else {
    out.push(`你现在缺的不是勇气，是确认。找一个具体动作往前推一小步 —— 不是摊牌，不是表白，是让对方或环境给你一个可观察的回应。`);
  }

  const stuck = enriched.filter((c) => roleOf(c.position) === '阻碍' || c.reversed).map((c) => c.positionLabel);
  if (stuck.length === 1) {
    out.push(`「${stuck[0]}」是当前的堵点。它不会因为你更用力而变顺，换个角度（而不是加倍投入）才是解法。`);
  } else if (stuck.length > 1) {
    out.push(`「${stuck.join('」「')}」这几处是当前的堵点。它们不会因为你更用力而变顺，换个角度（而不是加倍投入）才是解法。`);
  }

  // 只有同一花色真的占了多数，才谈"议题集中"，否则是过度解读
  if (rel.dominantSuit && rel.dominantCount >= 3) {
    out.push(`牌面有 ${rel.dominantCount} 张集中在「${SUITS[rel.dominantSuit].theme}」，说明这段时间你的注意力被这块占满了。刻意留一点精力给别的事，反而会让这块松动。`);
  }

  return out.join('\n\n');
}

// ── ⑤ 行动项 + 时间窗 ──────────────────────────────────
function actions(enriched, rel) {
  const horizon = rel.reversed / rel.total >= 0.5 ? '2 周内' : '1 周内';
  return [
    `未来${horizon}适合观察，不必急着要求一个确定答案。`,
    '可以先写下你最想确认的一句话，隔一天再看：删去需要别人立刻表态的部分，只留下你自己能验证并采取行动的内容。',
  ].join('\n\n');
}

/** 组装完整解读（template 模式：离线、确定性、零成本） */
export function renderTemplateReading({ draw, spreadId, needCard, question }) {
  const enriched = enrichDraw(draw, spreadId);
  const rel = analyzeRelations(enriched);
  const body = [
    overview(enriched, rel, needCard),
    perDimension(enriched),
    relations(rel, enriched),
    advice(enriched, rel, needCard),
    actions(enriched, rel),
  ].filter(Boolean).join('\n\n');

  return { content: body, enriched, relations: rel };
}

/** 微信结果只保留自然段正文；兼容清理模型偶尔输出的标题与旧版免责声明。 */
export function normalizeReadingOutput(value) {
  const titleLine = /^\s*(?:#{1,6}\s*)?(?:🔮\s*)?(?:\*\*)?(?:你的塔罗解读|塔罗解读(?:结果)?|解读结果|牌已经为你抽好了.*|完整解读[:：]?)(?:\*\*)?.*$/i;
  const sectionPrefix = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:第[一二三四五1-5]部分[：:]\s*)?(?:[一二三四五1-5][、.．]\s*)?(?:总体印象|逐张解读|牌与牌之间|结论与建议|接下来)(?:\*\*)?\s*[:：-]?\s*/;
  const boilerplate = /以上内容基于塔罗象征体系[^。\n]*(?:。|$)(?:如果你的困扰已影响到睡眠、进食或日常功能，请寻求专业心理帮助。?)?/g;
  const lines = String(value ?? '').split(/\r?\n/)
    .filter((line) => !titleLine.test(line))
    .map((line) => line.replace(sectionPrefix, ''));
  return lines.join('\n')
    .replace(boilerplate, '')
    .replace(/^\s*(?:完整解读|解读结果)[:：]?\s*$/gim, '')
    .replace(/^\s*[_*]+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── LLM 模式（可选）─────────────────────────────────────
export function buildPrompt({ draw, spreadId, needCard, question }) {
  const enriched = enrichDraw(draw, spreadId);
  const cards = enriched.map((c) => {
    const card = CARDS_BY_ID.get(c.cardId);
    return `${c.positionLabel}: ${c.name} / ${card.nameEn}（${c.reversed ? '逆位' : '正位'}）关键词: ${c.keywords.join('、')}`;
  }).join('\n');

  return `你是一位温柔、专业、不说空话的塔罗解读师。你的用户是 18-35 岁的年轻人。

【用户问题】${question || '（未明确说明）'}
【议题域】${needCard?.domain ?? '日常'}
【已知线索】${needCard?.clues?.join('、') || '无'}

【牌面（已由系统确定性抽出，不得更改、不得新增、不得替换）】
${cards}

【硬性要求】
1. 按五个逻辑部分依次写：总体印象、逐张解读、牌与牌之间、结论与建议、接下来；用自然段分隔，但不得输出标题、编号、emoji 或开场白。
2. 逐张解读必须覆盖每个位置，写出对应牌名、正逆位、牌义及该位置的具体含义；只能使用上方牌面，禁止增删替换。
3. 禁止巴纳姆式废话。每句判断都必须挂靠到具体的牌、位置或用户问题；单张牌时不要虚构牌间关系。
4. 不给绝对化预测，不做医疗/法律/投资建议，不承诺结果；不要附加固定免责声明。
5. 最后一段给出合适的时间窗和具体、可执行的行动。
6. 语气温柔但不讨好；总长度控制在 900 字以内。`;
}

export async function callLLM({ prompt, model, apiKey, baseUrl }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
