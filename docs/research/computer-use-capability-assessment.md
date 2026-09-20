# Crewly「Computer Use」能力评估与设计方案

> 状态：评估 + 设计，**不含开发**。2026-09-20。
> 范围：agent 操控「屏幕上的东西」的能力——浏览器、Electron 应用、原生桌面。
> 目标形态：**无人值守也能完成复杂任务**（人只在不可逆动作上把关）。
> 证据来源：本仓库代码与 skill 脚本（每条判断都标了出处），未做线上实测的地方在第 9 节单独列出。

---

## 1. 一句话结论

Crewly 现在有**三条**操控线，成熟度差距很大：

| 线 | 载体 | 成熟度 | 一句话 |
|---|---|---|---|
| 浏览器 | Crewly in Chrome（扩展 + `remote-browser` skill） | **生产级** | 真 Chrome、真登录态、每 agent 独占 tab、有接管横幅、可跨机器（relay） |
| Electron / Chromium 应用 | `desktop-app-control`（Vercel agent-browser over CDP） | 可用但窄 | 只能控 Electron 应用，且应用必须带 `--remote-debugging-port` 启动 |
| 原生桌面 | `computer-use` skill（screencapture + AppleScript/JXA） | **原型级** | 能截屏、能按坐标点、能打字——但纯坐标、无权限处理、无审批、无接管提示、仅 macOS、仅本机 |

所以「有没有桌面 take control」的答案是：**机制上有，产品上没有**。今天让一个 agent 去操作 Finder / Numbers / Xcode 是做得到的，但它会在没有任何提示、任何审批、任何记录的情况下动你的鼠标和键盘，而且一旦 macOS 没给权限它只会静默失败。这不是能交给客户的东西。

差距不在「能不能点」，而在**感知**（agent 看到的是像素，不是元素）、**安全**（零审批）、**接管**（人不知道 agent 在动、也停不下来）和**触达**（只能本机 macOS）。

---

## 2. 现状盘点

### 2.1 浏览器线：Crewly in Chrome

```
agent → bash remote-browser/execute.sh → POST /api/browser/* → WS → Chrome 扩展 → 真实 tab
                                                  ↑
                                        relay（跨机器 / 门户 / 手机）
```

- **动作面**（`backend/src/controllers/browser/browser.routes.ts`，30 个端点）：navigate / click（选择器或坐标）/ fill / type / press-key / hover / scroll / select-option / set-file-input / wait-for-selector / screenshot / full-page-screenshot / read-text / search-text / get-element / get-interactive-elements / execute-js / cookies / local-storage / console / tabs / bind / unbind。
- **输入实现**（`chrome-extension/src/cdp-input.ts`）：CDP `Input.dispatchPointerEvent` + `dispatchMouseEvent` 双链，老版本 Chrome 自动回退——这是"真点击"，不是 JS 合成事件，所以框架事件、反自动化检测都过得去。
- **并发模型**：每个 agent `bindTab` 独占一个 tab，多 agent 不抢活动 tab（ext 0.4.14/0.4.15 补齐）。
- **人机接管**：takeover 横幅显示 agent 名 + 目标（`--goal` / `CREWLY_AGENT_GOAL`），用户看得见谁在动。
- **触达**：LAN 直连或 Cloud relay 两条握手路径，门户和手机 App 都能发起。
- **运行时无关**：纯 HTTP + bash，Claude Code / Codex / Gemini CLI / in-process DeepSeek 都能用；crewly-pro 另有 5 个 MCP 工具（`browser_navigate/screenshot/read_text/execute_script/get_tabs`）给支持 MCP 的运行时。

**局限**：只有 DOM 世界。原生对话框（文件选择、系统弹窗、Touch ID）、扩展弹窗、PDF 查看器、非 Chromium 浏览器，都够不着。

### 2.2 Electron 线：`desktop-app-control`

- 包装 Vercel Labs 的 `agent-browser`，走 CDP。核心卖点是 **accessibility snapshot + ref**（`@e12` 这种引用），agent 按 ref 操作而不是坐标——这正是原生桌面线缺的东西。
- 动作：scan / launch / connect / snapshot / click / fill / press / type / screenshot / get-text / scroll / tab / eval。
- **硬门槛**：目标应用必须以 `--remote-debugging-port` 启动（skill 的 `launch` 会帮你重启它），所以「控制用户正在用的 Slack」等于先把用户的 Slack 关了重开。
- **外部依赖**：需要 `npm install -g agent-browser` + `agent-browser install`，安装态未由 Crewly 管理。
- 覆盖：VS Code、Slack、Discord、Notion、Figma、Spotify、Chrome 等 Electron/Chromium 应用；原生 Cocoa 应用一概不行。

