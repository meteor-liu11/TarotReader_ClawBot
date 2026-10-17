import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const BASE_URL = 'http://127.0.0.1:8787';
const CHANNEL_ALIASES = new Set(['openclaw-weixin', 'weixin', 'wechat']);
const DIVINATION_WORDS = /(抽塔罗|塔罗|占卜|算一卦|算卦|测算|解牌|抽牌|运势|看牌|帮我看看)/;
const MAYBE_DIVINATION_WORDS = /(还有可能吗|有没有可能|有没有希望|还有希望吗|会好吗|能好吗|会不会|能不能|要不要继续|该不该|要不要|会成功吗|能成吗|迷茫|焦虑|不知道怎么办|很难受|睡不着|撑不住)/;
const NEGATED_DIVINATION = /(不想|不要|不需要|别|取消|停止).{0,5}(抽塔罗|塔罗|占卜|算一卦|算卦|测算|解牌|抽牌|运势|看牌)/;
const NEGATED_LINK = /(不要|不需要|别|取消|停止).{0,8}(链接|网址|网页)/;
const POSITIVE_LINK_REQUEST = /(给我|发我|发送|生成).{0,10}(链接|网址|网页)|(链接|网址|网页).{0,5}(发我|给我)/;
const POSITIVE_LINK_AFTER_NEGATED_DRAW = /(不想|不要|不需要|别|取消|停止).{0,5}(抽塔罗|塔罗|占卜|算一卦|算卦|测算|解牌|抽牌|运势|看牌).{0,12}(给我|发我|发送|发|生成).{0,10}(链接|网址|网页)/;
const WAITLIST_APPLICATION = /^(?:申请|申请内测|我要申请内测|加入等待名单|加入内测|报名内测|我要报名内测)[\s。！!]*$/;
const UNAVAILABLE = '我现在无法连接本地抽卡服务，先不替你抽牌或编造牌面。请稍后重试。';
const APPLICATION_UNAVAILABLE = '我暂时无法登记内测申请，请稍后重试。';
const INBOUND_IDENTITY_TTL_MS = 10 * 60 * 1000;
const MAX_INBOUND_IDENTITIES = 512;
const inboundIdentities = new Map();
let messageReceivedEventCount = 0;
let latestMessageReceivedShape = null;

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
}

function readText(event) {
  return firstString(
    event?.content,
    event?.bodyForAgent,
    event?.body,
    event?.text,
    event?.rawBody,
  );
}

function readChannel(event, ctx) {
  return firstString(
    ctx?.channel,
    ctx?.messageProvider,
    event?.channel,
    event?.channelId,
    event?.provider,
    event?.metadata?.provider,
  ).toLowerCase();
}

function isTargetChannel(event, ctx) {
  const channel = readChannel(event, ctx);
  if (channel) return CHANNEL_ALIASES.has(channel);
  // This deployment routes the tarot Agent only from the Weixin DM binding.
  return !ctx?.agentId || ctx.agentId === 'tarot';
}

function readMessageId(event, ctx) {
  return firstString(event?.messageId, ctx?.messageId);
}

function readPeerId(event, ctx, cachedIdentity) {
  const channel = readChannel(event, ctx);
  const weixinPeerId = CHANNEL_ALIASES.has(channel)
    ? firstString(
      event?.metadata?.originatingTo,
      ctx?.metadata?.originatingTo,
      event?.from,
      ctx?.from,
    )
    : '';
  return firstString(
    ctx?.senderId,
    event?.senderId,
    event?.metadata?.senderId,
    ctx?.metadata?.senderId,
    ctx?.channelContext?.sender?.id,
    weixinPeerId,
    cachedIdentity?.senderId,
  );
}

function safeKeys(value) {
  if (!value || typeof value !== 'object') return [];
  try { return Object.keys(value).slice(0, 16).sort(); } catch { return []; }
}

function safeType(value) {
  return value === null ? 'null' : typeof value;
}

