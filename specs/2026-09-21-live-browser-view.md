# Live Browser View — 方案

**日期**: 2026-09-21
**状态**: **Phase 1 已实现**（crewly 1.20.74 / extension 0.4.16）；Phase 2、3 未开工
**参照**: Muse 的 "Browser · Reading page" 卡片 + 全屏 "Take control of the browser / Stop the task"

## 0. 一句话

让用户在聊天里（OSS 前端、PWA、手机 App）**实时看到 agent 正在操作的浏览器画面**，并能**随时接管或叫停**。分三期：先用现有截图能力做"准实时"卡片（零扩展改动），再上 CDP screencast 做真流，最后做接管/叫停。

## 1. 现状盘点（都已存在，直接复用）

| 层 | 已有 | 缺 |
|---|---|---|
| Chrome 扩展 (0.4.15) | `debugger` 权限；`cdp-input.ts` 维护一个共享的 `chrome.debugger` 会话；`cdp-screenshot.ts` 用 `Page.captureScreenshot`（PNG，Retina 感知），退化到 `captureVisibleTab`；per-tab `bindTab/unbindTab`；接管横幅（agent 名 + goal） | 没有 `Page.startScreencast`；截图只有 PNG（大）；没有"用户接管中"的状态 |
| OSS backend | `/api/browser/*` 全套动作（navigate/click/fill/screenshot/fullPageScreenshot/…）；`browser-bridge`（LAN WS）+ `browser-relay-adapter`（Cloud relay）两条路；tab bindings 按 agent session | 没有"浏览器会话"这个一等对象；截图是 agent 拉取用的，不广播给人看 |
| Relay | WS `maxPayload` 1 MiB；HTTP queue（Mongo）+ `?wait=` 长轮询 | 免费 relay 无配额（见 relay_review_followups）；持续推帧会把 Mongo queue 打爆 |
| 聊天面 | OSS team-chat（WS 实时）；chat-v2 消息有 `attachments`；PWA cloud chat；手机 App（Expo RN，4 tab） | 手机 App 目前**不渲染图片**（`mobile/src` 没有 Image/Markdown 组件）；PWA 聊天里没有"工具卡片"这种消息类型 |
| 隐私 | remote-browser skill 已有 takeover banner；`slack-post`/`reply-channel` SKILL.md 有隐私段落 | 今天 Ella 因为没法贴图把带地址/账号的截图发到了公网 artifact —— 画面只能出现在 owner 面前的表面，这是硬约束 |

## 2. 目标体验

1. agent 一开始操作浏览器，聊天里出现一张 **Browser 卡片**：标题 = 当前动作（"Opening Sunrun homepage" / "Reading page"），下面是**会刷新的画面缩略图**，按钮 "Open browser"。
2. 点开 → 全屏实时画面，顶部 "Checking link · Browsing sunrun.com"，底部两个按钮：**Take control of the browser** / **Stop the task**。
3. Take control：agent 暂停，用户在这个画面里直接操作（手机上就是远程操作 Mac 上的 Chrome），比如自己登录；点 "Give control back" agent 接着干。
4. Stop：agent 停止当前浏览器任务，卡片状态变 "Stopped by you"。

## 3. 架构

```
Chrome (扩展)                OSS backend                      viewers
─────────────                ───────────                      ───────
Page.captureScreenshot  ──►  BrowserSessionService  ──WS──►  OSS 前端 BrowserSessionCard / BrowserPanel
Page.startScreencast    ──►    {agentSession, tabId,  ──relay►  PWA / 手机 App（同一张卡）
(Phase 2)                       goal, status, lastFrame,
                                control: agent|user}
Input.dispatch* ◄──────────  用户接管时的输入回传 (Phase 3)
```

新增一个一等对象 **BrowserSession**（内存 + 可选落盘做审计）：