### 2.3 原生桌面线：`computer-use`（重点）

位置：`config/skills/agent/computer-use/`，v2.1.0。`marketplace/computer-use/`（v2.0.0）**不是陈旧副本，是一个分叉**——它缺 `key`/`drag`/`find`/`click-text`，但有 canonical 版没有的 `read-ui`/`get-text`（System Events AX 读界面）和 `check-accessibility`。两边动作集不同，谁也不是谁的子集。（2026-09-20 核实并更正，此前本文档写成「陈旧副本」是错的。）

| 动作 | 实现 | 备注 |
|---|---|---|
| `screenshot` | `screencapture -x` + JXA 读 `backingScaleFactor` 换算 Retina | 支持 `grid`（每 100pt 画红线）和 `crop`，帮 agent 估坐标 |
| `click` (left/right/double) / `move` / `drag` / `scroll` | JXA + CoreGraphics `CGEvent` | 纯屏幕点坐标 |
| `type` | `System Events keystroke` | 直接键入到当前焦点——**包括密码框** |
| `key` | `key code` / `keystroke ... using {modifiers}` | 任意组合键，**包括 ⌘Q、⌘⌫、⌘⇧⌫** |
| `focus` / `open-url` / `list-apps` | AppleScript `activate` / `System Events` | |
| `find` | 全分辨率截屏 → Pillow 像素启发式 | 三种模式：`button`=找亮色矩形，`avatar`=找彩色圆，`color`=找目标 RGB。**不是 OCR，不是 accessibility tree** |

**它的问题不是功能少，是四件更基础的事都没有**：

1. **权限**：`screencapture` 要「屏幕录制」权限，`System Events` 要「辅助功能」权限，脚本里没有任何检测、引导或可读的错误映射（grep `assistive|Accessibility|Screen Recording|permission` 为空）。没授权时表现是黑图或 `osascript` 报 `-1719`，agent 会以为「点了但没反应」然后一直重试。更麻烦的是 macOS 把权限授给**发起进程**——是 Terminal、是 iTerm、还是 crewly 后端的 node，取决于 agent 从哪起的，用户根本不知道该给谁授权。
2. **审批**：in-process 运行时的 `bash_exec` 有 `BLOCKED_COMMAND_PATTERNS` 和 `APPROVAL_REQUIRED_BASH_PATTERNS`，里面**没有 osascript / computer-use**；`connector-access` 的角色门也不覆盖桌面。结论：任何被分配了这个 skill 的 agent（developer / generalist / designer / qa）可以零审批地点任何东西、打任何字、按任何组合键。
3. **接管**：浏览器有横幅，桌面什么都没有。鼠标自己动，用户不知道是谁、为什么、怎么停。没有全局中止热键，没有「用户动了鼠标就暂停」。
4. **并发**：一台 Mac 一套鼠标键盘焦点。两个 agent 同时用会互相打架（浏览器线用 per-tab binding 解决了同类问题，桌面没有任何锁）。

其他：仅 macOS（无 xdotool / SendInput 等分支）；仅本机（relay / 门户 / 手机都没有桌面控制入口）；无动作日志、无前后截图留存；有一个 `computer-use.test.ts` 但本次未核实其覆盖真实动作还是 mock。

### 2.4 其他相关件

