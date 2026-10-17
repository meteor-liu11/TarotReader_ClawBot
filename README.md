# 塔罗 ClawBot · MVP Demo

用来看清「微信触发 → 网页抽卡 → 数据回传 → AI 解读回微信」这条闭环到底怎么落地，
以及**哪些假设成立、哪些会卡住**。

零依赖：Node 内置 `node:sqlite` + `node:http`，不需要 `npm install`。

## 快速开始

```bash
cd demo
cp .env.example .env      # 可选，不建也能用默认值
npm start
```

打开 http://127.0.0.1:8787

左边是**微信私聊模拟器**，右边是后端真实行为。点「放行」→ 发「抽塔罗」→
点链接去网页抽牌 → 回来看右边的事件流和投递 payload。

跑到这一步你已经验证了完整的业务闭环（网关是 mock 的，不会真发微信）。

## 一条命令跑完第 1 周验证清单

```bash
npm run verify
```

会用临时数据库在随机端口拉起服务，跑完自动关掉，不碰你的开发库。
**固定使用 mock 网关，绝不会误发真实微信消息。**

当前结果：**29 项自动检查全部通过，7 项需要真机**。

## 目录

```
demo/
├─ src/
│  ├─ tarot-data.mjs   78 张牌 + 7 种牌阵 + 维度预设（含"动态维度牌阵"）
│  ├─ tarot.mjs        确定性抽牌引擎、意图识别、场景深挖
│  ├─ reading.mjs      五段式解读生成（template 离线 / llm 可选）
│  ├─ db.mjs           SQLite 表结构、白名单、限流、幂等、点数流水
│  ├─ gateway.mjs      OpenClaw hooks/agent 客户端（mock | live）
│  └─ server.mjs       HTTP 服务与全部接口
├─ public/             H5 抽卡页 + 微信模拟控制台
│  └─ deck/            78 张公版 Rider-Waite 牌面（MIT 仓库取得）
├─ agent/
│  ├─ SKILL.md         OpenClaw skill：告诉 Agent 怎么判断意图、怎么深挖、怎么解读
│  └─ openclaw.config.json5   Gateway 配置片段（hooks + 微信通道 + agent）
└─ scripts/
   ├─ verify.mjs       V1–V6 验证清单自动化
   ├─ seed-codes.mjs   生成卡密兑换码
   └─ reset.mjs        重置数据库
```

## 这个 demo 已经验证了什么

### 抽卡仪式（ClawBot 整合版）

正式 `/s/:token` 和无会话预览 `/play` 共用同一套植物系 DOM 仪式 UI；正式会话在视觉流程之后继续调用 ClawBot 服务：

| 步骤 | 交互 | 影响结果 |
| --- | --- | --- |
| **1 洗牌** | 来回拖动牌堆；未达到手势阈值前主按钮保持锁定 | `rounds` / `durationMs` 计入 entropy，并提交到 `/api/shuffle/:token` |
| **2 切牌** | 点击五档厚度之一，让下摞清楚地翻到上层 | `cutPile` 与切牌记录计入 entropy |
| **3 抽牌** | 固定窗口内横向浏览重叠牌扇；轻触先预选，可确认落位或撤回；**所有牌背朝上落位，选齐后统一翻开** | 确认后的 `picks[]` 提交 `/api/draw/:token`，服务端返回真实牌面与正逆位 |
| **4 解读** | 牌面统一揭晓后生成解读；正式会话接着轮询微信投递状态，并保留点数、兑换码和历史功能 | `/api/callback/:token` |

**为什么这样设计**：服务器负责生成可复现、可审计的牌序；真实洗牌时长/次数、切牌厚度与确认的抽牌序号都会进入服务端 entropy。界面只呈现统一牌背，正逆位由服务端确定并在抽齐后揭晓。

**洗牌真的影响结果**：`seed = SHA256(服务端CSPRNG种子 | 手势参数)`。
洗得久 → 牌序不同；但手势参数和种子全部落库，所以**结果完全可复现、可审计**。
实测：同手势 → 完全相同；换手势 → 完全不同。

| 验证项 | 结论 | 证据 |
| --- | --- | --- |
| 78 张牌库 + 牌阵渲染 | ✅ | `/health` → `cards=78 spreads=7` |
| 确定性抽牌（可复现、可审计） | ✅ | 同 seed 同牌阵结果完全一致；`draws.seed` 落库 |
| AI 无法编造牌面 | ✅ | 逐张解读牌名与抽牌结果 100% 一致 |
| 会话一次性 + 过期 + 防重放 | ✅ | 二次抽牌 409、二次回调 409、消费后 409 |
| 20 组并发无串号 | ✅ | 每用户历史记录数恰为 1 |
| 白名单拦截 + 限流 | ✅ | 未放行用户被拒；连续请求触发限流 |
| 模糊情绪问题 → 主动询问占卜 | ✅ | 「还有可能吗」→ `maybe_divination`，不是直接抽牌 |
| 五段式解读 + 免责声明 | ✅ | 结构校验通过，无绝对化承诺 |
| 回注 payload 结构正确 | ✅ | 含 `channel` + `to` + `deliver` + 幂等键 |
| 阻碍位的牌不被误读成"资源" | ✅ | 位置语义（资源位/阻碍位/中性位）参与解读 |