```ts
interface BrowserSession {
  id: string;
  agentSession: string;        // 谁在开
  tabId: number; url: string; title: string;
  goal?: string;               // 来自 CREWLY_AGENT_GOAL / --goal，和横幅同源
  status: 'navigating' | 'reading' | 'acting' | 'waiting_user' | 'stopped' | 'done';
  lastAction: string;          // "Clicked 'Sign in with Email'"
  control: 'agent' | 'user';
  frame: { jpegBase64: string; w: number; h: number; ts: number } | null;
  startedAt: number; endedAt?: number;
}
```

生命周期：`bindTab` 创建；每个 `/api/browser/*` 动作更新 `lastAction/status` 并触发一帧；`unbindTab`/agent 回合结束 → `done`；用户 Stop → `stopped`。

## 4. 分期

### Phase 1 — 准实时卡片 ✅ 已实现

实现与原方案的差异（都是简化，不是缩水）：

- **帧不走 WS，走 REST。** `GET /api/browser/sessions/:id/frame` 直接返回图片字节，前端用 `<img src>` 指过去。好处：图片从不进入前端应用状态（没有东西可以被误 log、误序列化进聊天消息、误持久化），而且本地前端根本不经过 relay。
- **没有 subscribe/unsubscribe 协议。** "谁在看" = "谁最近取过帧"，5 秒自然过期。少一套状态机，也就少一处会不同步的地方。
- **BrowserSession 的 id 就是 agentSession**（bridge 本来就是一个 agent 绑一个 tab），不另造 id。
- **`control` 字段推迟到 Phase 3**，因为 Phase 1 没有任何东西会写它。
- **Stop 按钮已经有了，但只结束「可观看会话」**，不打断 agent —— 真正的抢断要 agent 侧理解「被抢」，那是 Phase 3。

落地清单：

| 文件 | 作用 |
|---|---|
| `backend/src/services/browser/browser-session.service.ts` | 会话登记 + 帧抓取 + 按「有没有人看」决定频率 |
| `backend/src/controllers/browser/browser.controller.ts` | 三条 transport 路径的单一汇合点挂钩 `noteBrowserSessionAction`；4 个新 handler |
| `backend/src/controllers/browser/browser.routes.ts` | `GET /sessions`、`GET /sessions/:id`、`GET /sessions/:id/frame`、`POST /sessions/:id/stop` |
| `frontend/src/pages/BrowserView.tsx` + `components/Browser/BrowserSessionCard.tsx` | `/browser` 页面，侧栏 TOOLS 组 |
| `chrome-extension/src/cdp-screenshot.ts` | `format`/`quality`/`scale` 三个可选参数；**不传就完全是原来的行为** |

### Phase 1 原方案（保留作对照）

- 扩展的 `screenshot` 动作加 `format:'jpeg', quality:55, scale:0.5`（CDP 原生支持；PNG 现在一帧几百 KB，JPEG 半分辨率 ≈ 30–80 KB）。这是唯一的扩展改动，而且向后兼容（不传就还是 PNG）。
- backend `BrowserSessionService`：
  - 每个 browser 动作完成后抓一帧；会话活跃且**有人在看**时每 1.5 s 补一帧，没人看时 10 s 一帧只更新缩略图。
  - 通过现有 event bus 发 `browser:session` / `browser:frame`，前端 WS 订阅。
  - 卡片本身是一条 chat-v2 系统消息（`attachments: [{ kind: 'browser-session', sessionId }]`），所以 PWA 和手机端天然收到；帧不走聊天消息，走单独订阅。
- 前端：`BrowserSessionCard`（缩略图 + 状态 + Open）和 `BrowserPanel`（大图，1.5 s 刷新）。
- relay 路径：帧只在 viewer 订阅时经 relay 推，限 ≤1 fps、≤150 KB/帧；用 relay WS（1 MiB 上限够用），**不要走 HTTP queue**（会往 Mongo 写）。
- 顺带得到：动作级截图序列 = computer-use 那期没做的"审计回放"数据源。

### Phase 2 — 真流（CDP screencast）