- **`vnc-browser`**：目录里**只有 SKILL.md，没有 execute.sh**——它描述的「macOS 屏幕共享 → noVNC → cloudflared 让人远程接管」功能并不存在，但已经出现在 agent 的 skill 目录里，agent 会以为能用。方向也相反：它是让**人**接管，不是让 agent 控制。
- **`screenshot-compare`**：用 Gemini Vision 比两张截图，出结构化 diff。是 QA 工具，不是控制能力，但它证明「让模型看图」这条路已经通了。
- **agent 能看图**：in-process 运行时的 `read_file` 支持 png/jpg/webp 等（`tool-registry.ts` `IMAGE_EXTENSIONS`），Claude Code / Codex / Gemini CLI 原生看图。所以「截屏 → 看 → 动」的闭环在每个运行时都成立，瓶颈不在看，在看到的东西太原始。
- **`rednote-reader`**（marketplace）：用 Accessibility API + JXA 读小红书桌面版——证明**AX 树在这个代码库里已经有人用过**，感知层不是从零开始。
- **Tauri 桌面 app**（`desktop/`）：只有 `start_backend / stop_backend / get_backend_status / get_app_version` 四个命令，没有任何截屏或输入能力。但它是唯一一个**签名的、稳定的、用户认识的进程**——这一点在 Helper 的落地里很关键。

---

## 3. 参照系：业界的「computer use」长什么样

**Anthropic Computer Use tool**（`computer_20250124`）：动作集 `screenshot / left_click / right_click / middle_click / double_click / triple_click / left_click_drag / left_mouse_down / left_mouse_up / mouse_move / key / hold_key / type / scroll / wait / zoom / cursor_position`。关键约定：截图缩放到固定分辨率（≤1280 宽），模型在缩放坐标系里思考，工具负责换算；`zoom` 让模型放大局部；每一步都返回新截图。参考实现用 Docker + Xvfb + xdotool，天生隔离。

**OpenAI CUA / Operator**：同样是截图 + 坐标动作，多了明确的**安全检查回调**——遇到可能有害/不可逆的动作，模型输出 `pending_safety_check`，宿主必须确认后才继续；并且默认跑在隔离的远程浏览器里。

**AX-tree 路线**（macOS Accessibility、Windows UIAutomation、agent-browser 的 snapshot）：不看像素看元素树，agent 拿到 `@e12 button "Save"` 这种引用，点击按引用。token 省 80%+，对分辨率/主题/滚动位置不敏感。缺点是不是所有应用都暴露完整 AX 树（Electron 好、游戏和自绘 UI 差）。

**对照结论**：

| 维度 | 业界 | Crewly 原生桌面线 |
|---|---|---|
| 动作集 | 完整（含 zoom、hold_key、triple_click、wait） | 缺 zoom / hold_key / triple_click / wait / cursor_position |
| 坐标约定 | 缩放到固定分辨率，工具换算 | 直接用屏幕点，agent 要自己从截图估（grid 辅助） |
| 元素感知 | AX 树 / Set-of-Marks | 像素启发式 `find` |
| 安全检查 | 模型标记 + 宿主确认 | 无 |
| 隔离 | Docker / 远程浏览器 | 直接在用户的桌面上 |
| 人机切换 | 明确的 pause / handoff | 无 |

---

## 4. 缺口清单

按「现状证据 → 后果 → 要补什么」列。编号供第 6 节引用。

### G1 感知：agent 看到的是像素不是元素
- 现状：`find` 靠亮色矩形/彩色圆/RGB；没有 AX 树，没有 OCR。
- 后果：坐标估错率高、每步都要发整张截图（token 重）、换个主题/分辨率/窗口位置就失效、agent 无法回答「屏幕上有哪些按钮」。
- 要补：AX 树快照（带 ref）、OCR、Set-of-Marks 截图、`zoom`。

### G2 权限（TCC）：没有检测、引导和可读错误
- 现状：脚本不检查屏幕录制/辅助功能权限；失败表现为黑图或 osascript 错误码。
- 后果：首次使用几乎必失败，且失败方式让 agent 误判为「动作没生效」而重试；用户不知道该给哪个进程授权。
- 要补：preflight（`CGPreflightScreenCaptureAccess` / `AXIsProcessTrusted`）、把错误映射成人话、稳定的被授权进程。

### G3 安全：零审批
- 现状：`bash_exec` 的阻断/审批模式不含 osascript；角色门不含桌面；`type` 会打进密码框；`key` 能发 ⌘Q。
- 后果：一个被 prompt 注入的 agent 可以在用户桌面上做任何事，无任何摩擦。
- 要补：桌面动作分级、不可逆动作走审批、安全输入检测、应用白/黑名单。

### G4 人机接管：用户不知情、停不下来
- 现状：浏览器有横幅；桌面无任何 UI，无中止热键，无输入冲突检测。
- 后果：体验上是「电脑闹鬼」；出问题时用户唯一的办法是拔网线或杀进程。
- 要补：桌面横幅、全局中止热键、用户动鼠标即暂停、交接协议。

