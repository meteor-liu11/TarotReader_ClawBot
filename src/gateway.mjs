// ══════════════════════════════════════════════════════════
// OpenClaw 网关客户端
//
// 这是整个 PRD 的命门（PRD 4.1 第 6 步「反向注入 AI 会话」）。
// 官方 `openclaw message send` 的渠道列表**不含 weixin**，
// 正确入口是 Gateway 的 HTTP hooks：
//     POST /hooks/agent   { channel, to, accountId, ... } → 直投通道
// 参见 docs/automation/cron-jobs/webhooks.md
//
// mock 模式：本机模拟网关，验证 payload 结构与闭环，无需安装 OpenClaw
// live 模式：真实打到 127.0.0.1:18789/hooks/agent
// ══════════════════════════════════════════════════════════

export function gatewayConfig() {
  return {
    mode: process.env.GATEWAY_MODE ?? 'mock',
    url: (process.env.GATEWAY_URL ?? 'http://127.0.0.1:18789').replace(/\/$/, ''),
    token: process.env.HOOK_TOKEN ?? '',
    agentId: process.env.AGENT_ID ?? 'tarot',
    channel: process.env.CHANNEL ?? 'openclaw-weixin',
    accountId: process.env.ACCOUNT_ID ?? '',
  };
}

/** 构造标准 hooks/agent payload —— 这是「网页 → 微信」的投递协议 */
export function buildHookPayload({ peerId, message, idempotencyKey, accountId }) {
  const cfg = gatewayConfig();
  const payload = {
    agentId: cfg.agentId,
    message,
    channel: cfg.channel,
    to: peerId,
    deliver: true,
    sessionMode: 'isolated',
    waitForCompletion: true,
  };
  // 多账号时必须带上具体账号，否则可能投到另一个 bot 号上去
  const acct = accountId || cfg.accountId;
  if (acct) payload.accountId = acct;
  return { payload, idempotencyKey };
}

/** 把 payload 渲染成可复制的 curl（mock 模式打印，方便手动验证） */
export function renderCurl({ payload, idempotencyKey }) {
  const cfg = gatewayConfig();
  const body = JSON.stringify(payload, null, 2);
  return [
    `curl --include ${cfg.url}/hooks/agent \\`,
    `  -H 'Authorization: Bearer $HOOK_TOKEN' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Idempotency-Key: ${idempotencyKey}' \\`,
    `  --data '${body.replace(/'/g, "'\\''")}'`,
  ].join('\n');
}

/**
 * 投递消息到微信会话。
 * @returns {{ok:boolean, mode:string, delivered:boolean, note:string, request?:object, response?:object}}
 */
export async function deliverToWechat({ peerId, message, idempotencyKey, accountId }) {
  const cfg = gatewayConfig();
  const { payload } = buildHookPayload({ peerId, message, idempotencyKey, accountId });

  if (!peerId) {
    return { ok: false, mode: cfg.mode, delivered: false, note: '缺少 to（微信 peer id），无法投递' };
  }

  if (cfg.mode === 'mock') {
    // 模拟网关：返回与官方文档一致的成功响应结构
    return {
      ok: true,
      mode: 'mock',
      delivered: true,
      note:
        '【mock 模式】未真实发送。以下 payload 就是 live 模式下会发给 OpenClaw Gateway 的内容：\n'
        + renderCurl({ payload, idempotencyKey }),
      request: payload,
      response: {
        ok: true,
        runId: `mock-${idempotencyKey}`,
        completion: { status: 'ok', replyDisposition: 'visible', delivered: true, deliveryAttempted: true },
      },
    };
  }

  if (!cfg.token) {
    return { ok: false, mode: 'live', delivered: false, note: '缺少 HOOK_TOKEN，无法调用 Gateway', request: payload };
  }

  try {
    const res = await fetch(`${cfg.url}/hooks/agent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      // 这一跳要等 agent 跑完一整轮 LLM 生成（含 thinking），很慢。
      // 30 秒是不够的 —— 实测一篇完整塔罗解读要 40~90 秒。
      signal: AbortSignal.timeout(Number(process.env.GATEWAY_TIMEOUT_MS ?? 180_000)),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const delivered = Boolean(data?.completion?.delivered);
    const status = res.status;
    return {
      ok: res.ok && delivered,
      mode: 'live',
      httpStatus: status,
      delivered,
      note: res.ok
        ? (delivered ? '已投递到微信会话' : `已受理但未确认投递（replyDisposition=${data?.completion?.replyDisposition ?? 'unknown'}）`)
        : `Gateway 返回 ${status}：${text.slice(0, 300)}`,
      request: payload,
      response: data,
    };
  } catch (err) {
    return {
      ok: false,
      mode: 'live',
      delivered: false,
      note: `调用 Gateway 失败：${err.message}。确认 OpenClaw Gateway 正在运行且 hooks.enabled=true。`,
      request: payload,
    };
  }
}

/** 检查网关可达性（live 模式下用于 verify 脚本） */
export async function probeGateway() {
  const cfg = gatewayConfig();
  if (cfg.mode === 'mock') return { reachable: true, mode: 'mock', note: 'mock 模式，无需真实网关' };
  try {
    const res = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(4000) });
    return { reachable: res.ok, mode: 'live', status: res.status };
  } catch (err) {
    return { reachable: false, mode: 'live', note: err.message };
  }
}