- 扩展：`Page.startScreencast({format:'jpeg', quality:45, maxWidth:900, everyNthFrame:1})`，`chrome.debugger.onEvent` 收 `Page.screencastFrame` → 立刻 `Page.screencastFrameAck`（不 ack 就停）→ 帧走 bridge WS（LAN）或 relay WS。共享 debugger 会话已在 `cdpEnsureAttached` 里，不会二次 attach。
- backend 做扇出 + 背压：只保留最新一帧（丢旧不排队），viewer 掉线 3 s 后 `Page.stopScreencast`。
- LAN 下能到 5–10 fps；relay 下按 viewer 的 ack 节流到 2–3 fps。
- 不做 WebRTC：多一套信令、多一个 TURN，收益不值。

### Phase 3 — 接管 / 叫停

- **Stop the task**：`POST /api/browser/sessions/:id/stop` → 给 agent 的 PTY 发中断（Esc），pool 里对应 WI 标 `cancelled_by_owner`，`unbindTab`，`stopScreencast`，卡片 → stopped。
- **Take control**：`control='user'` → 之后 agent 的任何 `/api/browser/*` 调用返回 `409 user_has_control`（skill 收到就等，不重试），画面继续流。
  - 桌面（同一台 Mac）：`chrome.tabs.update(tabId,{active:true})` 把那个 tab 拉到前面，用户直接用真 Chrome。
  - 手机 / 异地：远程操作 —— 画面上的 tap/滑动/键入 → `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent`（`cdp-input.ts` 里 click/type 已经是这套）。坐标按帧尺寸 → 页面 CSS 像素换算。
- **Give control back**：`control='agent'`，backend 往 agent 塞一句 `[BROWSER] Owner took over at 19:08, page is now <url>/<title>. Continue.`，agent 接着干（不需要它知道用户做了什么，只需要知道现在在哪）。
- 密码/验证码永远是用户在接管态自己输，agent 不碰 —— 这正是 Muse 截图里那个登录场景。

## 5. 隐私与安全（硬约束）

1. 帧**只**推给 owner 在看的表面（OSS 前端、owner 自己的 PWA/手机）。**绝不**把帧当附件发进 Slack 频道或任何多人面。Ella 今天那件事就是反例。
2. 接管态的帧不落盘、不进审计（用户在输密码）；agent 态的动作截图可落盘作审计回放，默认保留 24 h。
3. 一个 tab 同一时间只能有一个 controller（agent 或 user），状态在 backend 单点。
4. `chrome.debugger` attach 会在 Chrome 顶部显示 "Crewly 正在调试此浏览器" —— 现在就有，不是新暴露。
5. relay 免费无配额的问题（relay_review_followups）在流式帧下会被放大；Phase 1 上线前至少加 per-userId 的帧速率上限。

## 6. Chromium 替代方案

给没装 Chrome 扩展的机器（VPS 上的 steamfun-ops 这种）：backend 用 Playwright 起 Chromium，`page.context().newCDPSession(page)` 之后 screencast / Input 那套 CDP 命令一模一样。做法是把 `BrowserSessionService` 后面抽成 provider 接口（`extension` | `chromium`），Phase 1 的接口设计时预留，Phase 2 之后再补 chromium provider。

**推荐先做 Crewly in Chrome**：用户真实登录态就在那里（SunRun 这类必须登录的站点只能这么办），Chromium 是补位不是主路。

## 7. 工作量（粗估）

| 期 | 内容 | 估 |
|---|---|---|
| 1 | JPEG 截图参数 + BrowserSessionService + 卡片/面板 + relay 订阅 | 2–3 天 |
| 2 | 扩展 screencast + 扇出/背压 + 发布扩展 | 3–4 天 |
| 3 | Stop / Take control / 远程输入 / Give back | 3–5 天 |

前置：手机 App 要能显示图片（加 `expo-image`），而且 App 还没发 EAS；PWA 要加一种"工具卡片"消息类型。

## 8. 不做 / 待定

- 不做 WebRTC。
- 不做录屏回放 UI（Phase 1 的截图序列先存着，UI 另开）。
- 待定：多 viewer 同时看一个会话是否允许（先只允许 owner）。