### G5 并发：一个桌面多个 agent
- 现状：无锁。
- 后果：两个 agent 同时用会互相破坏对方的焦点和输入。
- 要补：桌面控制互斥锁（per machine，带持有者和 TTL）+ 排队；长期用虚拟显示/多用户会话隔离。

### G6 审计与可回放
- 现状：bash skill 绕过 in-process 的 audit log；无动作日志、无前后截图。
- 后果：出了事说不清 agent 做了什么；无法 debug；无法给客户交代。
- 要补：结构化动作记录 + 前后截图，进现有 audit 体系，前端可回看。

### G7 触达：仅本机、仅 macOS
- 现状：无 relay 入口；无 Windows/Linux 后端；无头服务器（steamfun-ops）没有显示。
- 后果：门户/手机不能发起桌面任务；不能控另一台机；Linux 上的 agent 完全没有这项能力。
- 要补：桌面控制经 relay、Linux（Xvfb + AT-SPI）/ Windows（UIAutomation + SendInput）后端。

### G8 可靠性原语缺失
- 现状：没有 `wait`（等元素出现 / 等应用到前台 / 等界面静止）、没有多显示器处理、没有 cursor_position。
- 后果：agent 只能靠 sleep 猜时序，动画期间点击落空。
- 要补：`wait-for`、显示器枚举与坐标归一。

### G9 可发现性与指引
- 现状：目录里只有一行描述；没有 SOP 说明三条线怎么选；`vnc-browser` 是空壳但对 agent 可见；marketplace 有陈旧副本。
- 后果：agent 该用 remote-browser 的时候用 computer-use 去点浏览器，或者反过来；agent 尝试调用不存在的 vnc 脚本。
- 要补：决策指引（先 API → 再 DOM → 再 AX → 最后像素）、删空壳、两个分叉共用一套护栏。

### G10 与 in-process 运行时的整合
- 现状：DeepSeek 等 in-process agent 只能通过 `bash_exec` 调 skill，然后再 `read_file` 看图，两步一轮。
- 后果：可用但慢、易错，弱模型更容易在坐标上翻车。
- 要补：原生 `computer` 工具，一次调用返回新截图。

### G11 任务层：没有拆解、检查点、恢复和预算
- 现状：桌面能力只到「单个动作」这一层，没有任何东西负责把一个 40 步的任务组织起来。
- 后果：这是**复杂任务失败的主因**（见第 5 节），也是「无人值守」做不到的根本原因。
- 要补：Task Runtime（子目标 / 检查点 / 选路 / 恢复 / 预算）。

---

## 5. 设计

### 5.1 核心判断：复杂任务失败的原因不是「点不准」

行业里 GUI agent 在长任务上的成功率普遍卡在 60–80%，失败案例几乎都不是「坐标点偏了」，而是这四种：

1. **走了不该走的路**——本来一个 API 调用能做的事，agent 打开了 GUI 点了 30 步
2. **中途漂了**——第 15 步弹了个对话框，agent 没意识到，后面 20 步全在错的状态上操作
3. **以为做完了**——「我已经保存了」，其实保存对话框还开着（今天 DeepSeek 那个问题的桌面版）
4. **做了不可逆的事**——发出了不该发的邮件，没有任何一道闸

所以设计重心不在「动作集多全」，而在**选路、验态、恢复、闸门**。动作集是最容易的部分。这也意味着 **G11 比 G1 更靠近问题本质**——但 G11 建立在 G1 之上，所以实施顺序上 G1 仍在前。

### 5.2 三条原则

**一、能不用屏幕就不用屏幕。** 这是 Crewly 相对 Operator 这类产品最大的优势，也最容易浪费掉。我们已经有 190 个 skill、Gmail/Drive/Calendar/Slack 连接器、浏览器 DOM 控制。「发邮件」应该调 `gmail-send`，不是打开 Mail.app。GUI 是**最后一级**，不是默认。

**二、agent 操作元素和状态，不是坐标。** 像素只留作兜底。这对弱模型尤其关键——今天的教训是 DeepSeek 连工具名都会写错（`Bash` vs `bash_exec`），让它从截图估坐标更是灾难；而给它 `@e12 button "Save"` 它就能用。