## 这个 demo 还验证不了什么

这三件事**必须真机**，也是上线前真正的风险点：

1. **微信外链能不能正常点开**（V2）— 需要备案域名 + 两个微信号互测
2. **后端主动投递能不能真的送达微信**（V3.5）— 本 demo 的 mock 只打印 payload
3. **微信单条消息的截断阈值**（V4）— 当前解读约 1100 字，可能超限要拆条

## 切到真实微信：四步

本机 Windows OpenClaw 安装在 `D:\law\OpenClaw`，自定义状态目录为
`D:\law\OpenClaw\state`。Gateway 必须在独立 PowerShell 窗口保持运行。
先运行 `& 'D:\node.exe' 'E:\塔罗clawbot\demo\scripts\status.mjs'` 查看实时体检；该脚本会识别此自定义目录且不会输出密钥。

| 项 | 状态 |
| --- | --- |
| OpenClaw CLI | 安装于 D 盘；运行态请用体检脚本确认 |
| `openclaw-weixin` | 插件与账号已配置；重启后须复核通道状态 |
| Gateway | 开机后由一键脚本启动；健康端点 `127.0.0.1:18789/health` |
| hooks + `tarot` Agent | 已配置；token 只保存在本机，不要复制到聊天 |
| 塔罗 skill | 源文件更新后需重新安装到 `tarot` Agent |
| 入站硬拦截 | 一键启动时会检查并安装/启用；首次 capability 授权由用户在提示中确认 |
| ClawBot 业务服务 | 开机后由一键启动器运行；服务未运行时，8787 会拒绝连接 |
| DeepSeek 模型认证 | 只在本机状态目录保存；使用体检脚本核验，不要在聊天粘贴 API Key |

### 本机 Windows 启动步骤

关机后 Gateway 和业务服务都会停止。开机后可以双击 `start-clawbot.bat`；它先确保 HTTP Hooks 允许 `tarot`、入站 guard 已安装/启用，再在 D 盘单独窗口启动或复用 Gateway。只有确认 `before_dispatch` 已注册后，才会在当前窗口启动 E 盘业务服务，并重新选择当前局域网地址：

```powershell
Set-Location 'E:\塔罗clawbot\demo'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-stack.ps1
```

两个 PowerShell 窗口都要保持打开。停止时分别在两个窗口按 `Ctrl+C`。开机后先用 `& 'D:\node.exe' 'E:\塔罗clawbot\demo\scripts\status.mjs'` 检查微信通道；只有 `channels status --probe` 显示未登录/未运行时才需要重新扫码，不必每次启动都生成二维码。如只在电脑本机预览，可加 `-NoLan`；手机要打开微信里的链接时不要加。也可以传入固定地址：`-PublicBaseUrl 'http://电脑局域网IPv4:8787'`。

若启动器提示 8787 已有旧版 ClawBot，先在旧服务窗口按 `Ctrl+C`，再重新双击启动器；它会验证新版本的分类路由后才报告服务就绪。

旧的单服务启动方式仍可用，但它**不会启动 Gateway**：

```powershell
Set-Location 'E:\塔罗clawbot\demo'
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Lan
```

一键启动器会幂等检查 HTTP Hooks 与 `tarot-inbound-guard`：只在配置缺失时开启 `hooks.enabled`、把 `tarot` 加入 `hooks.allowedAgentIds`（保留已有项目），并只在插件缺失或停用时安装/启用。首次安装可能要求审核插件能力；启动器不会自动批准。若 18789 未响应，它会调用 D 盘实际安装入口启动 Gateway，并等待 `127.0.0.1:18789/health` 返回 `live`；随后验证 guard 的 `before_dispatch` 注册，失败时停止而不启动业务服务。`start-local.ps1` 负责在 E 盘生成 live `.env` 并选取局域网地址。模型 Key 仍只保存在
`D:\law\OpenClaw\state\.openclaw\.env` 的 `DEEPSEEK_API_KEY` 项中，绝不要提交到 Git 或发到聊天。

运行状态检查：

```powershell
& 'D:\node.exe' 'E:\塔罗clawbot\demo\scripts\status.mjs'
```

### 强制让显式占卜先拿服务端链接

