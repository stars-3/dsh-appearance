/**
 * appearance-core —— 外观编辑器的纯逻辑核心（无 Electron、无 DOM、无 IO）
 *
 * 逐字移植自自制外壳 `DSH-Desktop\shell-app\main.js`：
 *   appearanceDefaults / isColor / validateAppearance / buildAppearanceCss
 *   + APPEARANCE_TOKENS（18 个 token）/ APPEARANCE_RULE_PROPS（8 条属性白名单）
 *
 * 与外壳版的差别（迁移到官方桌面端时**故意**去掉的部分）：
 *   · `hideTopBar` 不移植 —— 它靠外壳主进程 `screen.getCursorScreenPoint()` 每 100ms
 *     判断鼠标是否贴到屏幕顶，还要配合 `-webkit-app-region:drag` 的自绘条带；
 *     官方端是它自己的窗口，浏览器侧的客户端插件做不到（见迁移文档 §9.5）。
 *   · 壁纸不再转 data URL —— 现在由宿主路由 `/dsh-appearance/wallpaper/<name>` 直接
 *     用 http 提供（Chromium 不允许 http 页面加载 file:// 子资源，但同源 http 没问题），
 *     省掉几百 KB 的 base64 与 nativeImage 编码。
 *   · 纯色背景同样写进 `--dsw-alias-bg-base` / `--dsw-specific-sidebar-fill`（原逻辑保留：
 *     只画 html/body 会被 DSH 自己的容器盖住）。
 *
 * 单一事实来源：**只有这里**生成 CSS 与做校验；客户端插件只负责把
 * `GET /dsh-appearance/style.css` 的内容贴进 <style>，服务端也只调用这里。
 */

/** 18 个常用变量（[token, 中文名]）—— 与外壳版一字不差 */
export const APPEARANCE_TOKENS = [
    ['--dsw-alias-bg-base', '主背景'], ['--dsw-alias-bg-layer-1', '浮层背景 1'],
    ['--dsw-alias-bg-layer-2', '浮层背景 2'], ['--dsw-alias-bg-layer-3', '浮层背景 3'],
    ['--dsw-alias-label-primary', '主文字'], ['--dsw-alias-label-secondary', '次文字'],
    ['--dsw-alias-label-tertiary', '弱文字'], ['--dsw-alias-border-l1', '描边 1'],
    ['--dsw-alias-border-l2', '描边 2'], ['--dsw-alias-brand-primary', '品牌色'],
    ['--dsw-alias-link', '链接色'], ['--dsw-alias-markdown-code-block', '代码块底'],
    ['--dsw-alias-markdown-inline-code', '行内代码底'], ['--dsw-alias-interactive-bg-hover', '悬停底色'],
    // DSH 有一类 "specific" 变量：侧栏/菜单/输入框的底色不走 alias，必须单独列
    // （实测：只改 alias 时侧栏纹丝不动，它用的是 --dsw-specific-sidebar-fill）
    ['--dsw-specific-sidebar-fill', '侧栏底色'], ['--dsw-specific-menu', '菜单底色'],
    ['--dsw-specific-input-major', '输入框底色'], ['--dsw-specific-bubble', '气泡底色'],
]

/** 自定义规则允许的属性白名单（键 = CSS 属性，值 = 取值正则）—— 一字不差 */
export const APPEARANCE_RULE_PROPS = {
    'background-color': /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/,
    'color': /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/,
    'border-color': /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/,
    'border-radius': /^\d{1,3}(px|%)$/,
    'padding': /^\d{1,3}(px|em|rem)(\s+\d{1,3}(px|em|rem)){0,3}$/,
    'font-size': /^\d{1,3}(px|em|rem|%)$/,
    'line-height': /^\d(\.\d{1,2})?$/,
    'opacity': /^(0(\.\d{1,2})?|1(\.0{1,2})?)$/,
}