**三、每一步都有期望态，每个任务都有检查点。** agent 说「做完了」不算数，Helper 观测到的才算数。这是今天加进 harness 的 `act, then check` 在桌面上的落地。

### 5.3 架构：一条控制阶梯 + 五个部件

```
              任务："把桌面上三个 PDF 合并、改名、传到 Drive、Slack 发链接"
                                      │
                    ┌─────────────────▼──────────────────┐
                    │  Task Runtime（拆解 / 检查点 / 恢复）  │
                    └─────────────────┬──────────────────┘
                                      │ 每个子目标选最低一级能做的路
  ┌────────────┬─────────────┬────────┴──────┬──────────────┐
  ▼            ▼             ▼               ▼              ▼
L0 API/CLI   L1 DOM       L2 AX 树        L3 像素         L4 人
(skills、    (remote-     (原生应用       (自绘 UI、      (CAPTCHA、
 connectors)  browser)     元素引用)       游戏、兜底)      2FA、不可逆)
                                      │
                    ┌─────────────────▼──────────────────┐
                    │     Desktop Helper（唯一受信执行者）    │
                    │  感知 · 动作 · 守卫 · 在场提示 · 审计   │
                    └────────────────────────────────────┘
```

### 5.4 部件 1：Desktop Helper —— 唯一的受信执行者

一个签名的常驻进程（首选并进 `desktop/` 的 Tauri app 做 sidecar，次选独立 Swift menubar app）。所有感知和动作都经它，skill 不再直接调 osascript。

**为什么必须是一个进程**：macOS 把权限授给*发起进程*。现在 agent 从 Terminal 起就要授 Terminal，从后端起就要授 node，用户根本搞不清（G2）。收成一个进程 → **授权一次，永久有效**。它同时天然是互斥锁持有者（G5）、中止热键监听者、横幅显示者（G4）、审计记录点（G6）——这些都需要一个常驻点。

**对外两个口**：本机 `127.0.0.1:<port>/desktop/*`；以及注册到 relay（role=`desktop`，复用 browser-proxy 的注册与 `relay_to` 转发模式），门户和手机 App 由此能控它，也能控另一台 Mac（G7）。

### 5.5 部件 2：感知层 —— 「场景图」而不是截图

Helper 每次感知返回统一的元素列表，来源合并：

- **AX 树**（`AXUIElement`，原生应用；`rednote-reader` 已有可复用代码）
- **DOM**（前台是 Chrome 时直接向扩展要 interactive elements——两条线在这里汇合）
- **OCR**（macOS Vision `VNRecognizeTextRequest`，本地免费、中英文都行，覆盖 AX 没暴露的文字）
- **截图**（Set-of-Marks 编号框叠加；缩放到 ≤1280 宽，坐标系对齐 Anthropic 约定）

输出一种格式，agent 只需学一套：

```json
{"ref":"@e12","role":"button","name":"Save","frame":[832,411,80,28],"enabled":true,"source":"ax"}
{"ref":"@e13","role":"text","name":"未命名.pdf","frame":[...],"source":"ocr"}
```

还有一个便宜但关键的东西：**帧差**。两次感知之间哪些元素变了，直接告诉 agent「出现了新窗口 `Save As`」，而不是让它自己对比两张截图。这是治「中途漂了」的第一道感知支撑。

### 5.6 部件 3：动作层 —— 按引用、自带验证、自带回退

每个动作三段式：**前置等待 → 执行 → 后置验证**。

```
click @e12
  ├─ wait:   @e12 存在且 enabled（最多 5s）
  ├─ do:     AXPress → 失败则 frame 中心 CGEvent 点击 → 再失败则键盘导航
  └─ verify: 调用方声明的期望态（如「窗口标题变为 *.pdf」/「@e12 消失」）
             不满足 → {ok:false, reason:"postcondition_failed", scene:<新场景图>}
```

**期望态是动作参数的一部分，不是可选项。** agent 不写就用「场景有变化」做弱验证。这一条直接杀掉「以为做完了」。

动作集对齐 Anthropic 规范并补上引用式变体：`screenshot / snapshot / click(@ref|xy) / double_click / triple_click / right_click / drag / mouse_move / scroll / type / key / hold_key / wait / zoom / cursor_position / focus / open-url`。