function formatIdentityDiagnostic(event, ctx, cachedIdentity) {
  const latest = latestMessageReceivedShape;
  const yesNo = (value) => value ? 'yes' : 'no';
  const received = latest
    ? `seen=${messageReceivedEventCount},target=${yesNo(latest.target)},senderId=${yesNo(latest.hasSenderId)},peerId=${yesNo(latest.hasPeerId)},messageId=${yesNo(latest.hasMessageId)},captured=${yesNo(latest.captured)},senderTypes=${latest.senderTypes},peerTypes=${latest.peerTypes},eventKeys=${latest.eventKeys.join(',') || '-'},ctxKeys=${latest.ctxKeys.join(',') || '-'},metadataKeys=${latest.metadataKeys.join(',') || '-'},ctxMetadataKeys=${latest.ctxMetadataKeys.join(',') || '-'},metadataSenderKeys=${latest.metadataSenderKeys.join(',') || '-'},senderKeys=${latest.senderKeys.join(',') || '-'},peerKeys=${latest.peerKeys.join(',') || '-'},fromKeys=${latest.fromKeys.join(',') || '-'}`
    : 'seen=0';
  const senderTypes = `event:${safeType(event?.senderId)},ctx:${safeType(ctx?.senderId)},eventMeta:${safeType(event?.metadata?.senderId)},ctxMeta:${safeType(ctx?.metadata?.senderId)}`;
  const peerTypes = `event.from:${safeType(event?.from)},ctx.from:${safeType(ctx?.from)},event.originatingTo:${safeType(event?.metadata?.originatingTo)},ctx.originatingTo:${safeType(ctx?.metadata?.originatingTo)}`;
  const dispatch = `eventSenderId=${yesNo(Boolean(firstString(event?.senderId)))},ctxSenderId=${yesNo(Boolean(firstString(ctx?.senderId)))},peerId=${yesNo(Boolean(readPeerId(event, ctx, cachedIdentity)))},messageId=${yesNo(Boolean(readMessageId(event, ctx)))},cacheHit=${yesNo(Boolean(cachedIdentity))},senderTypes=${senderTypes},peerTypes=${peerTypes},eventKeys=${safeKeys(event).join(',') || '-'},ctxKeys=${safeKeys(ctx).join(',') || '-'},metadataKeys=${safeKeys(event?.metadata).join(',') || '-'},ctxMetadataKeys=${safeKeys(ctx?.metadata).join(',') || '-'},metadataSenderKeys=${safeKeys(event?.metadata?.senderId).join(',') || '-'},channelContextKeys=${safeKeys(ctx?.channelContext).join(',') || '-'}`;
  return `安全诊断（仅字段名/是否存在，不含 ID 值或消息正文）：message_received{${received}}；before_dispatch{${dispatch}}`;
}

function rememberInboundIdentity(event, ctx) {
  const channel = readChannel(event, ctx);
  if (channel && !CHANNEL_ALIASES.has(channel)) return false;

  const messageId = readMessageId(event, ctx);
  const senderId = readPeerId(event, ctx, null);
  if (!messageId || !senderId) return false;

  const now = Date.now();
  for (const [key, value] of inboundIdentities) {
    if (now - value.capturedAt > INBOUND_IDENTITY_TTL_MS) inboundIdentities.delete(key);
  }
  inboundIdentities.set(messageId, {
    senderId,
    accountId: firstString(event?.accountId, event?.metadata?.accountId, ctx?.accountId),
    capturedAt: now,
  });
  while (inboundIdentities.size > MAX_INBOUND_IDENTITIES) {
    inboundIdentities.delete(inboundIdentities.keys().next().value);
  }
  return true;
}

function takeInboundIdentity(event, ctx) {
  const messageId = readMessageId(event, ctx);
  if (!messageId) return null;
  const identity = inboundIdentities.get(messageId) ?? null;
  inboundIdentities.delete(messageId);
  if (!identity || Date.now() - identity.capturedAt > INBOUND_IDENTITY_TTL_MS) return null;
  return identity;
}

function readAccountId(event, ctx, cachedIdentity) {
  return firstString(
    event?.accountId,
    event?.metadata?.accountId,
    ctx?.accountId,
    ctx?.metadata?.accountId,
    ctx?.channelContext?.account?.id,
    cachedIdentity?.accountId,
  );
}

async function postJson(path, payload, timeoutMs = 5000) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(`local_api_http_${response.status}`);
  return data;
}

function handled(text) {
  return { handled: true, text };
}