此前的技能示例把当前微信身份当作 `$env:OPENCLAW_CHANNEL_CONTEXT` 环境变量读取。OpenClaw 官方 `exec` 文档只保证设置 `OPENCLAW_SHELL=exec`，并未保证把当前消息身份注入该环境变量；微信身份应从入站 hook 的上下文读取。即使技能已安装且 `exec` 可用，Skill 仍是模型指引而非强制路由，因此不能靠提示词保证它每次先拿链接。

现在增加了本地 `tarot-inbound-guard` 插件：它在 `before_dispatch` 阶段先调用无副作用的本机分类接口；对于占卜请求，再调用 `/api/agent/inbound`，校验服务端返回的 token 链接，并用服务端原文接管回复。该路径在模型生成回复之前短路，因此不会让模型直接编造牌面来替代链接。未被插件接管的正常聊天继续交给 Agent。

微信里 sender ID 若未直接出现在 `before_dispatch` 上下文，guard 会先读取标准 `senderId`；Tencent Weixin 私聊的 `senderId` 可能为空，因此仅对该渠道再回退到当前入站事件的 `from` 或 `metadata.originatingTo`。腾讯插件的 `weixinMessageToMsgContext` 将本条 `from_user_id` 映射到 `From`、`To` 和 `OriginatingTo`；不使用 `senderE164`、手机号、昵称或用户名代替。随后用两类事件共同的 canonical `messageId` 做精确关联。映射只保存在进程内，10 分钟后过期或在 `before_dispatch` 读取时删除，不写文件、不输出日志。若仍没有明确的字符串 peer ID，继续拒绝创建会话，不猜测或复用其他消息的身份。依据：[Tencent inbound mapping](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/inbound.ts)、[OpenClaw message hooks](https://docs.openclaw.ai/plugins/hooks/messages) 和[hook reference](https://docs.openclaw.ai/plugins/hooks/reference)。
若仍缺少 peer ID，失败回复会附上仅含字段名、字段类型和有/无状态的安全诊断，不包含任何实际 ID 或消息正文，可用于区分 hook 未触发、渠道身份字段缺失、字段类型不符或 `messageId` 未匹配。

一键启动器会在 `demo\.work` 保存 E 盘 guard 源文件的 SHA-256 指纹，并在确认 `message_received` 与 `before_dispatch` 都注册后才启动业务服务。若源文件变更而 Gateway 已运行，启动器不会执行在线 `plugins reload`：当前 Windows 安装的 reload 曾因创建 OpenClaw SDK 符号链接返回 `EPERM`，因此应在 Gateway 窗口按 Ctrl+C，再重跑 `start-clawbot.bat`，让新 Gateway 冷启动加载 E 盘源码。安装新增 `message_received` observer hook 时，OpenClaw 可能显示 capability consent；该 hook 仅读取本条消息的 senderId、messageId 和可用 accountId，不读取/保存消息正文。请检查 E 盘源码及授权说明后再手动确认；启动器不会自动批准。若你修改了 Skill 源文件，需要手动同步时运行：

```powershell
Set-Location 'E:\塔罗clawbot\demo'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-inbound-guard.ps1
```

安装程序从 E 盘链接插件源码，OpenClaw 状态仍在 D 盘；它也会确保 HTTP Hooks 已启用并允许 `tarot`，但不会显示或改写 `hooks.token`。安装程序不会自动批准能力授权。正常开机建议仍使用上面的 `start-clawbot.bat`，它会在启动业务服务前检查运行态；手动排查时可检查插件：

```powershell
Set-Location 'D:\law\OpenClaw'
$env:OPENCLAW_HOME = 'D:\law\OpenClaw\state'
& 'D:\node.exe' 'D:\law\OpenClaw\node_modules\openclaw\openclaw.mjs' plugins inspect tarot-inbound-guard --runtime --json
```

在微信私聊直接发送 **“我要抽一个今日运势”**，无需先回复“申请”。任何微信用户的明确占卜请求都会在服务端首次入站时自动授权，并预期收到服务端生成、10 分钟有效的 `/s/<token>` 链接；服务停机、身份缺失或限流时，不会回牌名。打开链接后，左上角会显示本次会话保存的用户问题；抽牌翻面仪式仍保留，但网页不显示解读正文，只提示返回微信查看。服务端生成的解读仅投递回发起抽牌的微信对话，页面只轮询投递状态。五段逻辑按自然段输出，不带小标题或固定免责声明。`/api/agent/inbound`、白名单管理接口和包含调试事件的 `/api/events` 均仅允许本机访问；调试事件不通过局域网抽卡链接暴露。随后在 `http://127.0.0.1:8787/` 本机控制台检查 `inbound.message` 事件：没有该事件通常表示 hook 没加载或没有接管；有事件但回复没有链接时检查限流和服务端返回结果。

“申请”现在不是使用前置条件：用户直接提出占卜即可由服务端自动开通并创建抽卡链接。单独回复 **“申请”** 也会立即确认开通，但没有必要。本机操作员可通过 `GET http://127.0.0.1:8787/api/agent/applications` 查看显式申请记录；该查询只允许 loopback。服务端 direct-access API 版本号已升级，启动器会拒绝复用旧的白名单门槛进程；先停止 ClawBot 服务窗口，再双击启动器加载 E 盘新代码。那条关于日志权限或定时推送的模型回复不代表这些操作已执行；本轮没有修改日志权限或创建推送。

官方依据：[OpenClaw exec 环境说明](https://docs.openclaw.ai/tools/exec)、[消息 hook 的 before_dispatch 接管方式](https://docs.openclaw.ai/plugins/hooks/messages)、[hook 上下文中的 senderId](https://docs.openclaw.ai/plugins/hooks/reference)、[本地插件安装与 runtime 检查](https://docs.openclaw.ai/plugins/manage-plugins)。

### 手机要能打开抽卡链接

`127.0.0.1` 在手机上指的是手机自己。`start-local.ps1 -Lan` 会按当前默认路由自动挑选局域网地址；
也可以手动固定地址：

```powershell
Set-Location 'E:\塔罗clawbot\demo'
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Lan -PublicBaseUrl 'http://电脑局域网IPv4:8787'
```

若手机仍无法打开链接，检查手机与电脑是否处于同一网络，以及 Windows 防火墙的专用网络访问规则；
不要为此关闭整个防火墙，也不要把本地服务直接暴露到公网。

### 出问题时

```powershell
& 'D:\node.exe' 'E:\塔罗clawbot\demo\scripts\status.mjs'
```

在 PowerShell 中先进入 OpenClaw 实际安装目录，再运行诊断命令（不要在 C 盘用户目录或 E 盘项目目录直接执行 `npm exec openclaw`）：

```powershell
Set-Location 'D:\law\OpenClaw'
$env:OPENCLAW_HOME = 'D:\law\OpenClaw\state'
npm exec openclaw -- channels status --probe
npm exec openclaw -- models status --agent tarot
```

输出中不得包含或转发任何密钥。

### 投递慢是正常的

`/api/callback` 会**立刻返回**解读正文，然后**在后台**把解读投到微信。
那一跳要等 agent 跑完整轮 LLM 生成，实测 **40–90 秒**。
H5 是轮询 `/api/reading/:id` 拿投递结果的，不是同步等 —— 别改成同步。

<details>
<summary>手工检查现有接入配置（备查）</summary>

```powershell
# 使用 D 盘已有安装与状态目录；先显式设置工作目录，避免 npm 临时下载安装
Set-Location 'D:\law\OpenClaw'
$env:OPENCLAW_HOME = 'D:\law\OpenClaw\state'
npm exec openclaw -- plugins list
npm exec openclaw -- channels status --probe
npm exec openclaw -- models status --agent tarot

# 在项目目录重建业务 .env（从当前 Gateway 配置读取 Hooks token，不打印 token）
Set-Location 'E:\塔罗clawbot\demo'
node .\scripts\make-env.mjs
node .\scripts\status.mjs
```

其中 `make-env.mjs` 需要保留 `OPENCLAW_HOME` 环境变量，才能读取 D 盘当前 Gateway 配置。

</details>

## 环境变量

见 [.env.example](.env.example)。最常改的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GATEWAY_MODE` | `mock` | `mock` 只打印 payload；`live` 真发 |
| `READING_MODE` | `template` | `template` 离线确定性解读；`llm` 调 OpenAI 兼容接口 |
| `WELCOME_CREDITS` | `5` | 新用户赠送点数（设为 0 会让高级牌阵直接付不起费） |
| `SESSION_TTL_MINUTES` | `10` | 抽卡链接有效期 |
| `HOST` | `127.0.0.1` | 手机访问改 `0.0.0.0` |

## 接口目录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent/classify` | 本机只读意图分类；仅允许 Gateway 同机 loopback 调用 |
| POST | `/api/agent/inbound` | 微信入站消息 → 意图识别 → 出链接 |
| POST | `/api/agent/whitelist` | 放行 / 封禁用户 |
| GET | `/api/session/:token` | H5 拉取会话与牌阵 |
| POST | `/api/draw/:token` | 确定性抽牌（后端执行，前端只播动画） |
| POST | `/api/callback/:token` | 回传 → 生成解读 → 投递微信 |
| GET | `/api/me/:token` | 点数 + 历史记录 |
| POST | `/api/redeem` | 卡密兑换 |
| GET | `/health` `/api/events` `/api/reading/:id` | 调试 |

## 牌面素材

78 张 Rider-Waite 牌面取自 [mixvlad/TarotCards](https://github.com/mixvlad/TarotCards)（MIT），
原始画作 1909 年出版，已进入公有领域。