### 5.7 部件 4：Task Runtime —— 复杂任务真正的关键（G11）

这是「无人值守完成复杂任务」的核心，其余都是基础设施。

**拆解成带检查点的子目标。** 40 步的任务不能是一个 40 步的循环。拆成 5 个子目标，每个有一个**可观测的检查点**（「Preview 里打开了合并后的文件，页数 = 三个源文件之和」），每个子目标是一个有步数上限的小循环（如 12 步）。检查点过了才进下一个；没过就在子目标内恢复或重试，**绝不带着错误状态往下走**——治「中途漂了」。

**选路器。** 每个子目标先问：有 skill 吗？有 DOM 路径吗？都没有才下到 AX/像素。「传到 Drive」永远是 `drive-upload`，不是打开浏览器拖文件——治「走了不该走的路」。

**恢复库。** 桌面上的意外高度重复，可以枚举：模态对话框、权限请求、应用无响应、焦点跑掉、需要登录、磁盘满。每种一个处理器——模态对话框：读文字和按钮，用小上下文让模型决定（多数是「取消」或「不保存」）；需要登录：直接升级到 L4。恢复失败三次 → 升级，不硬撑。

**预算。** 每个任务有步数、时间、token 三重上限，超了停下汇报——今天 loop detector 的桌面版。

这一层可**复用现有的 work-item + verify-enforcement**（autonomous harness P0–P5 那套），只是检查点的验证方式从「跑测试」变成「看场景图」。

### 5.8 部件 5：守卫 —— 让无人值守依然安全（G3、G4）

**不可逆动作用异步确认，不阻塞机器**——这是「无人操作」和「有人把关」的平衡点：

```
agent 要发邮件/删文件/付款
  → Helper 识别为不可逆（AX 角色 / 按钮文字含 Send·Delete·Pay / agent 自己标注）
  → 暂停该子目标
  → 截图 + 意图推到 owner 的 Slack / 手机
  → owner 点一下批准
  → 继续
```

复用现有 approval queue 和 Slack 通道。人不用坐在电脑前，但每个不可逆动作都经过人。

其他守卫：安全输入检测（焦点在 `AXSecureTextField` 就拒绝 `type`）、应用白/黑名单（按 team/role，默认拒绝系统设置、钥匙串、密码管理器）、全局中止热键、用户一动鼠标就暂停并交出控制（`CGEventTap` 区分真实 HID 与 agent 合成事件）、每步审计带前后截图。

**高风险任务默认进沙箱。** 不需要登录态的任务（如「测试这个安装包」）起独立 macOS 用户会话或轻量 VM（Tart）跑，Linux 上用 Xvfb。用户桌面只留给真需要登录态的任务。

### 5.9 让它越用越强：把成功轨迹沉淀成 SOP

每次任务成功，Task Runtime 把「子目标 → 动作序列（带元素引用和检查点）」存进 wiki，作为该应用的桌面 SOP。下次同类任务先查 SOP，few-shot 喂给模型，步数和 token 大幅下降，弱模型成功率上升。Crewly 已有 wiki 和 memory，零成本接上。

---

## 6. 落地路径

不按功能分期，按**「每一期让一类任务从不可能变成可靠」**排。

| 期 | 目标 | 做什么 | 补的缺口 | 建在什么上 | 量级 |
|---|---|---|---|---|---|
| **1** ✅ **已完成 2026-09-20** | 现有能力变得能交付 | 见 §6.1 | G2 G3 G5 G6 G8 G9 | 共享 `_common/desktop-guards.sh` + `BLOCKED_COMMAND_PATTERNS` | 实际 1 天 |
| **2** | 单应用任务可靠 | Helper v0（Swift，本机）：AX 场景图 + OCR + Set-of-Marks + 按引用动作 + 期望态验证 + wait + 帧差 + 多显示器 | G1 G8 | `rednote-reader` 的 AX 代码、`desktop-app-control` 的 ref 约定 | 2–3 周 |
| **3** | 弱模型能用 | crewly-agent 原生 `computer` 工具（对齐 Anthropic 动作集与缩放坐标，一步一图）+ 10–20 个录制任务的评测集，DeepSeek/Claude/Gemini 各跑基线 | G10 | 今天的 harness、`eval/` 框架 | 1–2 周 |
| **4** | **跨应用复杂任务可靠** | Task Runtime：子目标 / 检查点 / 选路器 / 恢复库 / 预算；不可逆动作异步确认走 Slack | **G11** G3 | work-item + verify-enforcement + approval queue + Slack | 2–3 周 |
| **5** | 用户信任 | 横幅、全局中止热键、用户接管即暂停、审计回放 UI、应用范围策略 | G4 G6 | 浏览器 takeover 横幅的模式、audit log | 1–2 周 |
| **6** | 触达 | Helper 上 relay；Linux Xvfb + AT-SPI；真正的人工接管（noVNC，即 `vnc-browser` 原本想做的事）；SOP 沉淀；Windows 排最后 | G7 | browser-proxy 注册模式、wiki | 2–4 周 |