export const RULE_LIMIT = 200
export const PRESET_COLORS = [
    '#0f1115', '#16181a', '#1c1f26', '#20242c', '#232a35', '#2b2f3a',
    '#f5f6f8', '#ffffff', '#eef1f5', '#e8eaed', '#1f2937', '#0b1220',
]

export function appearanceDefaults() {
    return {
        bgSolid: '', bgImage: '', bgFit: 'cover', bgDim: 0, bgBlur: 0,
        surfaceAlpha: 0.9, tokens: {}, rules: [],
    }
}

export function isColor(v) {
    return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/.test(String(v || ''))
}

/**
 * 校验并归一化一份外观配置。
 * @param {object} s 原始状态
 * @param {(name:string)=>boolean} [wallpaperExists] 判断壁纸文件是否存在（服务端传真实检查；
 *        纯逻辑测试可传 () => true）
 */
export function validateState(s, wallpaperExists) {
    const out = Object.assign(appearanceDefaults(), s || {})
    if (out.bgSolid && !isColor(out.bgSolid)) out.bgSolid = ''
    if (['cover', 'contain', 'repeat'].indexOf(out.bgFit) < 0) out.bgFit = 'cover'
    out.bgDim = Math.max(0, Math.min(80, Number(out.bgDim) || 0))
    out.bgBlur = Math.max(0, Math.min(20, Number(out.bgBlur) || 0))
    out.surfaceAlpha = Math.max(0.3, Math.min(1, Number(out.surfaceAlpha) || 0.9))

    // 壁纸名只允许纯文件名（不许路径分隔符/上跳），且必须真的存在
    if (out.bgImage) {
        const nm = String(out.bgImage)
        if (nm !== safeName(nm) || (wallpaperExists && !wallpaperExists(nm))) out.bgImage = ''
    }

    const tk = {}
    for (const pair of APPEARANCE_TOKENS) {
        if (isColor(out.tokens && out.tokens[pair[0]])) tk[pair[0]] = out.tokens[pair[0]]
    }
    out.tokens = tk

    out.rules = (Array.isArray(out.rules) ? out.rules : []).filter((r) =>
        r && typeof r.cls === 'string' &&
        /^[A-Za-z0-9_\-. ]{1,80}$/.test(r.cls) &&
        APPEARANCE_RULE_PROPS[r.prop] &&
        APPEARANCE_RULE_PROPS[r.prop].test(String(r.value || ''))
    ).slice(0, RULE_LIMIT).map((r) => ({ cls: r.cls, prop: r.prop, value: String(r.value) }))
    return out
}

/** 只保留安全文件名（防 `..` / 路径穿越） */
export function safeName(n) {
    return String(n || '').replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 120)
}

/**
 * 生成要注入页面的 CSS。
 * @param {object} state 外观状态（会先过 validateState）
 * @param {{wallpaperUrl?:(name:string)=>string, wallpaperExists?:(name:string)=>boolean}} [opts]
 */
