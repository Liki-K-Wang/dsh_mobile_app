/**
 * dsh_mobile_app — lib/mobile-patch.js
 *
 * 手机端 WebView 适配补丁（注入到 DSH 前端 index.html）。
 *
 * 解决的问题：
 *  1) crypto.randomUUID is not a function
 *     手机通过 http://<LAN-IP>:3081 访问时属于「非安全上下文」，浏览器不提供
 *     crypto.randomUUID（DSH 前端在发送命令/打开文件夹/加载工作区时都会调用），
 *     导致“无法打开文件夹 / 无法加载工作区”。这里用 getRandomValues 补齐。
 *  2) 左侧侧边栏折叠 + 覆盖式抽屉
 *     DSH 窄屏只能收成 56px 图标栏（仍是格子轨道）。本补丁把侧边栏轨道压成 0；
 *     开关侧边栏时用「覆盖式抽屉」：侧栏 position:fixed 从左侧滑出覆盖在对话之上
 *     （像翻书，不挤压对话、不重排），用占位元素把主列稳在满宽轨道，全程不改 grid。
 *     原生安卓 App 用顶栏按钮（window.__dshMobileToggleSidebar），纯浏览器用悬浮球。
 *     注意：折叠必须只通过把 grid 轨道置 0 实现，绝不能给列设 display:none ——
 *     display:none 会把列移出 grid 流，导致主对话列（centerCol）被自动排进
 *     第 1 个 0px 轨道，整个对话区变成黑屏（已在手机视口实测确认）。
 *  3) 设置面板左侧 188px 导航挤占内容
 *     窄屏下把左侧导航收成顶部一条图标条（只留图标 = “logo”），内容区占满宽度。
 *  4) 进入「详情页」卡死、无法关闭
 *     宽视口（>=996px，平板/折叠屏/大屏手机）下 DSH 会自动打开右侧详情面板且
 *     难以关闭。这里把详情轨道压成 0（同样不设 display:none），隐藏拖拽把手，
 *     彻底杜绝接管。
 *
 * 注入脚本自带移动端/窄屏判定，桌面端加载到也只会立刻 return，互不影响。
 */
const PATCH_MARKER = "data-dsh-mobile-patch";