2+3 是分水岭（像素→元素，且弱模型能用）；4 是真正的难点，也是「无人值守」成立与否的分界。

### 6.1 第 1 期已交付内容（2026-09-20）

护栏抽成 **`config/skills/_common/desktop-guards.sh`**，两个 computer-use 分叉都 `source` 同一份——因为复制进两个文件正是它们当初分叉的原因，而只存在于一个副本里的护栏比没有更糟（它让 skill 看起来是安全的）。

| 交付 | 说明 |
|---|---|
| 权限 preflight | 新动作 `check-permissions` 报告两项 TCC 授权 + **该授给哪个进程**（`ps` 取父进程名）；动作前自动检查，未授权时返回 `permission_required` 和具体设置路径，而不是黑图 |
| 停止开关 | `~/.crewly/desktop.stop` 存在即拒绝一切动作（每次动作前检查，为的是能停下已经在跑的 agent） |
| 桌面互斥锁 | `~/.crewly/desktop.lock` 带持有者与 TTL（默认 120s），他人持锁返回 `desktop_busy`；过期锁自动失效，崩溃的 agent 不会永久占住桌面 |
| 破坏性组合键 | ⌘Q / ⌘W / ⌘⌫ / ⌘⇧⌫ / ⌘⌥⎋ **直接拒绝**（不是审批）。理由：这些几乎从不是自动化真正需要的，而一个能绕开的动作好过一个用户学会盲点的弹窗。owner 可用 `CREWLY_DESKTOP_ALLOW_DESTRUCTIVE=1` 单次放行 |
| 密码框保护 | `type` 前查焦点元素 `AXRole`，是 `AXSecureTextField` 则拒绝。读不到时放行（AX 缺口很常见，一律拒绝会毁掉正常使用） |
| 凭据类应用 | `focus`/`open-url` 到系统设置、钥匙串、1Password/Bitwarden/LastPass/Dashlane 一律拒绝 |
| 审计 | 每个动作在执行**前**追加一行 JSON 到 `~/.crewly/desktop-actions.jsonl`（挂掉的动作也留痕） |
| 护栏防篡改 | `CREWLY_DESKTOP_ALLOW_DESTRUCTIVE` 和 `.crewly/desktop.{stop,lock}` 进 in-process 运行时的 `BLOCKED_COMMAND_PATTERNS`——否则 agent 在同一行命令里自己设个变量就能绕过，护栏等于摆设。owner 仍可在 agent 环境里设，这是预留的出口 |
| dry-run | `CREWLY_DESKTOP_DRY_RUN=1` 跑完全部护栏后报告「会执行」并停止，不碰鼠标。护栏只有连「放行什么」一起测才算测到，而测试套件不该在用户机器上开应用发按键 |
| 选择指引 | 四个 SKILL.md 顶部加同一张表：能用 skill/connector 就别上屏幕 → 网页用 `remote-browser` → Electron 用 `desktop-app-control` → 其余才 `computer-use` |
| 删除 | `vnc-browser`（只有 SKILL.md、没有脚本的空壳，agent 却看得见并会尝试调用） |

**顺带修掉的既有 bug**：`do_key` 用了 `${parts[-1]}`，而 macOS 自带 bash 3.2 **不支持负数下标**——意味着所有带修饰键的组合键（⌘C、⌘V、⌘S…）从来就只会报 `bad array subscript`。这个 bug 在 HEAD 里已存在，与本次改动无关，但它让这个 skill 的实际可用性远低于看起来的样子。

**测试**：`config/skills/_common/desktop-guards.test.sh`，21 项全过，连跑两遍确认零副作用。