export default definePluginEntry({
  id: 'tarot-inbound-guard',
  name: 'Tarot Inbound Guard',
  description: 'Routes tarot intents through the local ClawBot API before model dispatch.',
  register(api) {
    // Tencent maps Weixin from_user_id to inbound From/To/OriginatingTo; senderId may be undefined.
    // Keep only a short-lived in-memory correlation for before_dispatch; never persist or log IDs.
    api.on('message_received', (event, ctx) => {
      messageReceivedEventCount += 1;
      const target = isTargetChannel(event, ctx);
      const captured = target && rememberInboundIdentity(event, ctx);
      latestMessageReceivedShape = {
        target,
        captured,
        hasSenderId: Boolean(firstString(
          event?.senderId,
          ctx?.senderId,
          event?.metadata?.senderId,
          ctx?.metadata?.senderId,
        )),
        hasPeerId: Boolean(readPeerId(event, ctx, null)),
        hasMessageId: Boolean(readMessageId(event, ctx)),
        senderTypes: `event:${safeType(event?.senderId)},ctx:${safeType(ctx?.senderId)},eventMeta:${safeType(event?.metadata?.senderId)},ctxMeta:${safeType(ctx?.metadata?.senderId)}`,
        peerTypes: `event.from:${safeType(event?.from)},ctx.from:${safeType(ctx?.from)},event.originatingTo:${safeType(event?.metadata?.originatingTo)},ctx.originatingTo:${safeType(ctx?.metadata?.originatingTo)}`,
        eventKeys: safeKeys(event),
        ctxKeys: safeKeys(ctx),
        metadataKeys: safeKeys(event?.metadata),
        ctxMetadataKeys: safeKeys(ctx?.metadata),
        metadataSenderKeys: safeKeys(event?.metadata?.senderId),
        senderKeys: safeKeys(event?.sender ?? ctx?.channelContext?.sender),
        peerKeys: safeKeys(event?.peer ?? ctx?.channelContext?.peer),
        fromKeys: safeKeys(event?.from),
      };
    });

    api.on('before_dispatch', async (event, ctx) => {
      if (!isTargetChannel(event, ctx)) return undefined;
      const cachedIdentity = takeInboundIdentity(event, ctx);

      const text = readText(event);
      if (!text) return undefined;

      if (WAITLIST_APPLICATION.test(text.trim())) {
        const peerId = readPeerId(event, ctx, cachedIdentity);
        if (!peerId) {
          return handled(`我没有取得这条微信消息的用户标识，暂时不能登记申请；请稍后重试。\n${formatIdentityDiagnostic(event, ctx, cachedIdentity)}`);
        }
        const payload = { peerId, channel: 'openclaw-weixin' };
        const accountId = readAccountId(event, ctx, cachedIdentity);
        if (accountId) payload.accountId = accountId;
        try {
          const result = await postJson('/api/agent/apply', payload, 7000);
          if (result.ok !== true || result.status !== 'approved' || result.allowlisted !== true
            || typeof result.reply !== 'string' || !result.reply.trim()) {
            return handled(APPLICATION_UNAVAILABLE);
          }
          return handled(result.reply);
        } catch {
          return handled(APPLICATION_UNAVAILABLE);
        }
      }

      if (NEGATED_DIVINATION.test(text)
        && !POSITIVE_LINK_AFTER_NEGATED_DRAW.test(text)
        && (NEGATED_LINK.test(text) || !POSITIVE_LINK_REQUEST.test(text))) {
        return handled('好的，我不会替你抽牌或编造牌面。如果你想开始，我可以先发送抽卡网页链接。');
      }

      let classification;
      try {
        classification = await postJson('/api/agent/classify', { text }, 4000);
      } catch {
        if (DIVINATION_WORDS.test(text) || MAYBE_DIVINATION_WORDS.test(text)) {
          return handled(UNAVAILABLE);
        }
        return undefined;
      }

      if (classification.intent === 'chat') {
        if (DIVINATION_WORDS.test(text) || MAYBE_DIVINATION_WORDS.test(text)) return handled(UNAVAILABLE);
        return undefined;
      }
      if (classification.intent === 'maybe_divination') {
        return handled(firstString(classification.prompt) || UNAVAILABLE);
      }
      if (classification.intent !== 'divination') {
        if (DIVINATION_WORDS.test(text) || MAYBE_DIVINATION_WORDS.test(text)) return handled(UNAVAILABLE);
        return undefined;
      }

      const peerId = readPeerId(event, ctx, cachedIdentity);
      if (!peerId) {
        return handled(`我没有取得这条微信消息的发送者标识，不能安全创建抽卡会话；请稍后重试。\n${formatIdentityDiagnostic(event, ctx, cachedIdentity)}`);
      }

      const payload = {
        text,
        peerId,
        channel: 'openclaw-weixin',
      };
      const accountId = readAccountId(event, ctx, cachedIdentity);
      if (accountId) payload.accountId = accountId;

      try {
        const result = await postJson('/api/agent/inbound', payload, 7000);
        if (typeof result.reply !== 'string' || !result.reply.trim()) {
          return handled(UNAVAILABLE);
        }
        if (result.allowed === true && result.intent === 'divination') {
          const link = firstString(result.link);
          let parsed;
          try { parsed = new URL(link); } catch { parsed = null; }
          if (!parsed || !/^https?:$/.test(parsed.protocol) || !/^\/s\/[^/]+$/.test(parsed.pathname)) {
            return handled(UNAVAILABLE);
          }
          if (!result.reply.includes(link)) return handled(UNAVAILABLE);
        }
        return handled(result.reply);
      } catch {
        return handled(UNAVAILABLE);
      }
    }, { timeoutMs: 15000 });
  },
});
