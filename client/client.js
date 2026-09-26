/**
 * dsh-appearance —— 客户端插件（设置页「外观」面板 + 把服务端生成的 CSS 注入页面）
 *
 * 加载形状照抄本机已跑通的两份客户端插件（dsh-guard / dsh-plugin-group-tools）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * ⚠️ exports.inject 里列的是 **Cordis 服务名**，不是包名！
 *   2026-09-14 真机事故（账本 E07）：写成包名 ['@deepseek-ai/dsh-client-ui-settings']
 *   → 客户端去等一个永远不存在的服务 → 插件加载失败 → **界面白屏**，而服务端零报错。
 *   包名要放在 package.json 的 dsh.client.inject（那里写对了）；这里只写服务名。
 *   本插件用到 ctx.slots（挂设置页 Tab）⇒ 只 inject 'slots'。
 *
 * 分工：**CSS 由服务端生成**（lib/appearance-core.js 是唯一真源），
 *      客户端只做两件事：① 拉 style.css 贴进 <style>；② 渲染编辑面板。
 */
window.__ModuleLoader__.load({
  // ⚠️ 必须等于**包名**（dsh-appearance-editor）：官方端按包名把这一行注册进客户端图，
  //    加载后还会断言「这个 id 注册过」——不一致就抛
  //    `loaded without registering "<pkg>" via __ModuleLoader__.load`，
  //    结果是面板不挂载、CSS 注入失效（2026-09-26 真机报错，账本 E80）。
  id: 'dsh-appearance-editor',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var name = 'dsh-appearance'
    var inject = ['slots']

    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useState = React.useState
    var useRef = React.useRef

    var BASE = '/dsh-appearance'
    var STYLE_ID = 'dsh-appearance-style'

    /**
     * 临时垫片（2026-09-26，第二版）：官方端**三层嵌套容器都读同一个 token**
     * （DIV.ZTP-Xa_frame / DIV.ZTP-Xa_sidebarCol / DIV.n_2Q3W_root，来自页面回传的 diag.json），
     * 半透明是**相乘**的 ⇒ 用户设 0.41 实际合成 ≈ 0.80，壁纸被压得看不见。
     * ❌ 第一版我用 `body > div, body > div > div { background: transparent }` 压平容器 ——
     *    结果**设置面板也被压平**（用户报"怎么面板变透明了"）。**别用结构选择器**。
     * ✅ 改为**数值补偿**：A' = 1-(1-A)^(1/3)，让三层合成后 ≈ 用户设定值。
     * ⚠️ 2026-09-26 用户第二次反馈："这个设置面板能别这么透明嘛，不好调整" ——
     *    浮层/卡片用的 layer-* 原来也跟随滑块 ⇒ 设置面板自己的底被染透、没法看。
     *    ⇒ layer-* 加 **0.85 的不透明下限**（浮层保持可读），只有主内容区（上面两个）跟随滑块。
     * 服务端 `lib/appearance-core.js` 有同一份（要重启官方端才加载）；这段让 Ctrl+R 就能生效。
     */
    function compatCss(state) {
      var A = (state && typeof state.surfaceAlpha === 'number') ? state.surfaceAlpha : 0.9
      if (!(A > 0 && A <= 1)) A = 0.9
      var Ac = Math.round((1 - Math.pow(1 - A, 1 / 3)) * 1000) / 1000
      var Alayer = Math.max(A, 0.85)
      var stacked = ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill']
      var layered = ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3']
      var rule = function (rgb) {
        return stacked.map(function (k) { return k + ': rgba(' + rgb + ',' + Ac + ') !important' }).join('; ') + '; ' +
          layered.map(function (k) { return k + ': rgba(' + rgb + ',' + Alayer + ') !important' }).join('; ')
      }
      return 'body:not([data-ds-dark-theme]) { ' + rule('255,255,255') + '; }\n' +
        'body[data-ds-dark-theme] { ' + rule('21,21,23') + '; }'
    }

    // ---------------------------------------------------------------- 顶栏自动隐藏（2026-09-26 新增）
    // 外壳版有这个能力，官方端也能做 —— 依据全在 app.asar 里核对过，不是猜的：
    //   · Windows 顶带：`html[data-windows-titlebar]`，高度来自 `--dsh-windows-titlebar-height`
    //     （preload 用 root.style.setProperty 写成 40px）；条带由 `.ZTP-Xa_frame::before` 画出并带
    //     `-webkit-app-region: drag`（窗口拖拽区）。⇒ 把那个变量压到 4px 就等于收起条带，
    //     同时**保留 4px 拖拽区**（跟外壳版"收起留 3px 无感拖拽"同一思路）。
    //   · Windows 菜单栏（应用/编辑）是 preload 注入的 DOM：`[role="menubar"]`，可直接隐。
    //   · 会话头是 CSS Modules 类名 `<hash>_header`（hash 每版会变、后缀不变）⇒ 用 `[class*="_header"]`
    //     找，并**排除浮层内**（祖先含 `_overlay`）的 header，免得把设置面板的头也折叠了。
    // ⚠️ 局限（如实说）：原生窗口按钮（最小化/最大化/关闭）不由 DOM 画，**折不掉** ——
    //    外壳当年能完全收起，是因为它自绘了条带和按钮。
    var TOPBAR_ATTR = 'data-dsh-topbar'
    var topbarMarked = []
    var TOPBAR_CSS = [
      // 收起 = 把顶带厚度压到 4px（收回那 40px，只留 4px 拖拽区）
      'html.dsh-hidetop[data-dsh-topbar-hidden="1"] { --dsh-windows-titlebar-height: 4px !important; }',
      'html.dsh-hidetop[data-dsh-topbar-hidden="1"] [role="menubar"],',
      'html.dsh-hidetop[data-dsh-topbar-hidden="1"] [' + TOPBAR_ATTR + '="1"] {',
      '  height: 0 !important; min-height: 0 !important; max-height: 0 !important;',
      '  padding-top: 0 !important; padding-bottom: 0 !important; margin-top: 0 !important; margin-bottom: 0 !important;',
      '  border-bottom-width: 0 !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none !important;',
      '}',
      // 菜单宿主必须 display:none：它 :host{height:var(--dsh-windows-titlebar-height)} 且没有 overflow:hidden，
      // 光压高度的话菜单项会**溢出着继续显示**（2026-09-26 实测"菜单没消失"就是这原因）。
      'html.dsh-hidetop[data-dsh-topbar-hidden="1"] [' + TOPBAR_ATTR + '="2"] { display: none !important; }',
      // 顶带图标控件（侧栏开关 / 新建会话）按厚度算位置：calc((厚度 - 28px)/2) ⇒ 厚度变 4px 后跑到 -12px，一并收起
      'html.dsh-hidetop[data-dsh-topbar-hidden="1"] [' + TOPBAR_ATTR + '="3"] { display: none !important; }',
      // 收起后内容上移，内容列在顶带里的 16px 圆角会在最顶端留缺口 —— 归零
      'html.dsh-hidetop[data-dsh-topbar-hidden="1"] { --dsh-windows-content-radius: 0px !important; }',
      // 安全区：被 ensureSafeInset() 标出来的那个"落在原生按钮正下方"的面板级容器，给它让出 30px
      'html.dsh-hidetop[data-dsh-topbar-hidden="1"] [' + TOPBAR_ATTR + '="4"] { padding-top: 30px !important; }',
    ].join('\n')

    /** 找「应用/编辑」菜单的宿主：它在 **open shadow root** 里（asar 2238203 实测），
     *  document.querySelectorAll 根本看不见 [role=menubar]，只能顺着 light DOM 的宿主找。 */
    function findMenuHost() {
      try {
        var direct = document.querySelector('[data-windows-menu]')
        if (direct) return direct
        var kids = document.body.children
        for (var i = 0; i < kids.length; i++) {
          var sr = kids[i].shadowRoot
          if (sr && sr.querySelector('[role="menubar"]')) return kids[i]
        }
      } catch (e) { }
      return null
    }

    /** 找会话头：锚在**稳定的名字后缀** `_centerCol` 上（`<hash>_centerCol`，hash 每版变、后缀不变），
     *  只在中心列的前 4 层里挑（不扫整个会话 DOM：既慢又容易误伤）。 */
    function findConvHeader() {
      try {
        var col = document.querySelector('[class*="_centerCol"]')
        if (!col) return null
        var best = null, bestTop = 1e9
        var cur = [col], depth = 0
        while (cur.length && depth < 4) {
          var next = []
          for (var i = 0; i < cur.length; i++) {
            var kids = cur[i].children || []
            for (var j = 0; j < kids.length; j++) {
              next.push(kids[j])
              var r = kids[j].getBoundingClientRect()
              if (r.top < 12 && r.height >= 36 && r.height <= 130 && r.width > 300 && r.top < bestTop) {
                best = kids[j]; bestTop = r.top
              }
            }
          }
          cur = next; depth++
        }
        return best
      } catch (e) { return null }
    }

    /** 给"顶部那两条"打标记（不写死 hash，随版本自适应）
     *  ⚠️ 2026-09-26 第一版用 `[class*="_header"]` 当启发 —— 实测标到了 **whale 小部件的 4 个面板头**
     *  （`_header_1pq26_10`，那是另一套 `name_hash_line` 命名，压根不是会话头）。别再那样找。 */
    function markTopBars() {
      var marked = []
      try {
        var menu = findMenuHost()
        if (menu) {
          menu.setAttribute(TOPBAR_ATTR, '2')
          marked.push('menu-host<' + String(menu.tagName) + '>')
        }
        var hdr = findConvHeader()
        if (hdr) {
          hdr.setAttribute(TOPBAR_ATTR, '1')
          marked.push('header:' + String(hdr.className || '').slice(0, 60) + ' h=' + Math.round(hdr.getBoundingClientRect().height))
        }
        // 顶带里的图标控件（侧栏开关 / 新建会话）：锚在稳定的名字后缀 `_toggle` / `_newSession` 上，
        // 且**只在侧栏列里**找，避免误伤小部件里的同名类
        var caps = document.querySelectorAll('[class*="_sidebarCol"] [class*="_toggle"], [class*="_sidebarCol"] [class*="_newSession"]')
        for (var k = 0; k < caps.length; k++) {
          var cr = caps[k].getBoundingClientRect()
          if (cr.height > 0 && cr.height <= 40) {
            caps[k].setAttribute(TOPBAR_ATTR, '3')
            marked.push('caption:' + String(caps[k].className || '').slice(0, 40) + ' top=' + Math.round(cr.top))
          }
        }
      } catch (e) { }
      return marked
    }

    var topbarInstalled = false

    /**
     * 安全区：原生窗口按钮（最小化/最大化/关闭）折不掉，**只能让内容躲开**。
     * 做法：收起后等一帧布局生效，用 elementFromPoint 取"关闭按钮正下方"那个 DOM 元素，
     * 往上找到**面板级容器**（宽高都 > 150），给它加 `padding-top: 30px`（由上面的 CSS 规则施加）。
     * 2026-09-26 用户实测："右侧面板工具栏和关闭按钮部分重叠，不好点" —— 就是缺这一步。
     */
    function ensureSafeInset() {
      try {
        var prev = document.querySelector('[' + TOPBAR_ATTR + '="4"]')
        if (prev) prev.removeAttribute(TOPBAR_ATTR)     // 先撤掉上一轮的，重新判断
        var de = document.documentElement
        if (!de.classList.contains('dsh-hidetop')) return
        if (de.getAttribute('data-dsh-topbar-hidden') !== '1') return
        var w = window.innerWidth || 1200
        var el = document.elementFromPoint(w - 24, 10)
        var hops = 0
        while (el && hops < 4) {
          var r = el.getBoundingClientRect()
          if (r.width > 150 && r.height > 150) break    // 面板级容器（别给按钮/图标本身加内距）
          el = el.parentElement; hops++
        }
        if (!el) return
        el.setAttribute(TOPBAR_ATTR, '4')
        topbarMarked.push('safe-inset:' + String(el.className || '').slice(0, 40))
      } catch (e) { }
    }

    function setTopbarVisible(on) {
      try {
        var de = document.documentElement
        de.classList.add('dsh-hidetop')
        de.setAttribute('data-dsh-topbar-hidden', on ? '0' : '1')
        setTimeout(ensureSafeInset, 60)               // 等布局生效再量
      } catch (e) { }
    }

    function installTopbar() {
      if (topbarInstalled) return
      topbarInstalled = true
      try {
        // 贴顶 12px 浮现 / 移开 150px 收起（跟外壳版同一组数字）
        document.addEventListener('mousemove', function (e) {
          if (!document.documentElement.classList.contains('dsh-hidetop')) return
          var y = (e && typeof e.clientY === 'number') ? e.clientY : 999
          if (y <= 12) { setTopbarVisible(true); return }
          if (y > 150) { setTopbarVisible(false) }
        }, true)
        document.addEventListener('mouseleave', function () {
          if (document.documentElement.classList.contains('dsh-hidetop')) setTopbarVisible(false)
        })
        setTopbarVisible(false)
      } catch (e) { }
    }

    function uninstallTopbar() {
      try {
        document.documentElement.classList.remove('dsh-hidetop')
        document.documentElement.removeAttribute('data-dsh-topbar-hidden')
        var nodes = document.querySelectorAll('[' + TOPBAR_ATTR + ']')
        for (var i = 0; i < nodes.length; i++) nodes[i].removeAttribute(TOPBAR_ATTR)
      } catch (e) { }
    }

    /** 每次刷新样式时同步顶栏状态（开关 + 重新打标记）
     *  ⚠️ 先把上一轮的标记**全部清掉**再重标：否则第一版误标到 whale 小部件那几个头的
     *  属性会留在 DOM 上，取消勾选也恢复不了（2026-09-26 实测踩到）。 */
    function applyTopbar(state) {
      try {
        var old = document.querySelectorAll('[' + TOPBAR_ATTR + ']')
        for (var i = 0; i < old.length; i++) old[i].removeAttribute(TOPBAR_ATTR)
      } catch (e) { }
      if (!state || !state.hideTopBar) { uninstallTopbar(); return [] }
      var marked = markTopBars()
      installTopbar()
      return marked
    }

    // ---------------------------------------------------------------- 样式注入
    function ensureStyleEl() {
      var el = document.getElementById(STYLE_ID)
      if (!el) {
        el = document.createElement('style')
        el.id = STYLE_ID
        document.head.appendChild(el)   // 追加在最后 ⇒ 排在 DSH 自己的主题样式之后
      }
      return el
    }

    /** 拉服务端生成的 CSS 并贴进页面。返回是否成功。 */
    async function refreshStyle() {
      try {
        var r = await fetch(BASE + '/style.css', { cache: 'no-store' })
        if (!r.ok) return false
        var css = await r.text()
        var st = null
        try { st = await (await fetch(BASE + '/state', { cache: 'no-store' })).json() } catch (e) { }
        var state = st && st.state
        ensureStyleEl().textContent = css + '\n' + compatCss(state) + '\n' + TOPBAR_CSS
        topbarMarked = applyTopbar(state)
        scheduleDiag()
        return true
      } catch (e) {
        return false
      }
    }

    // ---------------------------------------------------------------- 页面侧诊断
    // 把"页面看到的事实"回传给服务端（写到 <外观目录>\diag.json）—— 于是**从服务端就能定位**
    // 样式/资源加载类问题（origin 是什么、style 有没有贴进去、壁纸图能不能加载、哪一层是不透明底），
    // 不必让用户开 DevTools 描述现象。节流 10 秒，任何异常都不许影响界面。
    var lastDiagAt = 0
    function scheduleDiag() {
      var now = Date.now()
      if (now - lastDiagAt < 10000) return
      lastDiagAt = now
      reportDiag()
    }

    function collectDiag(extra) {
      var out = {
        href: String(location.href).slice(0, 240),
        origin: String(location.origin),
        ua: String(navigator.userAgent).slice(0, 120),
        styleElExists: !!document.getElementById(STYLE_ID),
        styleLen: 0,
        styleHasBefore: false,
        styleHasDataUrl: false,
        bodyBgImage: '',
        bodyBgColor: '',
        beforeBgImage: '',
        opaqueChain: [],
        imgTest: '',
        // 2026-09-26 追加：把"浮层是谁"也记下来（用户报"设置面板太透明、不好调"），
        // 下次要精确给某个浮层加不透明底时不用猜选择器。
        bodyChildren: [],
        dialogs: [],
      }
      var el = document.getElementById(STYLE_ID)
      if (el && el.textContent) {
        out.styleLen = el.textContent.length
        out.styleHasBefore = el.textContent.indexOf('body::before') >= 0
        out.styleHasDataUrl = el.textContent.indexOf('data:image/') >= 0
      }
      try { out.bodyBgImage = String(getComputedStyle(document.body).backgroundImage).slice(0, 160) } catch (e) { }
      try { out.bodyBgColor = String(getComputedStyle(document.body).backgroundColor) } catch (e) { }
      try { out.beforeBgImage = String(getComputedStyle(document.body, '::before').backgroundImage).slice(0, 160) } catch (e) { }
      try {
        var node = document.body.firstElementChild, depth = 0
        while (node && depth < 10) {
          var cs = getComputedStyle(node)
          var bg = String(cs.backgroundColor)
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            out.opaqueChain.push(String(node.tagName) + '#' + String(node.id || '') + '.' + String(node.className || '').slice(0, 50) +
              ' bg=' + bg + ' z=' + cs.zIndex + ' pos=' + cs.position)
          }
          node = node.firstElementChild
          depth++
        }
      } catch (e) { }
      try {
        var kids = document.body.children
        for (var i = 0; i < kids.length && i < 12; i++) {
          var kcs = getComputedStyle(kids[i])
          out.bodyChildren.push(String(kids[i].tagName) + '.' + String(kids[i].className || '').slice(0, 60) +
            ' bg=' + String(kcs.backgroundColor) + ' pos=' + kcs.position + ' z=' + kcs.zIndex)
        }
      } catch (e) { }
      try {
        var ds = document.querySelectorAll('[role="dialog"],[aria-modal="true"]')
        for (var j = 0; j < ds.length && j < 6; j++) {
          out.dialogs.push(String(ds[j].tagName) + '.' + String(ds[j].className || '').slice(0, 60) +
            ' bg=' + String(getComputedStyle(ds[j]).backgroundColor))
        }
      } catch (e) { }
      return Object.assign(out, extra || {})
    }

    function testImage(url, cb) {
      try {
        var img = new Image()
        var done = false
        var fin = function (r) { if (!done) { done = true; cb(r) } }
        img.onload = function () { fin('ok ' + img.naturalWidth + 'x' + img.naturalHeight) }
        img.onerror = function () { fin('error') }
        img.src = url
        setTimeout(function () { fin('timeout') }, 5000)
      } catch (e) { cb('exception ' + (e && e.message)) }
    }

    function sendDiag(payload) {
      try {
        fetch(BASE + '/diag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () { })
      } catch (e) { }
    }

    function reportDiag() {
      try {
        api('/state').then(function (j) {
          var st = (j && j.state) || {}
          var url = st.bgImage ? (BASE + '/wallpaper?name=' + encodeURIComponent(st.bgImage)) : ''
          var diag = collectDiag({
            state: { bgImage: st.bgImage, bgDim: st.bgDim, bgBlur: st.bgBlur, surfaceAlpha: st.surfaceAlpha, bgFit: st.bgFit, hideTopBar: !!st.hideTopBar },
            topbarMarked: topbarMarked,
            cssHead: String((document.getElementById(STYLE_ID) || {}).textContent || '').slice(0, 200),
          })
          if (!url) { sendDiag(diag); return }
          testImage(url, function (res) { diag.imgTest = res; sendDiag(diag) })
        }).catch(function () { })
      } catch (e) { }
    }

    /** 首屏可能早于宿主路由注册完成 —— 退避重试几次。 */
    function refreshStyleWithRetry(times) {
      var n = 0
      var tick = function () {
        refreshStyle().then(function (ok) {
          if (!ok && n < (times || 5)) { n++; setTimeout(tick, 1500) }
        })
      }
      tick()
    }

    function api(path, body) {
      return fetch(BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      }).then(function (r) { return r.json() })
    }

    // ---------------------------------------------------------------- 小工具
    /** 扫页面上全部 class 名并按出现次数排序（原外壳版在主进程做，这里在页面里做更直接） */
    function scanClasses(limit) {
      var counts = {}
      var all = document.querySelectorAll('*')
      for (var i = 0; i < all.length; i++) {
        var list = all[i].classList
        for (var j = 0; j < list.length; j++) {
          var c = list[j]
          if (!c || c.length > 80) continue
          counts[c] = (counts[c] || 0) + 1
        }
      }
      return Object.keys(counts)
        .map(function (c) { return { cls: c, n: counts[c] } })
        .sort(function (a, b) { return b.n - a.n })
        .slice(0, limit || 400)
    }

    function pickFile(accept) {
      return new Promise(function (resolve) {
        var inp = document.createElement('input')
        inp.type = 'file'
        inp.accept = accept
        inp.style.display = 'none'
        inp.onchange = function () {
          var f = inp.files && inp.files[0]
          if (!f) { resolve(null); return }
          var fr = new FileReader()
          fr.onload = function () { resolve({ file: f, dataUrl: String(fr.result || '') }) }
          fr.onerror = function () { resolve(null) }
          fr.readAsDataURL(f)
        }
        document.body.appendChild(inp)
        inp.click()
        setTimeout(function () { try { inp.remove() } catch (e) { } }, 60000)
      })
    }

    /** 大图先用 canvas 缩到 ≤2560px（照外壳版 nativeImage 的那条口径；GIF 保持原样以留住动画） */
    function maybeDownscale(picked, maxSide) {
      var m = /^data:([^;,]+);base64,(.*)$/.exec(picked.dataUrl || '')
      if (!m) return Promise.resolve(null)
      var mime = m[1]
      var nameLower = (picked.file.name || '').toLowerCase()
      if (mime === 'image/gif' || /\.gif$/.test(nameLower)) return Promise.resolve({ mime: mime, data: m[2] })
      return new Promise(function (resolve) {
        var img = new Image()
        img.onload = function () {
          var w = img.naturalWidth, hh = img.naturalHeight
          var side = Math.max(w, hh)
          if (side <= maxSide) { resolve({ mime: mime, data: m[2] }); return }
          var k = maxSide / side
          var cv = document.createElement('canvas')
          cv.width = Math.round(w * k); cv.height = Math.round(hh * k)
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
          var outMime = (mime === 'image/jpeg') ? 'image/jpeg' : 'image/png'
          var url = cv.toDataURL(outMime, 0.9)
          var m2 = /^data:([^;,]+);base64,(.*)$/.exec(url)
          resolve(m2 ? { mime: m2[1], data: m2[2], resized: side + '->' + maxSide } : { mime: mime, data: m[2] })
        }
        img.onerror = function () { resolve({ mime: mime, data: m[2] }) }
        img.src = picked.dataUrl
      })
    }

    // ---------------------------------------------------------------- 面板样式
    var C = {
      card: { border: '1px solid var(--dsw-alias-border-l2, #33363d)', borderRadius: 10, padding: '14px 16px', marginBottom: 14 },
      h2: { fontSize: 14, fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
      label: { fontSize: 12, opacity: 0.8, minWidth: 92 },
      mono: { fontFamily: 'Consolas, Cascadia Mono, monospace', fontSize: 11 },
      btn: { fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2, #3a3d45)', background: 'transparent', color: 'inherit' },
      btnPrimary: { fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid transparent', background: 'var(--dsw-alias-brand-primary, #4d6bfe)', color: '#fff' },
      btnDanger: { fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid #a33', background: 'transparent', color: '#e88' },
      sw: { width: 30, height: 22, borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2, #3a3d45)', cursor: 'pointer', padding: 0 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))', gap: 6, marginBottom: 8 },
      thumb: { width: 96, height: 60, objectFit: 'cover', borderRadius: 6, cursor: 'pointer', border: '2px solid transparent' },
      thumbOn: { border: '2px solid var(--dsw-alias-brand-primary, #4d6bfe)' },
      hint: { fontSize: 11, opacity: 0.65, lineHeight: 1.6 },
      msg: { fontSize: 12, padding: '8px 10px', borderRadius: 6, marginTop: 6 },
      ok: { background: 'rgba(40,160,90,.14)', border: '1px solid rgba(40,160,90,.5)' },
      bad: { background: 'rgba(200,60,60,.14)', border: '1px solid rgba(200,60,60,.5)' },
      cls: { fontSize: 11, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2, #3a3d45)', cursor: 'pointer', background: 'transparent', color: 'inherit' },
    }

    // ---------------------------------------------------------------- 面板
    function AppearancePanel() {
      var [data, setData] = useState(null)
      var [draft, setDraft] = useState(null)
      var [busy, setBusy] = useState('')
      var [msg, setMsg] = useState('')
      var [classes, setClasses] = useState(null)
      var [ruleCls, setRuleCls] = useState('')
      var [ruleProp, setRuleProp] = useState('background-color')
      var [ruleVal, setRuleVal] = useState('')

      function load() {
        api('/state').then(function (r) {
          if (!r || !r.ok) { setMsg('✗ 读取外观配置失败：' + ((r && r.error) || '未知错误')); return }
          setData(r)
          setDraft(JSON.parse(JSON.stringify(r.state || r.defaults)))
        }).catch(function (e) { setMsg('✗ 读取失败：' + e.message) })
      }
      useEffect(function () { load() }, [])

      // ---- 改动即时生效（照外壳版外观编辑器的行为：改一下就应用，不用手动保存）----
      // ⚠️ 2026-09-26：第一版只在点「保存并应用」时才写服务端 —— 用户改完颜色没反应，
      //    直接得出"这功能没用"的结论（外壳版是热生效的，预期就是这么来的）。
      //    现在每次改动 450ms 后自动保存 + 重新注入样式；按钮仍保留（它还会做一次服务端归一化）。
      var firstRun = useRef(true)
      var autoTimer = useRef(null)
      function autoSave() {
        api('/state/save', { state: draft }).then(function (r) {
          if (!r || !r.ok) { setMsg('✗ 自动保存失败：' + ((r && r.error) || '未知错误') + ' —— 这次改动没有生效'); return }
          refreshStyle().then(function (ok) { setMsg(ok ? '✓ 已应用（自动保存）' : '✗ 已保存，但样式注入失败（看控制台）') })
        }).catch(function (e) { setMsg('✗ 自动保存异常：' + e.message) })
      }
      useEffect(function () {
        if (!draft) { return }                                       // 还没载入完，别写盘
        if (firstRun.current) { firstRun.current = false; return }   // 首次载入不写盘
        if (autoTimer.current) { clearTimeout(autoTimer.current) }
        autoTimer.current = setTimeout(autoSave, 450)
        return function () { if (autoTimer.current) { clearTimeout(autoTimer.current) } }
      }, [draft])

      if (!data || !draft) return h('div', { style: { maxWidth: 820 } }, '载入外观配置…')

      function set(k, v) { var d = Object.assign({}, draft); d[k] = v; setDraft(d) }
      function setToken(tk, v) { var d = Object.assign({}, draft); d.tokens = Object.assign({}, d.tokens); if (v) d.tokens[tk] = v; else delete d.tokens[tk]; setDraft(d) }

      function save() {
        setBusy('save')
        api('/state/save', { state: draft }).then(function (r) {
          setBusy('')
          if (!r || !r.ok) { setMsg('✗ 保存失败：' + ((r && r.error) || '')); return }
          setDraft(JSON.parse(JSON.stringify(r.state)))
          refreshStyle().then(function (ok) {
            setMsg(ok ? '✓ 已保存并应用' : '✓ 已保存，但样式注入失败（看控制台）')
          })
        }).catch(function (e) { setBusy(''); setMsg('✗ 保存异常：' + e.message) })
      }

      function reset() {
        if (busy) return
        setBusy('reset')
        api('/state/reset', {}).then(function (r) {
          setBusy('')
          if (!r || !r.ok) { setMsg('✗ 恢复默认失败'); return }
          setDraft(JSON.parse(JSON.stringify(r.state)))
          refreshStyle().then(function () { setMsg('✓ 已恢复默认') })
        })
      }

      function uploadWallpaper() {
        pickFile('image/*').then(function (picked) {
          if (!picked) return null
          setBusy('wall')
          return maybeDownscale(picked, 2560).then(function (shrunk) {
            if (!shrunk) { setBusy(''); setMsg('✗ 读不出图片数据'); return null }
            return api('/wallpaper/add', { name: picked.file.name, data: shrunk.data }).then(function (r) {
              setBusy('')
              if (!r || !r.ok) { setMsg('✗ 上传失败：' + ((r && r.error) || '')); return null }
              setMsg('✓ 已导入壁纸 ' + r.name + (shrunk.resized ? '（已缩到 ' + shrunk.resized + '）' : ''))
              setData(function (d) { return Object.assign({}, d, { wallpapers: r.wallpapers }) })
              setDraft(JSON.parse(JSON.stringify(r.state)))
              return refreshStyle()
            })
          })
        }).catch(function (e) { setBusy(''); setMsg('✗ 上传异常：' + e.message) })
      }

      function deleteWallpaper(nm) {
        api('/wallpaper/delete', { name: nm }).then(function (r) {
          if (!r || !r.ok) { setMsg('✗ 删除失败'); return }
          setData(function (d) { return Object.assign({}, d, { wallpapers: r.wallpapers }) })
          setDraft(JSON.parse(JSON.stringify(r.state)))
          refreshStyle().then(function () { setMsg('✓ 已删除 ' + nm) })
        })
      }

      function addRule() {
        if (!ruleCls || !ruleVal) { setMsg('✗ 类名和取值都要填'); return }
        var d = Object.assign({}, draft)
        d.rules = (d.rules || []).concat([{ cls: ruleCls, prop: ruleProp, value: ruleVal }])
        setDraft(d)
        setMsg('规则已加入草稿，点「保存并应用」生效')
      }

      // ---- 卡片 1：背景 ----
      var presets = (data.presets || []).map(function (c) {
        return h('button', { key: c, title: c, style: Object.assign({}, C.sw, { background: c }), onClick: function () { set('bgSolid', c) } })
      })
      var walls = (data.wallpapers || []).map(function (w) {
        var on = draft.bgImage === w.name
        return h('div', { key: w.name, style: { display: 'inline-block', marginRight: 8, textAlign: 'center' } }, [
          h('img', {
            key: 'img', src: BASE + '/wallpaper?name=' + encodeURIComponent(w.name), title: w.name + '（' + Math.round((w.bytes || 0) / 1024) + ' KB）',
            style: Object.assign({}, C.thumb, on ? C.thumbOn : {}),
            onClick: function () { set('bgImage', w.name) },
          }),
          h('div', { key: 'nm', style: Object.assign({}, C.mono, { maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, w.name),
          h('button', { key: 'del', style: C.btnDanger, onClick: function () { deleteWallpaper(w.name) } }, '删除'),
        ])
      })

      var card1 = h('div', { key: 'bg', style: C.card }, [
        h('h2', { key: 't' }, '🖼 背景'),
        h('div', { key: 'p', style: C.row }, [h('span', { style: C.label }, '纯色预设'), h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, presets)]),
        h('div', { key: 'cs', style: C.row }, [
          h('span', { style: C.label }, '自定义色'),
          h('input', { type: 'color', value: draft.bgSolid || '#16181a', onChange: function (e) { set('bgSolid', e.target.value) }, style: { width: 44, height: 24 } }),
          h('input', { type: 'text', value: draft.bgSolid || '', placeholder: '#rrggbb 或 rgba(...)', onChange: function (e) { set('bgSolid', e.target.value) }, style: { width: 200, fontSize: 12 } }),
          h('button', { style: C.btn, onClick: function () { set('bgSolid', '') } }, '清除纯色'),
        ]),
        h('div', { key: 'wp', style: C.row }, [
          h('span', { style: C.label }, '壁纸'),
          h('button', { style: C.btn, disabled: busy === 'wall', onClick: uploadWallpaper }, busy === 'wall' ? '导入中…' : '＋ 选择本地图片'),
          h('button', { style: C.btn, onClick: function () { set('bgImage', '') } }, '清除壁纸'),
        ]),
        walls.length ? h('div', { key: 'gal', style: { margin: '6px 0 10px' } }, walls)
                     : h('div', { key: 'nogal', style: C.hint }, '还没有导入过壁纸。支持 PNG / JPEG / GIF（会动）/ WebP / BMP；大图会先缩到 2560px。'),
        h('div', { key: 'fit', style: C.row }, [
          h('span', { style: C.label }, '铺法'),
          h('select', { value: draft.bgFit, onChange: function (e) { set('bgFit', e.target.value) }, style: { fontSize: 12 } },
            ['cover', 'contain', 'repeat'].map(function (v) { return h('option', { key: v, value: v }, v) })),
          h('span', { style: C.label }, '调暗 ' + draft.bgDim + '%'),
          h('input', { type: 'range', min: 0, max: 80, value: draft.bgDim, onChange: function (e) { set('bgDim', Number(e.target.value)) } }),
          h('span', { style: C.label }, '模糊 ' + draft.bgBlur + 'px'),
          h('input', { type: 'range', min: 0, max: 20, value: draft.bgBlur, onChange: function (e) { set('bgBlur', Number(e.target.value)) } }),
        ]),
        // 2026-09-26：用户设了 调暗 80% + 模糊 16px 后在问"为什么壁纸没变化" ——
        // 那组值等于 brightness(0.20)，任何壁纸都几乎全黑。把"很暗"直接写在界面上，别让人猜。
        (draft.bgDim > 40 || draft.bgBlur > 8)
          ? h('div', { key: 'warn', style: Object.assign({}, C.hint, { color: '#e8a04a' }) },
              '⚠ 当前很"糊"：亮度 ×' + (1 - draft.bgDim / 100).toFixed(2) +
              (draft.bgBlur > 0 ? ' + 模糊 ' + draft.bgBlur + 'px' : '') +
              ' —— 这个组合下壁纸几乎看不见。想看效果先把「调暗」和「模糊」都拉到 0。')
          : null,
        h('div', { key: 'topbar', style: C.row }, [
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } }, [
            h('input', {
              type: 'checkbox', checked: !!draft.hideTopBar,
              onChange: function (e) { set('hideTopBar', !!e.target.checked) },
            }),
            '顶栏自动隐藏（鼠标贴到窗口顶部 12px 浮现、移开 150px 收起）',
          ]),
          h('span', { style: C.hint }, '收起时顶部保留 4px 拖拽区；原生窗口按钮（最小化/关闭）不参与'),
        ]),
        h('div', { key: 'sa', style: C.row }, [
          h('span', { style: C.label }, '面板不透明度 ' + draft.surfaceAlpha),
          h('input', { type: 'range', min: 30, max: 100, value: Math.round(draft.surfaceAlpha * 100), onChange: function (e) { set('surfaceAlpha', Number(e.target.value) / 100) } }),
          h('span', { style: C.hint }, '有壁纸时正文面板的底色透明度（越小越透出壁纸）；浮层/面板固定 ≥0.85 保证可读'),
        ]),
      ])

      // ---- 卡片 2：颜色变量 ----
      var tokenRows = (data.tokens || []).map(function (pair) {
        var tk = pair[0], label = pair[1]
        var cur = (draft.tokens || {})[tk] || ''
        return h('div', { key: tk, style: C.row }, [
          h('span', { style: Object.assign({}, C.label, { minWidth: 92 }) }, label),
          h('span', { style: Object.assign({}, C.mono, { flex: '1 1 260px', opacity: 0.7 }) }, tk),
          h('input', { type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(cur) ? cur : '#888888', onChange: function (e) { setToken(tk, e.target.value) }, style: { width: 40, height: 22 } }),
          h('input', { type: 'text', value: cur, placeholder: '（未设置）', onChange: function (e) { setToken(tk, e.target.value) }, style: { width: 150, fontSize: 12 } }),
          h('button', { style: C.btn, onClick: function () { setToken(tk, '') } }, '清除'),
        ])
      })
      var card2 = h('div', { key: 'tk', style: C.card }, [
        h('h2', { key: 't' }, '🎨 颜色变量（' + (data.tokens || []).length + ' 个）'),
        h('div', { key: 'h', style: C.hint }, '侧栏/菜单/输入框走的是 --dsw-specific-*，只改 alias 它们不会动 —— 所以我单独列出来了。'),
        h('div', { key: 'rows', style: { marginTop: 8 } }, tokenRows),
      ])

      // ---- 卡片 3：自定义规则 ----
      var clsList = (classes || []).slice(0, 60).map(function (c) {
        return h('button', { key: c.cls, style: C.cls, title: c.cls + ' ×' + c.n, onClick: function () { setRuleCls(c.cls) } },
          c.cls.length > 26 ? c.cls.slice(0, 26) + '…' : c.cls)
      })
      var ruleRows = (draft.rules || []).map(function (r, i) {
        return h('div', { key: i, style: C.row }, [
          h('span', { style: Object.assign({}, C.mono, { flex: 1 }) }, '[class*="' + r.cls + '"] { ' + r.prop + ': ' + r.value + ' }'),
          h('button', {
            style: C.btnDanger, onClick: function () {
              var d = Object.assign({}, draft); d.rules = d.rules.filter(function (_, j) { return j !== i }); setDraft(d)
            },
          }, '删除'),
        ])
      })
      var card3 = h('div', { key: 'rule', style: C.card }, [
        h('h2', { key: 't' }, '🧩 自定义规则（不写 CSS 也能改界面）'),
        h('div', { key: 'h', style: C.hint }, '先「读取页面类名」拿到当前界面的真实类名（DSH 的类名是 CSS Modules，哈希会随版本变），选中后选属性填值。'),
        h('div', { key: 'r1', style: C.row }, [
          h('button', { style: C.btn, onClick: function () { setClasses(scanClasses(400)); setMsg('✓ 已扫描页面类名（取出现次数最多的 60 个显示）') } }, '读取页面类名'),
          h('span', { style: C.hint }, classes ? '共 ' + classes.length + ' 个' : '（未扫描）'),
        ]),
        clsList.length ? h('div', { key: 'cl', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } }, clsList) : null,
        h('div', { key: 'r2', style: C.row }, [
          h('input', { type: 'text', value: ruleCls, placeholder: '类名（可点上面的按钮选）', onChange: function (e) { setRuleCls(e.target.value) }, style: { width: 220, fontSize: 12 } }),
          h('select', { value: ruleProp, onChange: function (e) { setRuleProp(e.target.value) }, style: { fontSize: 12 } },
            (data.ruleProps || []).map(function (p) { return h('option', { key: p, value: p }, p) })),
          h('input', { type: 'text', value: ruleVal, placeholder: '取值，如 #1c1f26 / 8px', onChange: function (e) { setRuleVal(e.target.value) }, style: { width: 160, fontSize: 12 } }),
          h('button', { style: C.btn, onClick: addRule }, '添加规则'),
        ]),
        ruleRows.length ? h('div', { key: 'rl' }, ruleRows) : h('div', { key: 'nrl', style: C.hint }, '还没有自定义规则（上限 200 条，属性与取值都过白名单）'),
      ])

      var msgStyle = Object.assign({}, C.msg, msg.indexOf('✓') === 0 ? C.ok : (msg.indexOf('✗') === 0 ? C.bad : {}))
      return h('div', { style: { maxWidth: 820 } }, [
        card1, card2, card3,
        h('div', { key: 'act', style: C.row }, [
          h('button', { style: C.btnPrimary, disabled: !!busy, onClick: save }, busy === 'save' ? '保存中…' : '保存并应用'),
          h('button', { style: C.btn, disabled: !!busy, onClick: function () { load() } }, '放弃改动 / 重新读取'),
          h('button', { style: C.btnDanger, disabled: !!busy, onClick: reset }, '恢复默认'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h('span', { key: 'dir', style: C.hint }, '配置文件：' + (data.dir || '') + '\\appearance.json'),
        ]),
        msg ? h('div', { key: 'msg', style: msgStyle }, msg) : null,
        h('div', { key: 'note', style: C.hint },
          '说明：**改动约 0.5 秒后自动应用**（不用手动保存；「保存并应用」只是再做一次归一化）。' +
          '原外壳版的「顶栏自动隐藏」与无边框标题栏依赖外壳主进程，官方端没有对应能力，故未移植。'),
      ])
    }

    // ---------------------------------------------------------------- 注册
    function apply(ctx) {
      // ① 先把样式贴上（不打开面板也要生效）
      refreshStyleWithRetry(6)

      // ② 设置页 → 插件 → 外观
      ctx.slots.inject('settings.plugins.tab', function () {
        return ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'appearance',
          order: 30,
          label: function () { return '外观' },
          inject: function () { return {} },
        }, AppearancePanel)
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    // 供自检脚本直接调用（浏览器里没用，但不影响）
    exports._internals = { refreshStyle: refreshStyle, scanClasses: scanClasses }
    return module.exports
  },
})