const PATCH_SCRIPT = `<script ${PATCH_MARKER}="1">
(function(){
  // v0.3.15：抽屉打开后「对话区收缩」最终兜底——新增纯 CSS 规则
  // body[data-dsh-overlay] [class$=_frame]{grid-template-columns:0px minmax(0px,1fr) 0px!important}
  // 用 !important 瞬间强制 frame grid（对话列恒满宽），不再依赖 JS 看门狗；
  // arm() 每步独立 try/catch，保证看门狗/观察器必然挂载；看门狗覆盖态重挂 body 标记。
  // v0.3.14：抽屉打开后 1-3s「对话区宽度收缩、右侧空白」修复——DSH 用 frame 上的
  // data-details-collapsed 数据属性驱动「详情面板」（详情列 = grid 轨道3）。原 layoutObserver
  // 只盯 frame.style，抓不到 data-details-collapsed 变化；真机抽屉展开后 DSH 异步渲染把详情
  // 轨道撑开（对话区被挤窄、右侧空白），无人纠正。修复：observer 扩展监听 class /
  // data-details-collapsed + 新增 400ms 布防守卫 armLayoutWatchdog 轮询兜底（覆盖态恒
  // 保持 0px 1fr 0px + 侧栏 fixed 满宽 + 列固定，非覆盖态恒归零轨道1/3 → 对话区满宽）。
  // v0.3.13：抽屉「打开后先正确后收缩」修复——closeOverlay 加 400ms 防误关守卫
  //（真机 WebView tap 把点击重定向到刚出现的遮罩 → 误关；见第 3 节 state.lastOpenAt）。
  // v0.3.12：新对话（hero 空状态）无标题行图标 → 左上角固定兜底按钮 #dsh-mobile-hero-toggle；
  // v0.3.11：标题行图标防 React 原地重绘丢失（per-titleRow childList 守护）；
  //（reconcile children）把注入的 #dsh-sidebar-toggle 删掉；armHeaderToggle 只监听
  // 新增的 titleRow 节点，抓不到原地重绘。给已注入的标题行挂 childList 守护
  //（armTitleRowGuard）：图标被移除就重插，真实会话头频繁重绘下图标持续存在。
  // v0.3.10：抽屉「只正确显示一下后塌回 280px + 右侧空白」修复——抽屉布局从
  // 「内联样式 + 观察器回灌」改为 CSS !important 强制 + 标记移到 document.body。
  // 根因：打开抽屉时 openOverlay 会 click DSH 自带 _toggle 让侧栏展开，DSH React
  // 随后再重绘侧栏列，把 applyOverlayLayout 设的内联样式（width:100vw;position:fixed…）
  // 覆盖回 DSH 展开态（width:280px;position:absolute…）；layoutObserver/collapseObserver
  // 只盯 frame 的 style / data-sidebar-collapsed，那次重绘不触发它们 → 不再回灌 →
  // 侧栏塌回 280px、右侧露白。修复：body[data-dsh-overlay] 规则用 !important 压过
  // React 内联写入（stylesheet !important > inline），标记放 body 扛过重绘/换节点。
  // v0.3.9：侧边栏入口收拢——删除网页悬浮球（installBall/makeDraggable/磁吸/弹层隐藏），
  // 改为「会话标题行最左侧」固定图标 #dsh-sidebar-toggle（点击开覆盖式抽屉）；
  // 有标题行时隐藏 DSH 自带侧栏开关（body:has(...) 防双入口）；原生 App v1.3.7 同步删浮动按钮。
  // v0.3.8：设置弹窗 .content 的移动端选择器补空格（后代选择器）——此前
  // [role=dialog][aria-modal=true][class$=_content] 无空格，要求元素同时带 role+aria，
  // 只有 panel 命中，.content 不命中 → min-height:0/overflow:visible 从未生效 →
  // 设置内容区无法滚动（手机端滑动失效）；settings-pairing 的 :has() 压制规则同款修复。
  // 抽屉打开时侧栏内容铺满 100vw（消除右侧空白边）。
  // v0.3.7：配对分节覆盖层补不透明背景（settings-pairing）；
  // v0.3.6：隐藏 Session log 按钮 / 设置弹窗顶栏单行化 / 配对改为设置弹窗内分节；
  // v0.3.5：设置弹窗/配对面板不再加状态栏内边距（原生 v1.3.6 起 WebView 整体下垫
  // 状态栏高度，浏览器 env() 本就为 0）——消除设置导航图标上方的多余空余；
  // v0.3.4：内容区密排（聊天列边距 32px→10px、表格更密、markdown 更紧凑）；
  // 悬浮球磁吸边框（配合 App 1.3.5）；配对界面统一为设置页风格（settings-pairing）。
  try { window.__dshMobilePatchVersion = "0.3.17"; } catch (e) {}
  // v0.3.17：性能修复——enforceMobileChatLayout 的全树 TreeWalker + 逐节点
  // getComputedStyle（强制样式计算）此前挂在 layoutObserver/collapseObserver 的
  // 每次回调上；聊天根节点找不到时（hero 页等）每次 DOM 变更都全树扫描，DSH 频繁
  // 改 frame 属性 → 真机可感知卡顿。修复：连续 3 次找不到后负缓存挂起（force=true
  // 时重置，phase 切换/页面结构变化时触发），并把扫描从 observer 高频回调移到
  // 400ms 看门狗慢路径 + arm 一次性执行。另删除 drawerWidth 死抽象（恒返回 100vw）。
  // 1) crypto.randomUUID 补齐：任何非安全上下文（http://LAN-IP / Tailscale）都缺失，
  //    桌面用局域网 IP 访问也一样会触发；安全上下文下已存在则 no-op。
  try {
    if (window.crypto && crypto.getRandomValues && typeof crypto.randomUUID !== "function") {
      crypto.randomUUID = function () {
        var b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = "";
        for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
        return h.slice(0,8) + "-" + h.slice(8,12) + "-" + h.slice(12,16) + "-" + h.slice(16,20) + "-" + h.slice(20);
      };
    }
  } catch (e) {}

  // 以下 UI 适配仅针对移动端。
  // v0.3.3：收紧为「必须命中移动端 UA」——桌面触屏/窄窗口不再误判为移动端
  // （否则桌面端可能被折叠侧边栏/套用移动布局）。手机浏览器与原生 WebView 都命中。
  var IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (!IS_MOBILE) return;

  // 2) 设置弹窗：全屏、顶部对齐、纵向布局（导航横排在上 + 内容区占满）
  try {
    var st = document.createElement("style");
    st.textContent = [
      "@media (max-width: 1023px){",
      "  [role=dialog][aria-modal=true][class$=_panel]{align-self:flex-start;flex-direction:column;width:100vw;max-width:100vw;height:100vh;max-height:100vh;min-height:100vh;border-radius:0}",
      "  [role=dialog][aria-modal=true] [class$=_nav]{flex:none;flex-direction:row;width:100%;gap:6px;padding:10px 96px 4px 12px;overflow-x:auto}",
      "  [role=dialog][aria-modal=true] [class$=_navTitle]{display:none}",
      "  [role=dialog][aria-modal=true] [class$=_navList]{flex:none;flex-direction:row;gap:4px}",
      "  [role=dialog][aria-modal=true] [class$=_navCell]{width:38px;height:38px;justify-content:center;padding:0}",
      "  [role=dialog][aria-modal=true] [class$=_navLabel]{display:none}",
      // v0.3.6：设置顶栏单行化——header（settings.action 功能按钮 + 关闭）脱离文档流，
      // 绝对定位浮到导航行右侧，与导航图标合并为一行；分节区由 .options 自己滚动。
      // v0.3.8 修复：这里必须带空格（后代选择器）——.content 自身没有 role/aria 属性，
      // 无空格的选择器要求元素同时带 role+aria+class 结尾，只会匹配到 panel（class 是
      // _panel），.content 根本不命中 → min-height:0/overflow:visible 从未生效 →
      // .content 高度随内容撑开，.options 无法滚动（手机端设置内容滑不动）。
      "  [role=dialog][aria-modal=true] [class$=_content]{flex:1;min-height:0;overflow:visible}",
      "  [role=dialog][aria-modal=true] [class$=_header]{position:absolute;top:10px;right:12px;z-index:3;height:auto;min-height:0;padding:0;align-items:center;justify-content:flex-end;background:0 0;border:none}",
      "  [role=dialog][aria-modal=true] [class$=_header] [class$=_actions]{margin-left:0}",
      "}"
    ].join("\\n");
    document.head.appendChild(st);
  } catch (e) {}

  // 2.1) 抽屉（覆盖式侧栏）里的品牌 logo 缩小：桌面 60px 高的 logoRow 在手机上太占地方
  //      注意 brand 按钮是双类名（hHd-Xa_brand hHd-Xa_wide），class$= 匹配不到，要用 class*=。
  //      v0.3.10：抽屉布局用 CSS !important 强制（标记 data-dsh-overlay 挂在 body 上）。
  //      applyOverlayLayout 设的内联样式会被 DSH React 展开后的重绘覆盖（观察器不触发），
  //      导致抽屉塌回 280px + 右侧空白；!important 压过内联写入，body 标记扛过重绘/换节点。
  try {
    var stL = document.createElement("style");
    stL.textContent = [
      "@media (max-width: 1023px){",
      "  [data-dsh-overlay] [class$=_logoRow]{height:32px;margin-bottom:4px}",
      "  [data-dsh-overlay] [class*=_brand]{height:20px}",
      "  [data-dsh-overlay] [class*=_brand] svg{height:16px;width:auto}",
      "  body[data-dsh-overlay] [class$=_sidebarCol]{position:fixed!important;top:0!important;bottom:0!important;left:0!important;width:100vw!important;z-index:60!important;overflow:visible!important}",
      "  body[data-dsh-overlay] [class$=_sidebarCol] [class$=_root]{width:100%!important}",
      // v0.3.16：抽屉内容「有时满宽有时缩在 280px」根因——DSH 的外层侧栏壳（hHd-Xa_root，
      // 类属性以 quietBars/collapsed 结尾，[class$=_root] 匹配不到）带内联 style width:280px
      // （用户可调侧栏宽的持久化值），把整条内容链锁死在 280px；列被强制 100vw 后右侧留白。
      // 结构选择器 > div > div 精确命中该壳（col > div(contents) > 壳），!important 压过内联。
      // 无头实测：280px→390px，React 重绘后仍 390px（样式表规则不受重绘影响）。
      "  body[data-dsh-overlay] [class$=_sidebarCol] > div > div{width:100%!important;max-width:none!important}",
      // v0.3.15：纯 CSS 兜底——抽屉打开期间用 !important 强制 frame 的 grid 为
      // 0px 1fr 0px（对话列恒满宽、详情轨恒 0）。此前只强制了侧栏本身（fixed 100vw），
      // 若 JS 看门狗/观察器未生效（如 arm() 中途抛错），DSH 异步渲染撑开详情轨道时
      // 对话区仍会被挤窄（真机“先正确后收缩”）。CSS !important > React 内联，同帧生效。
      "  body[data-dsh-overlay] [class$=_frame]{grid-template-columns:0px minmax(0px, 1fr) 0px!important}",
      "}"
    ].join("\\n");
    document.head.appendChild(stL);
  } catch (e) {}

  // 2.5) composer 工具栏：窄屏重排，模型名换 Logo、访问模式只留图标；模型菜单居中
  try {
    var st2 = document.createElement("style");
    st2.textContent = [
      "@media (max-width: 1023px){",
      "  .uV2eYG_row{flex-wrap:nowrap;gap:6px}",
      "  [class$=_7KE1Ra_trigger]{width:34px;height:34px;padding:0;border-radius:50%;justify-content:center}",
      "  [class$=_7KE1Ra_triggerLabel],[class$=_7KE1Ra_chevron]{display:none!important}",
      "  [class$=Sh0Q9G_trigger]{width:34px;height:34px;padding:0;border-radius:8px;justify-content:center}",
      "  [class$=Sh0Q9G_triggerLabel],[class$=Sh0Q9G_chevron]{display:none!important}",
      // 模型选择菜单居中（桌面端右对齐，手机端居中）
      "  [class$=_7KE1Ra_menu]{left:50%!important;right:auto!important;transform:translateX(-50%)!important;max-width:min(280px,100vw - 32px)}",
      "}"
    ].join("\\n");
    document.head.appendChild(st2);
  } catch (e) {}
  // 2.5b) 顶栏 headerActions：窄屏下只保留图标，隐藏文字标签，节省空间给对话标题
  try {
    var stH = document.createElement("style");
    stH.textContent = [
      "@media (max-width: 1023px){",
      // 标准模式标签 SVAs4q_label：只显示图标，overflow:hidden 裁剪文本节点
      "  [class$=_label]{max-width:22px;height:22px;padding:0 2px;justify-content:center;overflow:hidden}",
      "  [class$=_label] > [class$=_icon]{flex:none;margin:0}",
      // v0.3.6：Session log 按钮 nL4_yW_sessionLogButton：手机端完全隐藏（v0.3.4 起只收成图标）
      "  [class$=_sessionLogButton]{display:none!important}",
      // 标题区给更多空间
      "  [class$=_titleRow]{gap:2px}",
      "  [class$=_titleCluster]{gap:4px}",
      "  [class$=_crumb]{max-width:180px;font-size:13px}",
      // v0.3.9：侧边栏唯一入口=标题行最左侧图标；有标题行时隐藏 DSH 自带侧栏开关（防双入口）。
      // 只收窄到侧栏列内的 _toggle（.hHd-Xa_toggle），不误伤轨迹面板等其它 *_toggle 元素。
      "  body:has([class$=_titleRow]) [class$=_sidebarCol] [class$=_toggle]{display:none!important}",
      "  #dsh-sidebar-toggle:hover,#dsh-sidebar-toggle:active{background:var(--dsw-alias-interactive-bg-hover)}",
      "}"
    ].join("\\n");
    document.head.appendChild(stH);
  } catch (e) {}
  // 2.5c) 会话统计栏（FJxK0a_root）：点击展开 Tooltip 后 1 秒自动关闭
  // Tooltip 通过 onMouseLeave 关闭（React 合成事件），dispatch mouseleave 到统计栏元素即可触发
  function armStatsAutoClose(){
    try {
      var closeTimer = null;
      function scheduleClose(rootEl){
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(function(){
          try {
            var evt = new MouseEvent("mouseleave", { bubbles: true, relatedTarget: document.body });
            rootEl.dispatchEvent(evt);
          } catch (e) {}
          closeTimer = null;
        }, 1000);
      }
      document.addEventListener("click", function(e){
        var el = e.target;
        while (el && el !== document.body) {
          if (el.classList && el.classList.toString().indexOf("_root") > -1 && el.querySelector("[class$=_sep]")) {
            // 统计栏被点击，等 300ms tooltip 展开后开始计时
            setTimeout(function(){ scheduleClose(el); }, 300);
            return;
          }
          el = el.parentElement;
        }
      }, true);
    } catch (e) {}
  }
  // 2.6) 提问卡片（ask_user_question）手机端可见性：composer 座位 sticky 固定底部，卡片不塌陷
  try {
    var stQ = document.createElement("style");
    stQ.textContent = [
      "@media (max-width: 1023px){",
      "  [data-composer-seat]{flex:none;position:sticky;bottom:0;z-index:5}",
      "  [data-composer-seat] [data-slot=conversation.composer]{z-index:1;position:relative}",
      "  [data-question-key]{z-index:1;position:relative}",
      "  [data-question-key] [class$=_card]{max-height:min(50vh,420px)}",
      "}"
    ].join("\\n");
    document.head.appendChild(stQ);
  } catch (e) {}
  // 2.7) 触屏全局修复：DSH 桌面端依赖 :hover 伪类实现交互反馈，
  // 触屏设备没有 hover 状态，导致按钮不可见/无反馈。这里强制 hover 状态始终可见。
  try {
    var stT = document.createElement("style");
    stT.textContent = [
      "@media (hover: none) and (max-width: 1023px){",
      // 图标按钮始终显示 hover 背景（否则透明不可见）
      "  [class$=_iconButton]{background:var(--dsw-alias-interactive-bg-hover)}",
      // 会话行/项目行始终显示 hover 背景
      "  [class$=_sessionRow],[class$=_projectRow],[class$=_searchResultRow]{background:var(--dsw-alias-interactive-bg-hover)}",
      // sectionHeader 操作按钮始终可见
      "  [class$=_sectionHeader]{overflow:visible}",
      "  [class$=_headerActions]{opacity:1!important;visibility:visible!important;max-width:none!important}",
      "}"
    ].join("\\n");
    document.head.appendChild(stT);
  } catch (e) {}
  // 给模型触发器插入 DeepSeek Logo 图标（点击仍打开模型菜单；返回 true 表示已就绪）
  function installModelLogo(){
    try {
      var t = document.querySelector("[class$=_7KE1Ra_trigger]");
      if (!t || t.querySelector("[data-dsh-model-logo]")) return true;
      var s = document.createElement("span");
      s.setAttribute("data-dsh-model-logo", "1");
      s.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:none;";
      // DeepSeek "D" 圆形图标（16px 清晰可辨，触屏友好）
      s.innerHTML = "<svg width=\\"16\\" height=\\"16\\" viewBox=\\"0 0 16 16\\" fill=\\"none\\"><circle cx=\\"8\\" cy=\\"8\\" r=\\"7\\" stroke=\\"currentColor\\" stroke-width=\\"1.5\\"/><text x=\\"8\\" y=\\"11.5\\" text-anchor=\\"middle\\" fill=\\"currentColor\\" font-size=\\"9\\" font-weight=\\"700\\" font-family=\\"system-ui,-apple-system,sans-serif\\">D</text></svg>";
      t.insertBefore(s, t.firstChild);
      return true;
    } catch (e) { return true; }
  }
  function watchModelLogo(){
    try { if (installModelLogo()) return; } catch (e) {}
    try {
      var obs = new MutationObserver(function(){ if (installModelLogo()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function(){ obs.disconnect(); }, 30000);
    } catch (e) {}
  }

  // 3) 侧边栏：默认折叠成 0；点开关后以「覆盖式抽屉」滑出（不挤压对话，不重排 → 无卡顿）
  // v0.3.13：lastOpenAt 记录最近一次打开时间，closeOverlay 用它做 400ms 防误关守卫——
  // 真机 WebView 的 tap 会在抽屉打开的瞬间把点击重定向到刚出现的全屏遮罩
  //（#dsh-drawer-mask），触发遮罩 click→closeOverlay → 「打开后先正确后收缩」。
  // v0.3.10 的 CSS !important 只强制「标记存在期间」侧栏满宽，但 closeOverlay 会把
  // data-dsh-overlay 标记本身移除 → CSS 失效 → 塌回 0px，故必须拦在误关源头。
  var state = { hidden: true, overlay: false, lastOpenAt: 0 };
  var layoutObserver = null, collapseObserver = null;  // 供 closeOverlay 断开/重连
  function frameEl(){ var o = document.querySelector("[data-shell-overlay]"); return o ? o.parentElement : null; }
  function sidebarColEl(){ var f = frameEl(); return f ? f.querySelector("[class$=_sidebarCol]") : null; }
  function centerColEl(){ var f = frameEl(); return f ? f.querySelector("[class$=_centerCol]") : null; }
  function detailsColEl(){ var f = frameEl(); return f ? f.querySelector("[class$=_detailsCol]") : null; }
  function toggleBtn(){ var f = frameEl(); if (!f) return null; return f.querySelector("[class$=_toggle]"); }
  function spacerEl(){ var f = frameEl(); return f ? f.querySelector("[data-dsh-drawer-spacer]") : null; }
  function maskEl(){ return document.getElementById("dsh-drawer-mask"); }

  function applyHidden(frame){
    try {
      // 只压轨道，不设 display:none（display:none 会把列移出 grid 流，centerCol
      // 顺位占进第 1 个 0px 轨道 → 对话区黑屏）。0px 轨道 + overflow:hidden 已完全折叠。
      var cur = frame.style.gridTemplateColumns;
      if (cur) frame.style.gridTemplateColumns = "0px" + cur.slice(cur.indexOf(" "));
      // 窄屏下 DSH 会把 sidebarCol 设为 position:absolute（57px 悬浮功能栏，脱离 0px
      // 轨道照样显示）。仅压轨道收不掉它，必须再把宽度压成 0 + 裁掉内容（实测根因）。
      var sb = sidebarColEl();
      if (sb) { sb.style.width = "0"; sb.style.overflow = "hidden"; sb.style.minWidth = "0"; }
    } catch (e) {}
  }
  // 详情列强制隐藏：宽视口下 DSH 会自动打开右侧详情面板且难以关闭（“进详情页卡死”）。
  function applyDetailsHidden(frame){
    try {
      var handle = frame.querySelector("[class$=_handle][data-side=details]");
      if (handle) handle.style.display = "none";
      var cur = frame.style.gridTemplateColumns;
      if (cur) {
        // 只把最后一段（详情轨道）置 0，前面保留（minmax 内部可能有空格，不能简单 split）
        var s = String(cur).trim();
        var i = s.lastIndexOf(" ");
        if (i > 0) frame.style.gridTemplateColumns = s.slice(0, i) + " 0px";
      }
    } catch (e) {}
  }
  function ensureMask(){
    try {
      if (maskEl()) return;
      var m = document.createElement("div");
      m.id = "dsh-drawer-mask";
      m.style.cssText = "position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.45);opacity:0;transition:opacity .22s;";
      m.addEventListener("click", closeOverlay);
      document.body.appendChild(m);
      requestAnimationFrame(function(){ m.style.opacity = "1"; });
    } catch (e) {}
  }
  function ensureSpacer(frame){
    // 覆盖态：在轨道1插入一个占位 div（保持 centerCol 排在轨道2=满宽），
    // 侧边栏用 position:fixed 覆盖在上面。全程不改 grid（0px 折叠轨道不变），
    // 因此不会与“折叠观察器”互相覆盖造成循环，也天然不会黑屏。
    try {
      if (spacerEl()) return;
      var sp = document.createElement("div");
      sp.setAttribute("data-dsh-drawer-spacer", "1");
      sp.style.cssText = "width:0;height:0;";
      var sb = sidebarColEl();
      frame.insertBefore(sp, sb);
    } catch (e) {}
  }
  function applyOverlayLayout(frame){
    try {
      ensureSpacer(frame);
      // 强制首轨道 0：即便 App 因展开而把网格改成 256px…，这里也拉回 0，
      // spacer 占住轨道1、centerCol 始终在轨道2=满宽，侧栏 fixed 覆盖其上。
      frame.style.gridTemplateColumns = "0px minmax(0px, 1fr) 0px";
      var sb = sidebarColEl();
      if (!sb) return;
      sb.style.position = "fixed";
      sb.style.top = "0"; sb.style.bottom = "0"; sb.style.left = "0";
      sb.style.width = "100vw";
      sb.style.overflow = "visible"; // 覆盖 applyHidden 的 width:0/overflow:hidden，抽屉要展开
      sb.style.zIndex = "60";
      // 抽屉里自带的折叠按钮冗余且会触发 App 展开逻辑，隐藏掉
      var t = toggleBtn(); if (t) t.style.display = "none";
      var h = frame.querySelector("[class$=_handle][data-side=details]"); if (h) h.style.display = "none";
      ensureMask();
    } catch (e) {}
  }
  function openOverlay(){
    var frame = frameEl();
    if (!frame || state.overlay) return;
    state.hidden = false; state.overlay = true;
    state.lastOpenAt = Date.now(); // v0.3.13：防误关守卫的时间基准
    // v0.3.10：标记放 document.body（非 React 管理），扛过 React 重绘/换节点
    try { document.body.setAttribute("data-dsh-overlay", "1"); } catch (e) {}
    // v0.3.12：抽屉打开时隐藏左上角 hero 兜底按钮
    try { ensureHeroToggle(); } catch (e) {}
    var sb = sidebarColEl();
    if (sb) { sb.style.transition = "transform .25s ease"; sb.style.transform = "translateX(-100%)"; }
    // 让 App 展开侧边栏，渲染完整内容（含底部「设置」入口），展开网格随后被覆盖态拉回 0
    if (frame.hasAttribute("data-sidebar-collapsed")) {
      var t = toggleBtn(); if (t) t.click();
    }
    applyOverlayLayout(frame);
    requestAnimationFrame(function(){ try { if (sidebarColEl()) sidebarColEl().style.transform = "translateX(0)"; } catch (e) {} });
  }
  function closeOverlay(){
    var frame = frameEl();
    if (!frame || !state.overlay) return;
    // v0.3.13：防误关——打开后 400ms 内的 closeOverlay 一律忽略。
    // 真机 WebView tap→click 重定向：抽屉打开瞬间全屏遮罩出现在手指下方，
    // WebView 把本次点击补发到遮罩 → 遮罩 click→closeOverlay → “打开后先正确后收缩”。
    // 覆盖的误关路径：遮罩重定向点击 / 多余二次 toggle / armSessionAutoClose 300ms 误触发。
    // 400ms > 250ms 滑入动画 + 实测 ~270ms 收缩点，留足余量；之后所有关闭路径恢复正常。
    if (Date.now() - state.lastOpenAt < 400) return;
    state.overlay = false;
    try { document.body.removeAttribute("data-dsh-overlay"); } catch (e) {}
    // v0.3.12：抽屉关闭后按当前状态刷新左上角 hero 兜底按钮
    try { ensureHeroToggle(); } catch (e) {}
    // 立即隐藏 DSH 原生 backdrop（否则我们的遮罩淡出后它仍亮着、还会以慢速过渡再淡一次 → “收回播放两次”）
    try {
      var nb = frame.querySelector("[data-sidebar-backdrop]");
      if (nb) { nb.style.transition = "none"; nb.style.opacity = "0"; nb.style.pointerEvents = "none"; }
    } catch (e) {}
    // 收回期间禁用原生 grid 过渡，只保留下面这一次滑出动画（侧栏自身 transform 过渡为内联独立设置，不受影响）
    try { frame.style.transition = "none"; } catch (e) {}
    var sb = sidebarColEl();
    if (sb) {
      sb.style.transition = "transform .25s ease";
      sb.style.transform = "translateX(-100%)";
      // 冻结：DSH 内部 grid 变更不会触发动画或交互，防止收回动画播放两次
      sb.style.pointerEvents = "none";
    }
    var m = maskEl(); if (m) m.style.opacity = "0";
    setTimeout(function(){
      try {
        var f = frameEl();
        if (!f || state.overlay) return;
        // 断开 observer，避免清理过程中 applyHidden/ensureCollapsed
        // 触发 enforceMobileLayout 循环 → 动画播放两次
        if (typeof layoutObserver !== "undefined" && layoutObserver) layoutObserver.disconnect();
        if (typeof collapseObserver !== "undefined" && collapseObserver) collapseObserver.disconnect();
        // 顺序：先移除 spacer，再让侧边栏回到流内（轨道1=0px），centerCol 始终在轨道2
        var sp = spacerEl(); if (sp) sp.remove();
        var sb2 = sidebarColEl();
        if (sb2) {
          // 先禁用侧栏自身过渡，避免原生 rail（0→56px）宽度变化再次动画
          sb2.style.transition = "none";
          sb2.style.position = ""; sb2.style.top = ""; sb2.style.bottom = ""; sb2.style.left = "";
          sb2.style.width = ""; sb2.style.transform = ""; sb2.style.zIndex = "";
          sb2.style.overflow = ""; sb2.style.minWidth = "";
          sb2.style.pointerEvents = "";
        }
        var t = toggleBtn(); if (t) t.style.display = "";
        var m2 = maskEl(); if (m2) m2.remove();
        state.hidden = true;
        applyDetailsHidden(f);
        applyHidden(f);
        // 恢复折叠态（App 侧栏展开标志复位，避免回到挤压布局）
        ensureCollapsed(f);
        // 重新挂载 observer
        if (typeof layoutObserver !== "undefined" && layoutObserver) {
          layoutObserver.observe(f, { attributes: true, attributeFilter: ["style", "class", "data-details-collapsed"], subtree: false });
        }
        if (typeof collapseObserver !== "undefined" && collapseObserver) {
          collapseObserver.observe(f, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
        }
        // 等 DSH 折叠渲染落定后再恢复框架过渡（仅当仍是本补丁设的 none，避免覆盖 DSH 自身设置）
        setTimeout(function(){
          try { var fr = frameEl(); if (fr && fr.style.transition === "none") fr.style.transition = ""; } catch (e) {}
        }, 350);
      } catch (e) {}
    }, 260);
  }
  function toggleSidebar(){ if (state.overlay) closeOverlay(); else openOverlay(); }
  // 暴露给安卓顶栏按钮调用
  try { window.__dshMobileToggleSidebar = toggleSidebar; } catch (e) {}

  function enforceMobileLayout(frame){
    ensureHeaderToggle(); // v0.3.9：帧变更时确保标题行侧边栏图标在（React 重建兜底）
    if (state.overlay) {
      // v0.3.10：防御性重挂标记——覆盖态期间 body 上必须始终有 data-dsh-overlay，
      // CSS !important 规则才持续强制侧栏满宽（否则 React 重绘后塌回 280px + 空白）。
      try { document.body.setAttribute("data-dsh-overlay", "1"); } catch (e) {}
      applyOverlayLayout(frame); return;
    }
    applyColumnPins(frame);
    applyDetailsHidden(frame);
    if (state.hidden) applyHidden(frame);
    // 防御（黑屏根因兜底）：列绝不允许离开 grid 流。谁把 sidebarCol/detailsCol 设成
    // display:none，centerCol 就会被自动排进第 1 个 0px 轨道 → 整个对话区黑屏。
    // 这里只在我们/别处显式设为 none 时恢复为流内元素（0px 轨道已能完全折叠）。
    try {
      var sb = sidebarColEl(); if (sb && sb.style.display === "none") sb.style.display = "";
      var dc = detailsColEl(); if (dc && dc.style.display === "none") dc.style.display = "";
    } catch (e) {}
  }
  // 三列显式固定到各自 grid 轨道。DSH 窄屏会把 sidebarCol 设为 position:absolute
  //（离开 grid 流），自动排位随之把 centerCol 挤进第 1 个 0px 轨道、detailsCol 落到
  // 满宽轨道 → 对话区消失 + 详情面板全屏（实测根因）。固定列号后排版不再受绝对定位影响。
  function applyColumnPins(frame){
    try {
      var sb = sidebarColEl(); if (sb) sb.style.gridColumn = "1";
      var cc = centerColEl(); if (cc) cc.style.gridColumn = "2";
      var dc = detailsColEl(); if (dc) dc.style.gridColumn = "3";
    } catch (e) {}
  }
  function ensureCollapsed(frame){ if (frame && !frame.hasAttribute("data-sidebar-collapsed")) { var b = toggleBtn(); if (b) b.click(); } }

  // 选择会话/项目后自动翻回抽屉。用 while 遍历 parentElement 而非 closest，
  // 因为选中行 class 末尾是 _selected 而非 _sessionRow，[class$=] 会匹配失败。
  function armSessionAutoClose(){
    document.addEventListener("click", function(e){
      if (!state.overlay) return;
      var el = e.target;
      while (el && el !== document.body) {
        if (el.classList) {
          var cls = el.classList.toString();
          // 项目行：只展开/收起项目分组，绝不收回抽屉（用户需求 v0.3.1）
          if (cls.indexOf("_projectRow") > -1) return;
          if (cls.indexOf("_sessionRow") > -1 || cls.indexOf("_searchResultRow") > -1) {
            setTimeout(closeOverlay, 300);
            return;
          }
        }
        el = el.parentElement;
      }
    }, true);
  }

  // v0.3.9：侧边栏入口收拢——网页悬浮球已删除，改为「会话标题行最左侧」固定图标。
  // ensureHeaderToggle：在会话头部标题行（[class$=_titleRow]）最左插入侧边栏图标，
  // 点击调 toggleSidebar() 打开/关闭覆盖式抽屉。React 重建标题行时会丢，需重插。
  // v0.3.11：除「整行重建」外，React 还会「原地重绘」标题行（reconcile children 把
  // 注入的图标删掉）——armHeaderToggle 只监听新增的 titleRow 节点，抓不到原地重绘；
  // 真实会话头重绘很频繁，图标刚注入就被删 → 对话界面看不到图标。挂 per-titleRow
  // childList 守护：图标被移除就重插（trArg 指向同一个标题行，避免误插其它行）。
  function ensureHeaderToggle(trArg){
    try {
      var tr = trArg || document.querySelector("[class$=_titleRow]");
      if (!tr || tr.querySelector("#dsh-sidebar-toggle")) return;
      var btn = document.createElement("button");
      btn.id = "dsh-sidebar-toggle";
      btn.type = "button";
      btn.setAttribute("aria-label", "打开侧边栏");
      btn.title = "打开侧边栏";
      btn.style.cssText = "display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;min-width:32px;margin:0 2px 0 0;border-radius:8px;background:transparent;border:none;color:var(--dsw-alias-label-primary);cursor:pointer;-webkit-tap-highlight-color:transparent;";
      btn.innerHTML = "<svg width=\\"20\\" height=\\"20\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><rect x=\\"3\\" y=\\"4\\" width=\\"18\\" height=\\"16\\" rx=\\"2\\"/><line x1=\\"9\\" y1=\\"4\\" x2=\\"9\\" y2=\\"20\\"/></svg>";
      btn.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); toggleSidebar(); });
      tr.insertBefore(btn, tr.firstChild);
      armTitleRowGuard(tr);
    } catch (e) {}
  }
  // v0.3.11：per-titleRow 守护——标题行每次被 React 重绘（childList 变化）都确认
  // 图标还在，被删就重插。insertBefore 触发自身回调时图标已存在 → 直接返回，无循环。
  function armTitleRowGuard(tr){
    try {
      if (tr.__dshGuard) return;
      tr.__dshGuard = true;
      var obs = new MutationObserver(function(){
        try {
          if (tr.querySelector("#dsh-sidebar-toggle")) return;
          if (!document.contains(tr)) return;
          ensureHeaderToggle(tr);
        } catch (e) {}
      });
      obs.observe(tr, { childList: true });
    } catch (e) {}
  }
  // v0.3.12：新对话（hero 空状态）没有 titleRow → 标题行图标无法注入 + 侧栏完全收起
  // → 新对话页无任何侧边栏入口。补一个左上角固定兜底按钮（#dsh-mobile-hero-toggle），
  // 仅在 hero 阶段（无 titleRow、无弹窗、抽屉未开）显示；z-45 低于抽屉遮罩 z-50，
  // 抽屉打开时自动被遮住。点击调 toggleSidebar()。nodeRelevant 供观察器判断相关节点。
  function nodeRelevant(n){
    if (!n || n.nodeType !== 1) return false;
    var sels = ["[class$=_titleRow]", "[class$=_root]", "[role=dialog][aria-modal=true]"];
    for (var s = 0; s < sels.length; s++) {
      if (n.matches && n.matches(sels[s])) return true;
      if (n.querySelector && n.querySelector(sels[s])) return true;
    }
    return false;
  }
  function ensureHeroToggle(){
    try {
      var btn = document.getElementById("dsh-mobile-hero-toggle");
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "dsh-mobile-hero-toggle";
        btn.type = "button";
        btn.setAttribute("aria-label", "打开侧边栏");
        btn.title = "打开侧边栏";
        btn.style.cssText = "position:fixed;top:10px;left:10px;z-index:45;display:none;align-items:center;justify-content:center;width:32px;height:32px;min-width:32px;border-radius:8px;background:rgba(127,127,127,0.12);border:none;color:var(--dsw-alias-label-primary);cursor:pointer;-webkit-tap-highlight-color:transparent;";
        btn.innerHTML = "<svg width=\\"20\\" height=\\"20\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><rect x=\\"3\\" y=\\"4\\" width=\\"18\\" height=\\"16\\" rx=\\"2\\"/><line x1=\\"9\\" y1=\\"4\\" x2=\\"9\\" y2=\\"20\\"/></svg>";
        btn.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); toggleSidebar(); });
        document.body.appendChild(btn);
      }
      var show = !!document.querySelector("[class$=_root][data-phase=hero]")
        && !document.querySelector("[class$=_titleRow]")
        && !document.querySelector("[role=dialog][aria-modal=true]")
        && !document.body.hasAttribute("data-dsh-overlay");
      btn.style.display = show ? "flex" : "none";
    } catch (e) {}
  }
  // armHeaderToggle：arm 时 + 会话头/hero 根/弹窗变化时刷新「标题行图标」与「hero 兜底按钮」。
  // 只处理 added/removed 里出现相关节点的变更（低频）与 data-phase 属性变化（hero→active
  // 是原地属性变化，childList 观察不到），其余 DOM 变更直接忽略，成本极低。
  function armHeaderToggle(){
    try { ensureHeaderToggle(); ensureHeroToggle(); } catch (e) {}
    try {
      var obs = new MutationObserver(function(ms){
        var relevant = false;
        for (var i = 0; i < ms.length && !relevant; i++) {
          var m = ms[i];
          if (m.type === "attributes" && m.attributeName === "data-phase") { relevant = true; break; }
          for (var k = 0; k < 2 && !relevant; k++) {
            var nodes = k === 0 ? m.addedNodes : m.removedNodes;
            for (var j = 0; j < nodes.length; j++) {
              if (nodeRelevant(nodes[j])) { relevant = true; break; }
            }
          }
        }
        if (relevant) {
          ensureHeaderToggle(); ensureHeroToggle();
          // v0.3.17：phase 切换（hero→active）后聊天根节点才可能出现 → 强制重扫密排
          enforceMobileChatLayout(true);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-phase"] });
    } catch (e) {}
  }

  // v0.3.4：手机端内容区密排——聊天列左右边距收窄、表格更密、markdown 更紧凑。
  // 移动 style 只注入一次；clearance 覆盖在聊天根节点（定义该变量的 .wSkVaW_root）上
  // 用 inline 压过类规则（inline > class），配合 DSH 内部 calc(+16px) 得到每侧 10px。
  var chatStyleInjected = false;
  function ensureMobileChatStyle(){
    if (chatStyleInjected) return;
    chatStyleInjected = true;
    try {
      var st = document.createElement("style");
      st.textContent = [
        "/* v0.3.4 mobile dense */",
        '[data-conversation-scroll] [class*="_tableScroll_"] th,',
        '[data-conversation-scroll] [class*="_tableScroll_"] td{padding:6px 10px;min-width:72px;max-width:min(40vw,220px)}',
        '[data-conversation-scroll] [class*="_tableScroll_"] table code{font-size:12px}',
        '[data-conversation-scroll] [class*="_markdown_"] h1,',
        '[data-conversation-scroll] [class*="_markdown_"] h2,',
        '[data-conversation-scroll] [class*="_markdown_"] h3{margin:20px 0 8px}',
        '[data-conversation-scroll] [class*="_markdown_"] h4{margin:12px 0 6px}',
        '[data-conversation-scroll] [class*="_markdown_"] pre{margin:10px 0}',
        '[data-conversation-scroll] [class*="_markdown_"] blockquote{margin:10px 0 0;padding-left:10px}'
      ].join("\\n");
      document.head.appendChild(st);
    } catch (e) {}
  }
  var chatRootEl = null;
  var chatScanFails = 0; // v0.3.17：连续找不到聊天根的次数（负缓存，防每次全树 getComputedStyle）
  function enforceMobileChatLayout(force){
    ensureMobileChatStyle();
    try {
      if (!chatRootEl || !document.contains(chatRootEl)) {
        // v0.3.17：负缓存——连续 3 次全树扫描都找不到聊天根（hero 页等无该变量的场景）
        // 就挂起，phase 切换/结构变化时由调用方 force=true 重置重扫。此前挂在
        // layoutObserver/collapseObserver 每次回调上，找不到时每次 DOM 变更都全树
        // TreeWalker + 逐节点 getComputedStyle（强制样式计算）→ 真机卡顿源。
        if (!force && chatScanFails >= 3) return;
        var walker = document.createTreeWalker(document.body, 1 /* SHOW_ELEMENT */);
        var n;
        var found = null;
        while ((n = walker.nextNode())) {
          if (getComputedStyle(n).getPropertyValue("--dsh-composer-side-clearance") !== "") { found = n; break; }
        }
        if (found) { chatRootEl = found; chatScanFails = 0; }
        else { chatScanFails++; return; }
      }
      if (chatRootEl && document.contains(chatRootEl)) chatRootEl.style.setProperty("--dsh-composer-side-clearance", "-6px");
    } catch (e) {}
  }

  // v0.3.14：布防守卫——DSH 异步渲染随时可能改写 frame 的 grid（真机实测：抽屉打开后
  // 1-3s 详情面板 data-details-collapsed 被 DSH 置 false、详情轨道被撑开 → 对话区右侧
  // 空白变窄）。观察器可能因节点替换/未知属性漏触发，这里低频轮询兜底：
  // 覆盖态恒保持「0px minmax(0px,1fr) 0px + 侧栏 fixed 满宽 + 三列固定」，
  // 非覆盖态恒保持「轨道1/3 归零 → 对话区满宽」。幂等（设置相同内联值不触发 reflow）。
  var layoutWatchdog = null;
  function armLayoutWatchdog(){
    if (layoutWatchdog) return;
    layoutWatchdog = setInterval(function(){
      try {
        if (document.hidden) return; // 后台时跳过，省电
        var f = frameEl();
        if (!f) return;
        if (state.overlay) {
          // v0.3.15：覆盖态必须持续重挂 body 标记，CSS !important 规则（侧栏满宽 + grid 满宽）
          // 才始终生效——即使标记被意外移除，下一拍即恢复，对话区永不收缩。
          try { document.body.setAttribute("data-dsh-overlay", "1"); } catch (e) {}
          // v0.3.16：JS 兜底——若 DSH 改结构导致 > div > div 选择器失配，壳的内联
          // width:280px 会重新锁死内容宽度。从内层 root 向上走到列，凡带内联像素宽的
          // 中间层一律改 100%（CSS 规则正常时此循环无操作，幂等）。
          try {
            var colEl = document.querySelector('[class$=_sidebarCol]');
            var innerRoot = colEl && colEl.querySelector('[class$=_root]');
            if (colEl && innerRoot) {
              var up = innerRoot.parentElement;
              while (up && up !== colEl) {
                // 注意：本补丁整体位于模板字符串内，正则 \d 必须写成 \\d 才能落到内层脚本
                if (up.style && /^\\d+px$/.test(up.style.width || "")) up.style.width = "100%";
                up = up.parentElement;
              }
            }
          } catch (e) {}
          applyOverlayLayout(f);
          applyColumnPins(f);
        } else {
          enforceMobileLayout(f);
          enforceMobileChatLayout(); // v0.3.17：慢路径补聊天密排（找不到时负缓存，开销为零）
        }
      } catch (e) {}
    }, 400);
  }

  function arm(){
    var frame = frameEl();
    if (!frame) return;
    // v0.3.9：无悬浮球（已删除）——侧边栏入口统一为「标题行最左侧图标」（armHeaderToggle 注入）。
    // v0.3.15：每步独立 try/catch——此前 ensureCollapsed(frame) 的 b.click() 若在真机上抛错，
    // 会中断整个 arm()，导致后面的 armLayoutWatchdog 与观察器从未挂载（抽屉打开后 DSH 异步
    // 渲染撑开详情轨道时无人纠正 → “先正确后收缩”）。现在任一步失败都不影响后续加固挂载。
    try { armHeaderToggle(); } catch (e) {}
    try { ensureHeroToggle(); } catch (e) {}
    try { watchModelLogo(); } catch (e) {}
    try { armSessionAutoClose(); } catch (e) {}
    try { armStatsAutoClose(); } catch (e) {}
    try { ensureCollapsed(frame); } catch (e) {}
    try { enforceMobileLayout(frame); } catch (e) {}
    try { enforceMobileChatLayout(); } catch (e) {}
    try { armLayoutWatchdog(); } catch (e) {}
    try {
      // v0.3.14：attributeFilter 增加 class / data-details-collapsed——DSH 用数据属性
      // 驱动详情面板，只盯 style 抓不到（详情轨道被撑开 → 对话区被挤窄）。
      layoutObserver = new MutationObserver(function(){ enforceMobileLayout(frame); });
      layoutObserver.observe(frame, { attributes: true, attributeFilter: ["style", "class", "data-details-collapsed"], subtree: false });
      collapseObserver = new MutationObserver(function(){ enforceMobileLayout(frame); });
      collapseObserver.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
    } catch (e) {}
  }
  function waitForFrame(){
    if (frameEl()) { arm(); return; }
    var obs = new MutationObserver(function(){
      if (frameEl()) { obs.disconnect(); arm(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function(){ obs.disconnect(); }, 20000);
  }
  if (document.body) waitForFrame();
  else document.addEventListener("DOMContentLoaded", waitForFrame);
})();
</script>`;

/**
 * 把补丁注入 index.html（幂等：已注入则原样返回）。
 * @param {string} html - DSH 前端 index.html 内容。
 * @returns {string} 注入后的 HTML。
 */
export function injectMobilePatch(html) {
	if (typeof html !== "string") return html;
	if (html.includes(PATCH_MARKER) || html.includes('id="dsh-sidebar-toggle"')) return html;
	if (html.includes("</head>")) {
		return html.replace("</head>", `<!-- dsh-mobile-patch -->\n${PATCH_SCRIPT}\n</head>`);
	}
	return `<!-- dsh-mobile-patch -->\n${PATCH_SCRIPT}\n${html}`;
}

export { PATCH_MARKER };