**本期明确没做**：审批流（第 4 期随 Task Runtime 做异步 Slack 确认，见 §5.8）；`connector-access` 的角色门没加 `desktop`——那个门只拦 HTTP 路由，而桌面控制目前是 bash skill，加了会是一道后面没有东西的门。

### North star 任务

用一个具体任务验收每一期：

> **把桌面上三个 PDF 合并成一个、按日期改名、传到 Drive 的 `财务/2026`、在 #property-management 发链接。**

它同时用到 GUI（Preview 合并）、连接器（`drive-upload`）、消息（Slack），有一个不可逆点（发消息），有一个典型意外（Preview 的保存对话框）。选路器该只在合并那一步碰 GUI；检查点该抓到「合并后页数不对」；异步确认该在发 Slack 前触发一次。这个任务跑通，架构就是对的。

---

## 7. 明确不做的事

- **不在第 6 期之前动 `desktop/` Tauri app** ——它现在只是启动器，过早绑进去会拖慢桌面 app 自身迭代；Helper v0 先做独立进程，接口定型后再并入。
- **不做录屏回放式的操作学习**（record & replay）——和「agent 自主操作」是两条路，先做后者；5.9 的 SOP 沉淀是轻量替代。
- **不追求游戏/自绘 UI**（无 AX 树）的覆盖，像素路径保留为兜底即可。
- **Windows 排在 Linux 无头之后**——现有用户都在 Mac，无头 Linux 是 steamfun-ops 这类服务器的真实需求。

---

## 8. 风险

**GUI 自动化有天花板。** 即使有 AX 树，长任务成功率也很难到 95%。架构的假设必须是「会失败」，把恢复和升级做得便宜，而不是追求不失败。这正是 Task Runtime 比动作集重要的原因。

**模型能力决定下限。** 引用式操作能让 DeepSeek 用起来，但「读懂陌生对话框该点哪个」仍需要真的理解力。建议 Task Runtime 层用强模型、动作层用便宜模型——Crewly 本来就是多 agent，这正是它擅长的分工。

**Helper 是新的攻击面。** 一个能截屏能合成输入的常驻进程，本身就是高价值目标。它只监听 127.0.0.1、经 relay 时复用现有鉴权、动作全部留痕——但这一点需要在实现时当作一等约束，不能事后补。

---

## 9. 本次未核实的事项（诚实清单）

- `computer-use` 在**本机是否能跑通**：没有实际调用（涉及动我的鼠标键盘）。判断全部来自读脚本。
- `computer-use.test.ts` 的覆盖深度（真动作还是 mock）没看。
- `desktop-app-control` 依赖的 `agent-browser` 本机是否已安装，没查。
- 浏览器线的 takeover 横幅**当前版本**实际表现（记忆里是 ext 0.4.13 已并入），没重新打开扩展验证。
- Anthropic / OpenAI 工具规范引用的是我训练数据里的版本；照抄动作集前以官方文档为准。
- 第 5 节「行业成功率 60–80%」是我训练数据里的印象，不是本次实测或查证的数字。

---

## 附：现有文件索引

| 用途 | 路径 |
|---|---|
| 浏览器 skill | `config/skills/agent/remote-browser/` |
| 浏览器后端路由 | `backend/src/controllers/browser/browser.routes.ts` |
| 扩展输入实现 | `chrome-extension/src/cdp-input.ts` |
| Electron 控制 skill | `config/skills/agent/desktop-app-control/` |
| 原生桌面 skill | `config/skills/agent/computer-use/`（v2.1.0） |
| 分叉，有 AX 读取能力可供第 2 期复用 | `config/skills/agent/marketplace/computer-use/`（v2.0.0，`read-ui`/`get-text`） |
| 共享安全护栏 | `config/skills/_common/desktop-guards.sh`（+ `.test.sh`） |
| AX 树用例参考 | `config/skills/agent/marketplace/rednote-reader/execute.sh` |
| 审批/阻断模式 | `packages/crewly-agent/src/runtime/tool-registry.ts`（`BLOCKED_COMMAND_PATTERNS` / `APPROVAL_REQUIRED_BASH_PATTERNS`） |
| 连接器角色门 | `backend/src/services/connector/connector-access.service.ts` |
| 桌面 app | `desktop/src-tauri/src/lib.rs` |
