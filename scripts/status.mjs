#!/usr/bin/env node
/**
 * 一键只读体检：微信接入链路每一步的真实状态。
 * 支持本项目当前的自定义安装：D:\\law\\OpenClaw\\state。
 *
 *   node scripts/status.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_ROOT = process.env.OPENCLAW_HOME
  || (existsSync('D:/law/OpenClaw/state/.openclaw/openclaw.json')
    ? 'D:/law/OpenClaw/state'
    : homedir());
const CONFIG_PATH = resolve(CONFIG_ROOT, '.openclaw/openclaw.json');
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRYPOINT
  || 'D:/law/OpenClaw/node_modules/openclaw/openclaw.mjs';
const OPENCLAW_ENV = { ...process.env, OPENCLAW_HOME: CONFIG_ROOT };
const OC_FIX = String.raw`Set-Location 'D:\law\OpenClaw'; $env:OPENCLAW_HOME='D:\law\OpenClaw\state'; npm exec openclaw --`;

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const no = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let done = 0;
let todo = 0;
function line(okFlag, label, detail = '', fix = '') {
  okFlag ? done++ : todo++;
  console.log(`  ${okFlag ? ok('✔') : no('✘')}  ${label}`);
  if (detail) console.log(`        ${dim(detail)}`);
  if (!okFlag && fix) console.log(`        ${warn('→ ' + fix)}`);
}

function oc(args) {
  try {
    if (existsSync(OPENCLAW_ENTRY)) {
      return execFileSync(process.execPath, [OPENCLAW_ENTRY, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, env: OPENCLAW_ENV,
      }).trim();
    }
    return execFileSync('openclaw', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, env: OPENCLAW_ENV,
    }).trim();
  } catch { return ''; }
}

function parseEnv(text) {
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const entry = raw.trim();
    if (!entry || entry.startsWith('#')) continue;
    const i = entry.indexOf('=');
    if (i > 0) values.set(entry.slice(0, i).trim(), entry.slice(i + 1).trim());
  }
  return values;
}

console.log(bold('\n  塔罗 ClawBot · 接入链路体检（只读，不显示密钥）\n'));
console.log(`  OpenClaw state: ${CONFIG_ROOT}`);

const ver = oc(['--version']);
line(Boolean(ver), 'OpenClaw CLI 已安装', ver || '', '确认 D:\\law\\OpenClaw 安装目录与 Node.js 可用');
const plugins = oc(['plugins', 'list']);
const wxPlugin = /openclaw-weixin/.test(plugins);
line(wxPlugin, '腾讯微信通道插件在插件列表中可见', wxPlugin ? 'openclaw-weixin' : '',
  `${OC_FIX} plugins install @tencent-weixin/openclaw-weixin`);
const guardRuntime = oc(['plugins', 'inspect', 'tarot-inbound-guard', '--runtime', '--json']);
const guardLoaded = /tarot-inbound-guard/.test(guardRuntime)
  && /before_dispatch/.test(guardRuntime)
  && /message_received/.test(guardRuntime);
line(guardLoaded, 'Guard 已加载 message_received 与 before_dispatch',
  guardLoaded ? 'tarot-inbound-guard runtime registrations found' : '插件缺失、未启用或 Gateway 未加载必要消息钩子',
  'powershell -NoProfile -ExecutionPolicy Bypass -File E:\\塔罗clawbot\\demo\\scripts\\start-stack.ps1');
const chStatus = oc(['channels', 'status', '--probe']);
const running = /openclaw-weixin.*running/i.test(chStatus);
line(running, '微信通道已登录且 Gateway 可达', running ? 'openclaw-weixin running' : '',
  `${OC_FIX} channels status --probe`);

let gatewayOk = false;
try {
  const response = await fetch('http://127.0.0.1:18789/health', { signal: AbortSignal.timeout(2500) });
  const data = await response.json();
  gatewayOk = response.ok && data?.status === 'live';
} catch { /* Gateway 未启动 */ }
line(gatewayOk, 'OpenClaw Gateway 健康', gatewayOk ? '127.0.0.1:18789 live' : '127.0.0.1:18789 无响应',
  'powershell -ExecutionPolicy Bypass -File E:\\塔罗clawbot\\demo\\scripts\\start-stack.ps1');

let config = null;
try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 配置缺失或无效 */ }
const hooksEnabled = config?.hooks?.enabled === true && typeof config?.hooks?.token === 'string' && config.hooks.token.length > 0;
const hooksAgents = config?.hooks?.allowedAgentIds ?? [];
line(hooksEnabled && hooksAgents.includes('tarot'), 'Hooks 已启用并允许 tarot Agent',
  hooksEnabled ? `allowedAgentIds=${JSON.stringify(hooksAgents)}` : '',
  'powershell -NoProfile -ExecutionPolicy Bypass -File E:\\塔罗clawbot\\demo\\scripts\\start-stack.ps1');

const agents = oc(['agents', 'list']);
const hasAgent = /(?:^-\s*tarot$|\btarot\b)/m.test(agents);
line(hasAgent, 'tarot Agent 已配置', hasAgent ? 'tarot' : '',
  `${OC_FIX} agents add tarot --bind openclaw-weixin --workspace D:\\law\\OpenClaw\\state\\.openclaw\\workspace-tarot`);
const skills = oc(['skills', 'list', '--agent', 'tarot']);
const hasSkill = /tarot-divination/.test(skills);
line(hasSkill, '塔罗 skill 已安装到 tarot Agent', hasSkill ? 'tarot-divination' : '',
  `${OC_FIX} skills install E:\\塔罗clawbot\\demo\\agent --agent tarot --as tarot-divination --force`);

