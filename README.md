# dsh_mobile_app

一个标准的 DeepSeek Harness（dsh）插件：让安卓手机**扫码二维码**即可安全连接本机
DSH web GUI，自动检测**局域网 / 远程（Tailscale）**，无需改 DSH 任何配置。

它取代了早期的独立 `gateway/server.js` 脚本——现在随 `dsh web` 启动自动运行。

> **从 GitHub 获取**：`git clone https://github.com/Liki-K-Wang/dsh_mobile_app`，
> 然后按下面「安装」/「使用」操作即可（插件源码在 `dsh_mobile_app/`，安卓 App 源码在
> `android/`；最新版 APK 见仓库 Release，无需自己构建）。

---

## 功能亮点

- **扫码配对**：配对页二维码一键扫码，局域网 / Tailscale 自动探测（含自定义隧道 `wanUrls`）。
- **手机端 WebView 适配**：自动注入补丁（`webServer.tapIndex`），解决手机端侧边栏、
  设置弹窗、悬浮球、非安全上下文 `crypto.randomUUID` 缺失等问题（见下文）。
- **设置里「手机配对 · 管理连接」**：在 DSH 设置弹窗内直接查看二维码 / 地址 / 配对码，
  可轮换令牌、撤销连接（桌面与手机端均可用）。
- **App 原生体验**（Android App）：顶栏悬浮侧边栏按钮（可拖动、位置记忆）、调试端口 4747、
  状态栏/导航栏避让。

## 标准插件规格

与 dsh 内置/用户插件同一套加载机制（对照本机已有的 `dsh-desktop-shortcut`）：

- 是一个自包含 npm 包，`main`/`exports` 指向 `lib/index.js`；
- 命名导出 `name` / `apply(ctx, config)`，并保留默认导出兼容；
- 由 loader 按 **file URL** 导入（`file:///.../lib/index.js`），依赖只从插件
  自身 `node_modules` 就近解析（`ws`、`qrcode`），不依赖 profile 的 pnpm 工作区；
- `apply()` 永不抛出：任何失败只记录，绝不影响 dsh 引导；
- `config` 合并到 `DEFAULTS` 上；`ctx.get("webServer")` 读取真实绑定端口，
  `ctx.get("loader")?.await()` 等引导完成后再启动。

## 安装

```bat
install-plugin.cmd     :: 一键：复制到 %USERPROFILE%\.dsh\plugins → npm install →
                       ::      幂等写 profiles\web\cordis.patch.yml → 提示重启
```

重启 `dsh web` 后生效。`cordis.patch.yml` 中新增的行：

```yaml
- insert:
    - id: dsh_mobile_app
      name: 'file:///C:/Users/darkm/.dsh/plugins/dsh_mobile_app/lib/index.js'
      config:
        port: 3081
        host: 0.0.0.0
        openBrowser: true
```

插件代码/配置更新后，**重启 dsh web 即可**（无需重装 APK）；App 原生改动（如侧边栏按钮
拖动）需要安装新版 APK。

## 使用

1. 重启 dsh web → 浏览器自动打开配对页 `http://127.0.0.1:3081/pair`（含二维码）。
2. 手机安装 App（最新版 `dsh-mobile-1.3.7-release.apk` 见仓库 Release，或从 `android\app\build\outputs\apk\release\` 取）：
   - USB 连接并开启调试：`adb install -r dsh-mobile-1.3.7-release.apk`
3. 打开 App → **扫码连接**（或「手动输入」粘贴 `dshm://v1/...` / 原始 JSON）。
4. 局域网：1~2 秒连上；不在同一网络：手机装 Tailscale 登录同一账号即可远程。
5. 顶栏徽标显示连接模式：**局域网** / **远程**；每次 dsh 重启令牌会变化，手机需重新扫码。

主 GUI（127.0.0.1:3080）另挂了一个入口 `http://127.0.0.1:3080/mobile/pair`，
302 到配对页。

