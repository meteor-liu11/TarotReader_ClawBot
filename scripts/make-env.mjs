/**
 * 从 OPENCLAW_HOME/.openclaw 与 .secrets/ 生成 demo/.env（live 模式）
 *
 * 之所以用脚本生成而不是手写：hook token 是密钥，
 * 让它从文件里流过去，不要出现在任何人的聊天记录或 git 里。
 *
 *   $env:OPENCLAW_HOME = 'D:\law\OpenClaw\state'; node scripts/make-env.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || homedir();

function readToken() {
  // 当前 Gateway 配置是运行时事实来源；优先读取自定义 OPENCLAW_HOME 下的配置。
  const cfgPath = resolve(OPENCLAW_HOME, '.openclaw/openclaw.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (cfg?.hooks?.token) return String(cfg.hooks.token);
  }

  // 仅在当前 Gateway 尚无可读配置时，才回退到项目本地密钥文件。
  const secretFile = resolve(REPO, '.secrets/hook-token.txt');
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  return '';
}

const token = readToken();
if (!token) {
  console.error('\n  ✘ 找不到 hook token。');
  console.error('    请确认 D:\\law\\OpenClaw\\state\\.openclaw\\openclaw.json 已配置 hooks.token。');
  console.error('    如果已配置，请先在当前 PowerShell 设置正确的 OPENCLAW_HOME。\n');
  process.exit(1);
}

const port = process.env.PORT ?? '8787';
const publicBase = process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;
const host = process.env.HOST ?? '127.0.0.1';
const env = `# 由 scripts/make-env.mjs 生成 — live 模式
# 不要提交到 git（已在 .gitignore 里）

PORT=${port}
PUBLIC_BASE_URL=${publicBase}
# 动态 Pages / Quick Tunnel 地址只由 start-stack 进程注入，不写入文件，以免重启后复用过期 URL。
PUBLIC_H5_BASE_URL=
PUBLIC_API_BASE_URL=
PAGES_ORIGIN=
DB_PATH=./data/demo.db
HOST=${host}

SESSION_TTL_MINUTES=10
INTERNAL_HMAC_SECRET=${process.env.INTERNAL_HMAC_SECRET ?? 'demo-internal-secret'}
RATE_PER_MINUTE=5
RATE_PER_DAY=30
WELCOME_CREDITS=5

# ── 真实网关 ──────────────────────────────────────────
GATEWAY_MODE=live
GATEWAY_URL=http://127.0.0.1:18789
HOOK_TOKEN=${token}
AGENT_ID=tarot
CHANNEL=openclaw-weixin
ACCOUNT_ID=${process.env.ACCOUNT_ID ?? ''}

# ── 解读生成 ──────────────────────────────────────────
# template = 内置确定性解读（不花模型钱）
# llm      = 调 OpenAI 兼容接口
READING_MODE=${process.env.READING_MODE ?? 'template'}
OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ''}
OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}
OPENAI_MODEL=${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}
`;

const target = resolve(ROOT, '.env');
writeFileSync(target, env, { mode: 0o600 });

console.log(`\n  ✔ 已写入 ${target}`);
console.log(`    网关模式   live → http://127.0.0.1:18789`);
console.log(`    hook token 已从密钥文件注入（长度 ${token.length}，不显示）`);
console.log(`    解读模式   ${process.env.READING_MODE ?? 'template'}\n`);