const modelStatus = oc(['models', 'status', '--agent', 'tarot']);
const defaultModel = modelStatus.match(/Default(?:\s*\([^)]*\))?\s*:\s*(\S+)/i)?.[1] ?? '';
const missingAuth = /Auth readiness could not be confirmed|auth=missing|Missing auth/i.test(modelStatus);
const deepseekReady = /deepseek\//i.test(defaultModel) && Boolean(modelStatus) && !missingAuth;
line(Boolean(defaultModel && /deepseek\//i.test(defaultModel)), 'tarot Agent 默认模型已设为 DeepSeek',
  defaultModel || '', `${OC_FIX} models set deepseek/deepseek-flash`);
line(deepseekReady, 'DeepSeek 认证状态已就绪', deepseekReady ? '认证状态可用；密钥值不会显示' : '认证缺失或当前 CLI 无法确认',
  '确认 D:\\law\\OpenClaw\\state\\.openclaw\\.env 有 DEEPSEEK_API_KEY，并重启 Gateway');

let businessHealth = null;
try {
  const response = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(2500) });
  const data = await response.json();
  businessHealth = data;
  const serviceOk = response.ok && data?.ok === true && data?.cards === 78
    && data?.agentClassify === 1 && data?.agentApplications === 2;
  line(serviceOk, 'ClawBot 业务服务健康', serviceOk
    ? `cards=${data.cards}, spreads=${data.spreads}, classify=v${data.agentClassify}, direct-access=v${data.agentApplications}, gateway=${data.gateway}, reading=${data.reading}`
    : '服务未就绪或缺少最新 classify/direct-access 路由', 'powershell -ExecutionPolicy Bypass -File E:\\塔罗clawbot\\demo\\scripts\\start-stack.ps1');
} catch {
  line(false, 'ClawBot 业务服务健康', '127.0.0.1:8787 无响应',
    'powershell -ExecutionPolicy Bypass -File E:\\塔罗clawbot\\demo\\scripts\\start-stack.ps1');
}

line(businessHealth?.publicPages === 1, '微信抽卡链接已启用 GitHub Pages 模式',
  businessHealth?.publicPages === 1 ? 'H5 link + HTTPS API URL configured' : '当前服务未配置 Pages + 隧道抽卡链接',
  '重新双击 E:\\塔罗clawbot\\demo\\start-clawbot.bat');

let proxyReady = false;
try {
  const response = await fetch('http://127.0.0.1:8788/_local-health', { signal: AbortSignal.timeout(1500) });
  proxyReady = response.ok;
} catch { /* proxy 未启动 */ }
line(proxyReady, '公网 API 的 loopback 过滤代理已监听',
  proxyReady ? '127.0.0.1:8788' : '127.0.0.1:8788 无响应',
  '重新双击 E:\\塔罗clawbot\\demo\\start-clawbot.bat');

let tunnelRunning = false;
try {
  const processList = process.platform === 'win32'
    ? execFileSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    : execFileSync('pgrep', ['-x', 'cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  tunnelRunning = /cloudflared/i.test(processList);
} catch { /* cloudflared 未运行 */ }
line(tunnelRunning, 'Cloudflare Quick Tunnel 正在运行',
  tunnelRunning ? 'cloudflared process detected' : '未检测到 cloudflared 进程',
  '检查 cloudflared 是否已安装，并重新双击 start-clawbot.bat');

try {
  const response = await fetch('http://127.0.0.1:8787/api/agent/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '我要抽一个今日运势' }),
    signal: AbortSignal.timeout(2500),
  });
  const data = await response.json();
  const classifyOk = response.ok && data?.intent === 'divination';
  line(classifyOk, '本机意图分类接口可用', classifyOk ? '示例请求识别为 divination' : '接口未部署或返回意图异常',
    '重新运行 E:\\塔罗clawbot\\demo\\scripts\\start-stack.ps1 以启动最新服务端代码');
} catch {
  line(false, '本机意图分类接口可用', '127.0.0.1:8787/api/agent/classify 无响应',
    'powershell -ExecutionPolicy Bypass -File E:\\塔罗clawbot\\demo\\scripts\\start-stack.ps1');
}

let projectEnv = new Map();
try { projectEnv = parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8')); } catch { /* 尚未生成 */ }
const businessHookToken = projectEnv.get('HOOK_TOKEN') ?? '';
const sameHookToken = Boolean(businessHookToken && config?.hooks?.token && businessHookToken === config.hooks.token);
line(sameHookToken, 'ClawBot 与 Gateway 使用相同 Hooks 凭据', sameHookToken ? '凭据一致（值已隐藏）' : '',
  '重新生成 demo/.env 时使用当前 OPENCLAW_HOME；不要把 token 发到聊天');
const liveMode = projectEnv.get('GATEWAY_MODE') === 'live';
line(liveMode, 'ClawBot 已启用真实 Gateway 模式', liveMode ? 'GATEWAY_MODE=live' : '',
  '检查 demo/.env 的 GATEWAY_MODE=live');

console.log('\n' + '─'.repeat(60));
console.log(bold(`  已完成 ${done} 项，待办 ${todo} 项`));
if (todo === 0) {
  console.log(ok('\n  本机链路检查全部通过；仍需用真实微信发送一条测试消息验证收发。\n'));
} else {
  console.log(warn('\n  按上方逐项修复；本脚本不会打印 API Key 或 Hooks token。\n'));
}