## 配置项（DEFAULTS）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设为 false 即插件空转 |
| `port` | `3081` | 手机服务监听端口 |
| `host` | `0.0.0.0` | 监听地址（LAN+Tailscale 可达） |
| `token` | 每次启动随机 256-bit | 固定令牌（一般不需要） |
| `dshUrl` | 自动取 `webServer` 实际 host:port | 上游 DSH web（可覆盖） |
| `wanUrls` | `[]` | 额外远程候选（如 cloudflared https 地址） |
| `sessionTtlHours` | `8` | 会话 Cookie 有效期 |
| `openBrowser` | `true` | 启动后自动打开配对页 |

## 手机端 WebView 适配补丁（自动注入）

插件会在 DSH 前端的 `index.html` 里注入一个轻量补丁（通过 `webServer.tapIndex`
标准扩展点，`lib/mobile-patch.js` + `lib/settings-pairing.js`），解决手机端常见问题：

1. **`crypto.randomUUID is not a function` / 无法打开文件夹 / 无法加载工作区**
   ——手机通过 `http://<LAN-IP>:3081` 访问属于非安全上下文，浏览器不提供
   `crypto.randomUUID`（DSH 前端发命令/开文件夹/加载工作区都会用到）。
   补丁用 `crypto.getRandomValues` 补齐（对任何非安全上下文生效，桌面局域网
   直连也一样）。
2. **左侧侧边栏**：窄屏收成 56px 图标栏；点开关时用**覆盖式抽屉**——侧边栏
   `position:fixed` 从左侧滑出覆盖在对话之上（像翻书，不挤压对话、不重排），
   全程不改 grid（v0.3.0）。原生安卓 App 用顶栏按钮
   （`window.__dshMobileToggleSidebar`），纯浏览器用右下角**可拖动悬浮球**作为后备
   （原生容器内不装悬浮球，UA 带 `DSHNative` 标记；v0.3.3 起拖动更稳：move/up 挂
   window，弹层打开时自动隐藏）。
3. **设置弹窗**：窄屏下左侧导航收成顶部一条图标条（“只留 logo”），内容区占满宽度；
   一级菜单与「手机配对」面板头部按状态栏高度避让（`--dsh-statusbar-top`，v0.3.3）。
4. **进「详情页」卡死、无法关闭** ——平板/折叠屏/大屏手机（视口 ≥996px）下
   DSH 会自动打开右侧详情面板且难以关闭。补丁把详情轨道压成 0、隐藏整列
   （含拖拽把手），杜绝接管。工具行内容仍可在消息流里内联查看。
5. **移动端体验细节**（v0.3.1+）：统计栏点击展开 1 秒自动关闭；会话/搜索结果行点击
   自动收回抽屉、项目行点击只展开/收起分组；收回动画只播一次；触屏设备强制可见
   hover 反馈；模型按钮恢复 D 圆形徽标；模型菜单居中弹出；顶栏只留图标。

补丁自带移动端判定（**v0.3.3 起要求命中移动端 UA**，桌面触屏/窄窗口不再误判），
桌面端加载到也只是立即返回，互不影响。

## 设置里的「手机配对 · 管理连接」（v0.2.0）

在 DSH Web GUI 的**设置**弹窗左侧导航里新增一项**「手机配对」**（桌面端与手机端
都出现，`lib/settings-pairing.js` 注入 + `webServer.tapIndex`）。点击后弹出面板：

- **配对二维码**：当前配对码对应的二维码，扫码即可让新手机连接；
- **局域网 / 远程地址**：LAN 与 Tailscale/隧道候选地址，每条可一键复制；
- **配对码**：默认打码，可「显示」后查看并复制；
- **重新生成配对码**：`POST /api/dsh-mobile/pair/regenerate`，轮换为新的随机
  令牌（旧二维码立即失效；`config.token` 只是启动初值）；
- **撤销所有连接**：`POST /api/dsh-mobile/pair/revoke`，清空所有已配对的手机
  会话，手机需重新扫码。

