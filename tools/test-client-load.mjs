/**
 * test-client-load.mjs —— 客户端插件自检
 *
 * 验四件事（都来自真机踩过的坑）：
 *   ① bundle 形状对（window.__ModuleLoader__.load({id, factory})）
 *   ② `exports.inject` 里是 **Cordis 服务名**（'slots'），**不是包名** —— 账本 E07：
 *      写包名 → 客户端等一个永远不存在的服务 → 加载失败 → **界面白屏**，服务端零报错
 *   ③ package.json 的 `dsh.client.inject` 才是包名
 *   ④ 真渲染一遍面板：注册的 Tab spec 正确、渲染输出含关键文案
 *   ⑤ apply() 会把服务端 CSS 贴进 <style>
 *
 * 用法： node tools\test-client-load.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

let fails = 0
const results = []
function check(what, ok, detail) {
    results.push((ok ? '  OK   ' : '  FAIL ') + what + (detail ? '  → ' + detail : ''))
    if (!ok) fails++
}

// ---------------------------------------------------------------- 浏览器环境桩
const styleEls = []
const fakeDoc = {
    getElementById: (id) => styleEls.find((e) => e.id === id) || null,
    createElement: (tag) => ({ tag, id: '', textContent: '', style: {}, appendChild() { }, remove() { }, setAttribute() { }, getAttribute() { return null } }),
    head: { appendChild: (el) => { styleEls.push(el) } },
    body: { appendChild() { }, children: [] },
    querySelectorAll: () => [],
    // 顶栏自动隐藏那套代码要用的最小桩
    documentElement: {
        classList: { _s: {}, add(c) { this._s[c] = 1 }, remove(c) { delete this._s[c] }, contains(c) { return !!this._s[c] } },
        setAttribute() { }, removeAttribute() { }, getAttribute() { return null },
    },
    addEventListener() { },
}
globalThis.document = fakeDoc
globalThis.location = { href: 'dsh-app://app/index.html', origin: 'dsh-app://app' }
// 注意：Node 24 的 globalThis.navigator 是只读 getter，不能直接赋值（用它自带的即可）
globalThis.getComputedStyle = () => ({ backgroundImage: 'none', backgroundColor: 'rgba(0, 0, 0, 0)', zIndex: 'auto', position: 'static' })
globalThis.Image = class { set src(v) { this._src = v; setTimeout(() => { if (this.onload) this.onload() }, 0) } get naturalWidth() { return 4 } get naturalHeight() { return 3 } }
const fetched = []
const fetchBodies = []
globalThis.fetch = async (url, opts) => {
    fetched.push(String(url))
    if (opts && opts.body) fetchBodies.push(String(opts.body))
    return {
        ok: true,
        text: async () => '/* CSS-FROM-SERVER */',
        json: async () => ({ ok: true, state: { bgImage: 'a.png', bgDim: 0, bgBlur: 0, surfaceAlpha: 0.9, bgFit: 'cover' } }),
    }
}

// React 桩：useState 从队列取初始值（面板里有 8 个 useState，顺序固定），useEffect 空转
const hookQueue = []
function makeReact() {
    let i = 0
    return {
        createElement: (type, props, ...kids) => ({
            type, props: props || {},
            kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false),
        }),
        useState: (init) => { const v = i < hookQueue.length ? hookQueue[i] : init; i++; return [v, () => { }] },
        useRef: (init) => ({ current: init }),
        useEffect: () => { },
    }
}
const reactStub = makeReact()

let captured = null
globalThis.window = { __ModuleLoader__: { load: (b) => { captured = b } } }

// ---------------------------------------------------------------- 加载客户端文件
await import('../client/client.js')
check('调用了 __ModuleLoader__.load', !!captured)
// 契约（账本 E80）：客户端 bundle **自报的 id 必须等于包名**。官方端按包名把它注册进客户端图，
// 加载后断言「这个 id 注册过」，不一致就抛 `loaded without registering "<pkg>"` →
// 面板不挂载、CSS 注入失效（服务端一切正常，只有界面看得出来）。2026-09-26 真机翻过车。
check('bundle id == 包名', captured && captured.id === pkgName, (captured && captured.id) + ' vs 包名 ' + pkgName)
check('factory 是函数', captured && typeof captured.factory === 'function')

const requireStub = (n) => {
    if (n === 'react') return reactStub
    throw new Error('unexpected require: ' + n)
}
const exportsObj = captured.factory(requireStub)
check('exports.name 正确', exportsObj.name === 'dsh-appearance', exportsObj.name)
check('exports.inject = [slots]（服务名）', Array.isArray(exportsObj.inject) && exportsObj.inject.length === 1 && exportsObj.inject[0] === 'slots',
    JSON.stringify(exportsObj.inject))
check('E07 红线：inject 里不许出现包名', !(exportsObj.inject || []).some((s) => String(s).includes('/')),
    JSON.stringify(exportsObj.inject))

