# dsh_mobile_app

一个标准的 DeepSeek Harness（dsh）插件：让安卓手机**扫码二维码**即可安全连接本机
DSH web GUI，自动检测**局域网 / 远程（Tailscale）**，无需改 DSH 任何配置。

它取代了早期的独立 `gateway/server.js` 脚本——现在随 `dsh web` 启动自动运行。

---

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

## 使用

1. 重启 dsh web → 浏览器自动打开配对页 `http://127.0.0.1:3081/pair`（含二维码）。
2. 手机安装 `dsh-mobile-1.0.0-release.apk`，打开 App → **扫码连接**。
3. 局域网：1~2 秒连上；不在同一网络：手机装 Tailscale 登录同一账号即可远程。
4. 顶栏徽标显示连接模式：**局域网** / **远程**。

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
标准扩展点，`lib/mobile-patch.js`），解决手机端几个常见问题：

1. **`crypto.randomUUID is not a function` / 无法打开文件夹 / 无法加载工作区**
   ——手机通过 `http://<LAN-IP>:3081` 访问属于非安全上下文，浏览器不提供
   `crypto.randomUUID`（DSH 前端发命令/开文件夹/加载工作区都会用到）。
   补丁用 `crypto.getRandomValues` 补齐（对任何非安全上下文生效，桌面局域网
   直连也一样）。
2. **左侧侧边栏无法完全折叠 / 折叠后开关挤压对话** ——窄屏只能收成 56px 图标栏。
   补丁把侧边栏轨道压成 0；点开关时用**覆盖式抽屉**：侧边栏 `position:fixed` 从左侧
   滑出覆盖在对话之上（像翻书，不挤压对话、不重排），用占位元素把主列稳在满宽轨道，
   全程不改 grid（v0.3.0）。原生安卓 App 用顶栏按钮（`window.__dshMobileToggleSidebar`），
   纯浏览器用右下角**可拖动悬浮球**作为后备（原生容器内不装悬浮球，UA 带 `DSHNative` 标记）。
3. **设置弹窗左侧 188px 导航挤占内容** ——窄屏下把左侧导航收成顶部一条
   图标条（“只留 logo”），内容区占满宽度。
4. **进「详情页」卡死、无法关闭** ——平板/折叠屏/大屏手机（视口 ≥996px）下
   DSH 会自动打开右侧详情面板且难以关闭。补丁把详情轨道压成 0、隐藏整列
   （含拖拽把手），杜绝接管。工具行内容仍可在消息流里内联查看。

补丁自带移动端/窄屏判定，桌面端加载到也只是立即返回，互不影响。

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

数据来自插件注册在 DSH web server 上的同源 REST 路由
（`GET/POST /api/dsh-mobile/pair*`，`lib/index.js` 的 `registerPairingRoutes`）。
桌面端（localhost:3080 回环）直接访问；手机端经 3081 网关会话鉴权后反代访问，
不会向局域网直出。

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
npm test                          # 启动测试端口并跑完整 E2E（19 项）
node test/test-plugin.mjs 3181 http://127.0.0.1:3080
```

覆盖：模块 file:// 导入、移动端补丁注入（幂等+语法）、令牌认证、302+HttpOnly
Cookie、401/403、反向代理到达 DSH 业务层、静态资源 immutable、WS 转发收帧、
配对页二维码。

## 卸载

1. 从 `profiles\web\cordis.patch.yml` 删除 `dsh_mobile_app` 行；
2. 删除 `%USERPROFILE%\.dsh\plugins\dsh_mobile_app`；
3. 重启 dsh web。

## 说明

- 每次 dsh 重启令牌会变化，手机需重新扫码（重启后自动弹出的配对页是新的）。
- 首次需在 Windows 防火墙放行 3081（专用网络）。
- 依赖（ws、qrcode）已装进插件自身 `node_modules`，无需全局安装。

## 更新记录

- **㉖ v0.3.14**：修复抽屉打开后 1-3s「对话区宽度收缩、右侧空白」。根因：DSH 用 frame
  上的 **`data-details-collapsed` 数据属性**驱动「详情面板」（详情列 = grid 轨道3），
  原 `layoutObserver` 只观察 `attributeFilter:["style"]`，抓不到该属性变化；真机抽屉
  展开后 DSH 异步渲染把详情轨道撑开（对话区被挤窄、右侧空白）且无人纠正（headless
  不触发 DSH 的详情自动展开，故难复现）。修复：① `layoutObserver` 扩展观察
  `class` / `data-details-collapsed`（DSH 撑开详情时立即纠正）；② 新增 400ms 布防守卫
  `armLayoutWatchdog` 轮询兜底——覆盖态恒保持 `0px minmax(0px,1fr) 0px` + 侧栏 fixed
  满宽 + 三列固定，非覆盖态恒归零轨道 1/3 → 对话区恒满宽；`document.hidden` 时跳过省电。
- **㉕ v0.3.13**：修复抽屉「打开后先显示正确、随即收缩/关闭」。根因（真实页面 CDP 逐帧证实）：
  `openOverlay` 后约 3–270ms 内 `closeOverlay` 被误触发——真机 Android WebView 的
  tap 会把点击重定向到抽屉打开瞬间出现在手指下方的全屏遮罩（`#dsh-drawer-mask`），
  遮罩 `click→closeOverlay` 移除了 `body[data-dsh-overlay]` 标记（v0.3.10 的 CSS
  `!important` 只在该标记存在期间强制满宽，标记一移除即失效）→ 侧栏塌回 0px。
  修复：`closeOverlay` 加 **400ms 防误关守卫**（记录 `state.lastOpenAt`，打开后
  400ms 内忽略一切关闭调用），覆盖遮罩重定向 / 多余二次 toggle / 会话行 300ms
  误触发等全部误关路径；400ms 后所有关闭路径恢复正常。
- **㉔ v0.3.12**：新对话（hero 空状态）无标题行图标 → 左上角固定兜底按钮
  `#dsh-mobile-hero-toggle`；观察器扩展（removedNodes + `data-phase` 属性）。
- **㉓ v0.3.11**：标题行图标防 React 原地重绘丢失（per-titleRow childList 守护）。