面板视觉与 DSH 设置弹窗对齐（主题令牌、按钮 hover、头部排版，v0.3.3）。
数据来自插件注册在 DSH web server 上的同源 REST 路由
（`GET/POST /api/dsh-mobile/pair*`，`lib/index.js` 的 `registerPairingRoutes`）。
桌面端（localhost:3080 回环）直接访问；手机端经 3081 网关会话鉴权后反代访问，
不会向局域网直出。

## 调试端口（4747，仅回环）

App 内置极简 HTTP 控制服务，**只监听 `127.0.0.1:4747`**（不暴露到局域网；
v1.3.3 起显式绑定 IPv4 `127.0.0.1`，规避 `getLoopbackAddress()` 偶发返回 `::1`
导致 `adb forward` 连不上的问题）。用 USB / 无线调试连接后：

```powershell
adb forward tcp:4747 tcp:4747
curl http://127.0.0.1:4747/status
```

| 端点 | 作用 |
|---|---|
| `GET /` | 服务信息与端点列表 |
| `GET /status` | 连接状态、App 版本、前台 Activity、当前配对配置（打码令牌） |
| `GET /profile` | 完整配对配置 |
| `POST /profile` | 写入配对配置（原始 JSON） |
| `POST /connect` | 用已存配置触发连接 |
| `POST /clear` | 清空已存配置 |

> **App 版本备注**：v1.3.3 修复调试端口 IPv6 `::1` 绑定；v1.3.4 加入顶栏悬浮按钮**可拖动**
> （位置记忆）+ `DSHBridge.onModalChanged` **弹层自动隐藏按钮** + 状态栏高度注入
> `--dsh-statusbar-top`；v1.3.5 加入**悬浮按钮磁吸边框**（拖动松手吸到最近左/右边框，180ms
> 动画，点按不误触发，吸附位置记忆）；v1.3.6 **WebView 整体下垫状态栏高度**（主界面与
> 设置弹窗都不再与状态栏重叠，移除 `--dsh-statusbar-top` 变量与设置/配对面板的状态栏内边距，
> 消除图标上方多余空余）。App 侧改动均需重装对应 APK 生效（`adb install -r` 保留数据）。

无线调试：手机开启「无线调试 → 使用配对码配对设备」，电脑 `adb pair <IP:端口> <配对码>`，
再 `adb connect <IP:连接端口>`（TLS 无线 adb）。

## 安全设计

- DSH web 仍只监听回环；插件在 `0.0.0.0:<port>` 提供手机面，令牌认证后才转发
  （改写 Host/Origin 使 DSH 信任栅栏视为回环客户端，**DSH 配置零改动**）。
- 令牌 256-bit 每次启动随机；会话 Cookie `HttpOnly; SameSite=Lax; Path=/; Max-Age=8h`。
- 配对页 `/pair` 仅回环可访问；无令牌/无 Cookie 一律 401/403。
- 设置里的配对信息路由 `/api/dsh-mobile/pair*` 同样只挂在 3080 回环上，信任等级
  与 `/pair` 一致（本机可读；手机端只能经网关会话鉴权后反代访问）。
- WS 升级仅放行 `/api/events.mux|host` 且必须带会话 Cookie。
- 持有令牌的手机即拥有 DSH 全部能力（可执行命令/读写文件）：**不要把二维码发给他人**。
- 明文 HTTP 仅限局域网信任模型；Tailscale 线路本身由 WireGuard 加密。

## 测试

```bash
npm test                          # 启动测试端口并跑完整 E2E（33 项）
node test/test-plugin.mjs 3181 http://127.0.0.1:3080
```

覆盖：模块 file:// 导入、移动端补丁注入（幂等+语法）、令牌认证、302+HttpOnly
Cookie、401/403、反向代理到达 DSH 业务层、静态资源 immutable、WS 转发收帧、
配对页二维码、配对信息路由。

## 目录结构