export function buildCss(state, opts = {}) {
    const wpUrl = opts.wallpaperUrl || ((n) => '/dsh-appearance/wallpaper/' + encodeURIComponent(n))
    const a = validateState(state, opts.wallpaperExists)
    const lines = ['/* DSH 外观编辑器（客户端插件 dsh-appearance）生成 */']
    const url = a.bgImage ? wpUrl(a.bgImage) : ''
    const tk = Object.assign({}, a.tokens)          // 显式设置的 token（纯色背景要往里补默认项）

    if (a.bgSolid && !url) {
        // html/body 会被 DSH 自己的容器盖住，光画 html/body 看不见 ⇒ 同时写进"背景 token"
        lines.push('html, body { background: ' + a.bgSolid + ' !important; }')
        if (!tk['--dsw-alias-bg-base']) tk['--dsw-alias-bg-base'] = a.bgSolid
        if (!tk['--dsw-specific-sidebar-fill']) tk['--dsw-specific-sidebar-fill'] = a.bgSolid
    }
    if (url) {
        const size = a.bgFit === 'repeat' ? 'auto' : a.bgFit
        const repeat = a.bgFit === 'repeat' ? 'repeat' : 'no-repeat'
        const filters = []
        if (a.bgBlur > 0) filters.push('blur(' + a.bgBlur + 'px)')
        if (a.bgDim > 0) filters.push('brightness(' + (1 - a.bgDim / 100).toFixed(2) + ')')
        lines.push('html, body { background: transparent !important; }')
        lines.push('body::before { content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;' +
            ' background-image: url(' + url + '); background-size: ' + size + '; background-position: center;' +
            ' background-repeat: ' + repeat + ';' + (filters.length ? ' filter: ' + filters.join(' ') + ';' : '') + ' }')
        const keys = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
            '--dsw-alias-bg-layer-3', '--dsw-specific-sidebar-fill']
        const A = a.surfaceAlpha
        // ⚠️ 2026-09-26 真机实测（页面回传的 diag.json）：官方端**三层嵌套容器都读同一个 token**
        //    （DIV.ZTP-Xa_frame / DIV.ZTP-Xa_sidebarCol / DIV.n_2Q3W_root 全被染成 rgba(21,21,23,A)）。
        //    半透明是**相乘**的：A=0.41 叠三层 = 1-(1-0.41)^3 ≈ 0.80 不透明 ⇒ 壁纸被压得看不见。
        //  ❌ 别用"把最外两层压成 transparent"那种**结构选择器**修：实测 `body > div > div`
        //     连**设置面板**一起命中，面板背景被清掉（用户报"怎么面板变透明了"）。只动数值最安全。
        //  ✅ 数值补偿：把"会被叠多层"的两个 token 反解成 A' = 1-(1-A)^(1/N)，让 N 层合成后 ≈ 用户设定值；
        //     layer-1/2/3 给浮层/卡片/菜单用（一般不叠），保持原值，免得把它们弄得太透。
        const N = 3
        const Acomp = Math.round((1 - Math.pow(1 - A, 1 / N)) * 1000) / 1000
        const stacked = ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill']
        const layered = ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3']
        // ⚠️ 2026-09-26 用户第二次反馈："这个设置面板能别这么透明嘛，不好调整" ——
        //    浮层/卡片用的 layer-* 原来也跟随滑块 ⇒ **设置面板自己的底也被染透**，没法看。
        //    处置：layer-* 给一个 **0.85 的不透明下限**（浮层保持可读），主内容区（上面两个）才跟随滑块。
        const Alayer = Math.max(A, 0.85)
        lines.push('body:not([data-ds-dark-theme]) { ' +
            stacked.map((k) => k + ': rgba(255,255,255,' + Acomp + ') !important').join('; ') + '; ' +
            layered.map((k) => k + ': rgba(255,255,255,' + Alayer + ') !important').join('; ') + '; }')
        lines.push('body[data-ds-dark-theme] { ' +
            stacked.map((k) => k + ': rgba(21,21,23,' + Acomp + ') !important').join('; ') + '; ' +
            layered.map((k) => k + ': rgba(21,21,23,' + Alayer + ') !important').join('; ') + '; }')
    }
    // token 覆盖必须带 !important：DSH 自己的主题样式注入得**比我们晚**，不带就被它盖掉
    // （2026-09-12 外壳实测：不带 !important 完全不生效，带上立刻生效）
    const tkKeys = Object.keys(tk)
    const SEL = ':root, body, body[data-ds-dark-theme], body:not([data-ds-dark-theme])'
    if (tkKeys.length) {
        lines.push(SEL + ' { ' + tkKeys.map((k) => k + ': ' + tk[k] + ' !important').join('; ') + '; }')
    }
    for (const r of a.rules) {
        lines.push('[class*="' + r.cls + '"] { ' + r.prop + ': ' + r.value + ' !important; }')
    }
    return lines.join('\n')
}