// ---------------------------------------------------------------- package.json 的包名契约
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pkgInject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
check('package.json dsh.client.inject 是包名', pkgInject.includes('@deepseek-ai/dsh-client-ui-settings'), JSON.stringify(pkgInject))
check('package.json 声明 bundle patch', !!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch), JSON.stringify(pkg.dsh && pkg.dsh.bundle))
check('client 入口文件存在', !!(pkg.exports && pkg.exports['./client']))

// ---------------------------------------------------------------- apply()：注入样式 + 注册 Tab
const DATA = {
    ok: true,
    state: { bgSolid: '', bgImage: '', bgFit: 'cover', bgDim: 0, bgBlur: 0, surfaceAlpha: 0.9, tokens: {}, rules: [] },
    wallpapers: [{ name: 'a.png', bytes: 1024 }],
    defaults: { bgSolid: '', bgImage: '', bgFit: 'cover', bgDim: 0, bgBlur: 0, surfaceAlpha: 0.9, tokens: {}, rules: [] },
    tokens: [['--dsw-alias-bg-base', '主背景'], ['--dsw-specific-sidebar-fill', '侧栏底色']],
    ruleProps: ['background-color', 'color', 'border-radius'],
    presets: ['#16181a', '#ffffff'],
    dir: 'C:\\Users\\x\\.dsh\\appearance',
}
hookQueue.push(DATA, DATA.state, '', '', null, '', 'background-color', '')

let spec = null
let component = null
const slotsCalls = []
const ctx = {
    slots: {
        inject: (name, cb) => { slotsCalls.push('inject:' + name); return cb() },
        register: (s, c) => { spec = s; component = c; slotsCalls.push('register:' + s.name + ':' + s.id); return () => { } },
    },
}
exportsObj.apply(ctx)
check('向 settings.plugins.tab 注入', slotsCalls.includes('inject:settings.plugins.tab'), slotsCalls.join(' , '))
check('Tab spec 正确', !!spec && spec.name === 'settings.plugins.tab' && spec.id === 'appearance' && spec.order === 30,
    JSON.stringify(spec && { name: spec.name, id: spec.id, order: spec.order }))
check('label() 返回中文名', typeof spec.label === 'function' && spec.label() === '外观', spec && String(spec.label()))
check('注册了组件函数', typeof component === 'function')

await new Promise((r) => setTimeout(r, 30))
check('拉取了 style.css', fetched.some((u) => u.includes('/dsh-appearance/style.css')), fetched.join(' , '))
const styleEl = styleEls.find((e) => e.id === 'dsh-appearance-style')
check('样式已贴进 <style>', !!styleEl && styleEl.textContent.includes('CSS-FROM-SERVER'),
    styleEl ? String(styleEl.textContent).slice(0, 40) : '(no style element)')

// 页面侧诊断回传（2026-09-26 新增）：让"页面看到的事实"能从服务端读到
await new Promise((r) => setTimeout(r, 80))
check('回传了诊断（POST /dsh-appearance/diag）', fetched.some((u) => u.includes('/dsh-appearance/diag')), fetched.join(' , '))
const diagBody = fetchBodies.find((b) => b.includes('opaqueChain'))
check('诊断里带 origin（dsh-app://app）', !!diagBody && diagBody.includes('dsh-app://app'), diagBody ? diagBody.slice(0, 120) : '(no diag body)')
check('诊断里带壁纸加载结果 imgTest', !!diagBody && diagBody.includes('imgTest'), diagBody ? diagBody.slice(0, 200) : '')

// ---------------------------------------------------------------- 真渲染一遍
function flatten(node, out) {
    if (node === null || node === undefined || node === false) return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out }
    if (node && typeof node.type === 'function') { flatten(node.type(node.props || {}), out); return out }
    if (node && node.kids) node.kids.forEach((k) => flatten(k, out))
    return out
}
const tree = component({})
const text = flatten(tree, []).join(' ')
for (const needle of ['背景', '颜色变量', '自定义规则', '保存并应用', '恢复默认', '主背景', '侧栏底色', '选择本地图片', '读取页面类名']) {
    check('渲染包含「' + needle + '」', text.includes(needle))
}
function findProp(node, key, needle) {
    if (!node || typeof node !== 'object') return false
    if (Array.isArray(node)) return node.some((n) => findProp(n, key, needle))
    if (node.props && typeof node.props[key] === 'string' && node.props[key].includes(needle)) return true
    if (node.kids) return node.kids.some((k) => findProp(k, key, needle))
    return false
}
// ⚠️ 图床 URL 在 <img src> **属性**里，不在文本节点里 —— 拿 flatten 出来的文本找它是找不到的（栽过一次）
check('渲染含壁纸缩略图 src', findProp(tree, 'src', '/dsh-appearance/wallpaper?name=a.png'))
check('渲染里不含 undefined', !text.includes('undefined'), text.slice(0, 120))

console.log('=== test-client-load ===')
for (const r of results) console.log(r)
console.log('')
if (fails === 0) {
    console.log(`结论：全部通过（${results.length} 项）`)
    process.exit(0)
}
console.log(`结论：${fails} 项失败 / 共 ${results.length} 项`)
process.exit(1)