```
dsh_mobile_app/
├─ lib/
│  ├─ index.js            # 插件入口：挂 tapIndex + REST 路由 + 启动手机网关
│  ├─ server.js           # 手机配对网关（令牌认证 / 反向代理 / WS 转发）
│  ├─ mobile-patch.js     # 手机端 WebView 适配补丁（注入 index.html）
│  └─ settings-pairing.js # 设置「手机配对」面板 + 导航项注入
├─ assets/pair.html       # 配对页（跟随系统明暗主题）
├─ test/test-plugin.mjs   # E2E 测试
├─ android/               # Android App 工程（见下方产物）
│  └─ app/build/outputs/apk/{debug,release}/…
├─ dsh-mobile-1.3.7-release.apk / dsh-mobile-1.3.7-debug.apk（仓库 Release 提供最新版）
└─ README.md
```

Android App 关键点：`ConnectActivity` 全屏 WebView + 左上角可拖动悬浮侧边栏按钮
（位置记忆；设置等全屏弹层打开时经 `DSHBridge.onModalChanged` 自动隐藏）；
`DebugServer` 提供 4747 调试端口；状态栏高度注入 WebView 为 `--dsh-statusbar-top`。

## 常见问题（FAQ）

| 现象 | 处理 |
|---|---|
| 配对正确但手机提示「无法连接到电脑」 | v1.3.2 起恢复 `usesCleartextTraffic=true`（`<domain>` 不匹配 IP 网段的坑）；确保 App 是最新版 |
| 调试端口 `adb forward` 后 curl 超时/拒绝 | v1.3.3 修复 IPv6 `::1` 绑定问题；仍超时可先 `adb shell` 直接 `nc 127.0.0.1 4747` 排查 |
| 内容与顶部状态栏重叠 | 旧 APK 未含状态栏修复：重装最新 `dsh-mobile-1.3.7-release.apk`（v1.3.6 起 WebView 整体下垫状态栏高度，主界面与设置弹窗均不再重叠） |
| 手机 WebView 里按钮无反馈 | 触屏设备没有 hover：补丁已强制可见 hover 反馈（v0.3.1+） |
| 每次重启 dsh 手机都要重新扫码 | 正常：令牌每次启动随机；重启后打开配对页扫新码即可 |

## 更新历史

> ⑬ **v0.3.1 手机端体验修复（10 项）**：统计栏点击展开 1 秒后自动关闭；抽屉收回动画只播一次（收回期冻结交互 + 断开观察器防循环触发）；已选中的会话/项目行点击也能收回抽屉（改用 parentElement 遍历，绕开选中行 `_selected` 类名后缀）；顶栏按钮只留图标隐藏文字；模型按钮恢复为 D 圆形徽标（点击仍开菜单）；模型菜单居中弹出；设置弹窗全屏；触屏设备强制可见 hover 反馈（图标按钮/会话行/区块操作按钮）；设置导航「手机配对」入口与原生导航项样式逐属性统一；安卓悬浮侧边栏按钮图标缩小 30%（v1.3.1 APK）。
> ⑭ **v0.3.2 侧边栏点击行为修正**：① **点击项目行只展开/收起项目分组，不再收回抽屉**（此前对项目行也触发收回，导致想展开项目时抽屉直接关上）；会话行/搜索结果行点击仍自动收回。② **收回动画只播放一次**：收回开始时立即隐藏 DSH 原生 backdrop 并临时禁用原生 grid/侧栏过渡（此前原生遮罩会在我们遮罩淡出后残留并以慢速过渡再淡一次，看起来「关了两次」），待折叠渲染落定后再恢复。
> ⑮ **v0.3.3 界面一致性修复（配合 App v1.3.4）**：① 原生 App 顶栏悬浮按钮**可拖动**（任意位置、位置记忆，点按仍开关抽屉）。② 打开设置/手机配对面板时**隐藏顶栏悬浮按钮**：新增 `DSHBridge.onModalChanged` 原生桥，网页补丁监测全屏弹层开关并通知 App；浏览器里的网页悬浮球同样在弹层时隐藏。③ 设置一级菜单图标**不再压手机状态栏**：App 把状态栏高度注入为 `--dsh-statusbar-top`，补丁给设置导航行/配对面板头部加该顶部内边距（浏览器走 `env(safe-area-inset-top)` 回退）。④ **「手机配对」管理面板视觉对齐 DSH 设置弹窗**；**配对页 /pair 跟随系统明暗主题**。⑤ **IS_MOBILE 收紧为移动 UA 判定**：桌面触屏/窄窗口不再误判为移动端。⑥ 配对面板 / 设置导航的观察器回调 rAF 合并降耗。
> 桌面端不受影响（补丁只在移动端生效）。App 侧：v1.3.3 修复调试端口 IPv6 绑定；v1.3.4 加入按钮拖动 / 弹层隐藏 / 状态栏变量（见上文）。
> ⑯ **v0.3.4 界面统一 + 内容密排 + 悬浮球磁吸（配合 App v1.3.5）**：① **配对界面统一为 DSH 设置页风格**——设置里「手机配对」面板与浏览器 `/pair` 页都改成「通用设置/模型/Agent 预设」同款 section 布局（720px 居中容器、标题/说明、border-bottom 行、DSH 主/次/危险按钮）。② **手机端内容区密排**——聊天列左右边距由 32px 收窄到 10px（内容变大）；markdown 表格更密集（`td/th` 内边距 10×16→6×10、`min-width` 100→72px）；markdown 标题/代码块/引用间距整体收紧（`h1-h3` 32px→20px 顶部、`pre/blockquote` 16px→10px）。③ **悬浮球磁吸边框**——原生 App 顶栏按钮与网页悬浮球拖动后松手自动吸到最近的左/右边框（180ms 动画、位置记忆、点按不误触发）。④ 全部仅移动端（IS_MOBILE UA 判定）生效，桌面零影响。
> ⑰ **v0.3.5 顶部状态栏统一处理（配合 App v1.3.6）**：① 原生 App **WebView 整体下垫状态栏高度**（`setPadding(0, bars.top, 0, bars.bottom)`）——主界面聊天头部不再与状态栏重叠，恢复「内容始终在状态栏下方」的原始设计。② 设置弹窗与「手机配对」面板**移除** `--dsh-statusbar-top` 状态栏内边距（改为普通 `10px`/`18px`）——消除设置导航图标上方的多余空余；同时原生移除 `--dsh-statusbar-top` 注入逻辑（该变量已无消费者）。③ 顶栏悬浮按钮基线改为 `8dp`（根布局内边距已含状态栏），按钮坐标键改为 `sidebar_btn_x2/y2`（旧坐标系失效，强制回默认位置）。④ 顶部状态栏为固定深色条（#0F1115 + 白色图标，与 App 设计一致）；浏览器端不受影响（`env()` 本就为 0）。
> ⑱ **v0.3.6 移动端设置一致性**：① 手机端**完全隐藏**会话头部的「Session log」下载按钮（此前只收成图标）。② 设置弹窗顶部**单行化**——关闭按钮与 `settings.action` 功能按钮脱离文档流、绝对定位浮到导航图标行右侧，与导航图标合并为一行（此前「导航行 + header 行」两行叠着占空间）。③ **配对改为设置弹窗内的一个分节**——点「手机配对」不再弹全屏浮层，而是在设置内容区（`.options`）内渲染与通用设置/模型/Agent 预设一致的 section（18px/600 标题 + 13px 说明 + 二维码卡片 + border-bottom 行 + DSH 按钮）；实现为 `.options` 上的绝对定位覆盖层（底层 React 分节不动，切其他导航项天然还原），React 重绘擦掉时观察器用缓存数据补回，导航项选中态用 `:has()` 压制原生高亮（不触碰 React active 类）。④ 桌面端同样受益（配对不再全屏覆盖，而是渲染在 800px 设置窗口内容区）。
> ⑲ **v0.3.7 配对分节背景修复**：配对分节的 `.options` 覆盖层补上与设置弹窗面板一致的**不透明背景**（`var(--dsw-alias-bg-layer-2)`）——此前覆盖层透明，底层 React 分节（通用设置等）透出来导致「配对页面和别的页面重合」。明暗主题自动跟随。
> ⑳ **v0.3.8 修复设置内容无法滚动 + 抽屉空白边**：① **设置内容滚动修复（手机端滑动失效）**——设置弹窗移动端 `.content` 规则的选择器 `[role=dialog][aria-modal=true][class$=_content]` **缺一个空格**（应为后代选择器）。无空格时该选择器要求元素同时带 `role`+`aria-modal`+`class` 结尾，只有 panel（`.class=_panel`）命中，`.content` 根本不命中 → `min-height:0;overflow:visible` 从未生效 → `.content` 高度随内容撑开、`.options`（`overflow-y:auto`）没有受限高度 → 设置内容被 panel 裁剪、无法滚动。补空格后 `.content` 受限、`.options` 正常滚动。settings-pairing 里配对选中态 `:has()` 压制规则（`[class$=_navList]`）同款缺空格，一并修复（配对选中时正确压制其他导航项高亮）。② **抽屉空白边**——抽屉打开把 sidebarCol 设为 `width:100vw`，但 DSH 侧栏 root（`.hHd-Xa_root`）有 React 内联 `width:280px` → 内容只占左侧 280px，右侧大片空白；新增 `[data-dsh-overlay] [class$=_sidebarCol] [class$=_root]{width:100%!important}` 让内容铺满（`!important` 压过内联，React 重绘后仍生效）。③ 新增回归测试：断言 `.content`/`:has()` 选择器必须带空格。
> ㉑ **v0.3.9 / App v1.3.7 侧边栏入口收拢到标题行**：① **彻底删除悬浮球**——网页端删 `installBall`/`makeDraggable`/磁吸/弹层隐藏（`dsh-mobile-ball`）与 `DSHBridge.onModalChanged` 原生桥；原生 App 删浮动可拖动按钮（`setupFloatingSidebarButton`）及拖动/位置记忆/可见性逻辑，重打包为 v1.3.7。② **对话标题行最左侧新增固定侧边栏图标** `#dsh-sidebar-toggle`——定位会话头部 `[class$=_titleRow]`，把 32×32 图标按钮插到标题簇之前（最左侧），点击调 `toggleSidebar()` 开/关覆盖式抽屉；React 重建标题行时由 `armHeaderToggle` 的观察器 + `enforceMobileLayout` 帧变更兜底补回。③ **隐藏 DSH 自带侧栏开关防双入口**——`body:has([class$=_titleRow]) [class$=_sidebarCol] [class$=_toggle]{display:none!important}`：有标题行时 DSH 侧栏列内的自带「打开侧边栏」开关隐藏，标题行图标成为唯一入口；收窄到侧栏列内避免误伤轨迹面板等其它 `*_toggle` 元素；非会话页（无标题行）DSH 开关保留作后备。④ 桌面端零影响（全部改动仅在移动端 UA 下生效）。
> ㉒ **v0.3.10 抽屉打开后稳定满宽（修复“只正确显示一下后塌回 280px + 右侧空白”）**：根因是抽屉布局由 `applyOverlayLayout()` 用**内联样式**设在侧栏列上（`width:100vw;position:fixed;…`），而打开抽屉时会 `click` DSH 自带 `_toggle` 让侧栏展开，DSH React 随后重绘侧栏列时把这些内联样式覆盖回展开态（`width:280px;position:absolute`）；`layoutObserver`/`collapseObserver` 只盯 frame 的 `style`/`data-sidebar-collapsed`，该次重绘不触发 → 不再回灌 → 侧栏塌回 280px、右侧露白。修复：① 抽屉布局改为 **CSS `!important` 强制**——新增 `body[data-dsh-overlay] [class$=_sidebarCol]{position:fixed!important;top:0!important;bottom:0!important;left:0!important;width:100vw!important;z-index:60!important;overflow:visible!important}`（样式表 `!important` 压过 React 内联写入，重绘后依然生效）+ 保留 root 铺满规则；② **覆盖态标记移到 `document.body`**（`openOverlay`/`closeOverlay` 改设/移除，`enforceMobileLayout` 覆盖态分支防御性重挂）——body 非 React 管理，重绘/换节点都不丢；③ 纯 Web 补丁，无需重打包 APK（App 仍 v1.3.7）。headless 探针验证：模拟 React 后重绘后旧版 `sbWidth:280px/sbFull:false`（复现），新版 `sbWidth:100vw/sbPos:fixed/sbFull:true`（保持满宽），关闭后标记移除、样式复位。桌面端零影响。
> ㉓ **v0.3.11 会话标题行图标持续存在（修复“对话界面没有侧边栏图标”）**：根因是 React 会**原地重绘**标题行（reconcile children 把注入的 `#dsh-sidebar-toggle` 删掉）——`armHeaderToggle` 只监听「新增的 titleRow 节点」，抓不到原地重绘；真实会话头重绘很频繁，图标刚注入就被删。修复：给已注入的标题行挂 **per-titleRow childList 守护**（`armTitleRowGuard`）：每次标题行 childList 变化都确认图标在，被删就用 `ensureHeaderToggle(tr)` 对同一行重插（`tr.__dshGuard` 防重复挂载；insertBefore 触发自身回调时图标已存在 → 无循环）。`ensureHeaderToggle` 增加可选 `trArg` 参数，守护指向同一标题行避免误插其它行。headless 探针验证：模拟 React 原地重绘删图标后，旧版 `GONE`（复现），新版 `re-inserted`（图标仍在）。纯 Web 补丁，无需重打包 APK。
> ㉔ **v0.3.12 新对话页可打开侧边栏（修复“新对话页无法打开侧边栏”）**：根因是 DSH 对话在 **`data-phase="hero"`（新对话/空会话）阶段不渲染会话标题行**（`conversation.session.header` 槽为空，无 `wSkVaW_titleRow` 元素）——标题行图标无法注入；同时侧栏被完全收起（0 宽 + overflow hidden）→ 新对话页**没有任何侧边栏入口**。真实页面 CDP 验证：hero 阶段 `titleRow:false/sidebarToggle:false`（复现），发送消息转 active 后 `titleRow:true/sidebarToggle:true`（标题行图标正常，v0.3.11 守护有效）→ 问题只在 hero 空状态。修复：新增左上角固定兜底按钮 **`#dsh-mobile-hero-toggle`**（z-index 45，低于抽屉遮罩 z-50；复用标题行图标同款 SVG/配色+微底色），仅当 `[class$=_root][data-phase=hero]` 存在且无 `[class$=_titleRow]`、无 `[role=dialog][aria-modal=true]` 弹窗、抽屉未开（body 无 `data-dsh-overlay`）时显示，点击调 `toggleSidebar()`；`armHeaderToggle` 的观察器扩展为同时检查 **added/removed** 里的 titleRow/root/弹窗节点 + **`data-phase` 属性变化**（hero→active 是原地属性变化，childList 观察不到）→ 刷新两个入口；`arm()`/`openOverlay`/`closeOverlay` 各自刷新。纯 Web 补丁，无需重打包 APK（App 仍 v1.3.7）。


更早：v0.2.0 加入设置「手机配对」面板；v0.3.0 引入覆盖式抽屉侧边栏、悬浮球、设置弹窗
全屏导航、详情面板禁用、composer/触屏修复。桌面端不受影响（补丁只在移动端生效）。

## 卸载

1. 从 `profiles\web\cordis.patch.yml` 删除 `dsh_mobile_app` 行；
2. 删除 `%USERPROFILE%\.dsh\plugins\dsh_mobile_app`；
3. 重启 dsh web。

## 说明

- 每次 dsh 重启令牌会变化，手机需重新扫码（重启后自动弹出的配对页是新的）。
- 首次需在 Windows 防火墙放行 3081（专用网络）。
- 依赖（ws、qrcode）已装进插件自身 `node_modules`，无需全局安装。
- 电脑 IP 常为 DHCP 动态分配：建议在路由器给电脑做静态绑定，避免换 IP 后重新配对。
