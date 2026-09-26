/**
 * test-host-load.mjs —— 服务端自检：路由注册 / 读写落盘 / 壁纸上传取回 / CSS 内容 / 同源校验
 *
 * 用法： node tools\test-host-load.mjs
 * 影子状态目录：临时目录（不碰 %USERPROFILE%\.dsh\appearance），跑完即删。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shadow = mkdtempSync(join(tmpdir(), 'dsh-appearance-test-'))
process.env.DSH_APPEARANCE_DIR = shadow

let fails = 0
const results = []
function check(what, ok, detail) {
    results.push((ok ? '  OK   ' : '  FAIL ') + what + (detail ? '  → ' + detail : ''))
    if (!ok) fails++
}

// ---------------------------------------------------------------- 假宿主
const routes = []
const effects = []
const fakeHost = {
    webServer: { register: (r) => { routes.push(r); return () => { } } },
    effect: (fn) => { effects.push(fn); return () => { } },
}
const injectedDeps = []
const ctx = {
    inject: (deps, cb) => { injectedDeps.push(deps); cb(fakeHost); return () => { } },
}

function fakeReq(method, url, jsonBody, headers) {
    const listeners = {}
    const req = {
        method,
        url: url || '/',
        headers: Object.assign({ host: '127.0.0.1:19387' }, headers || {}),
        on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return req },
        destroy() { },
    }
    setTimeout(() => {
        if (jsonBody !== undefined) {
            for (const cb of (listeners.data || [])) cb(Buffer.from(JSON.stringify(jsonBody)))
        }
        for (const cb of (listeners.end || [])) cb()
    }, 0)
    return req
}
function fakeRes() {
    const r = { code: 0, headers: null, body: null }
    r.writeHead = (c, h) => { r.code = c; r.headers = h }
    r.end = (b) => { r.body = b }
    return r
}
async function call(path, { method = 'GET', body, query, origin } = {}) {
    const route = routes.find((x) => x.path === path)
    if (!route) throw new Error('route not registered: ' + path)
    const url = path + (query ? '?' + query : '')
    const headers = origin ? { origin } : undefined
    const res = fakeRes()
    await route.handler(fakeReq(method, url, body, headers), res)
    let json = null
    try { json = JSON.parse(String(res.body)) } catch { /* binary or css */ }
    return { code: res.code, headers: res.headers, body: res.body, json }
}

// ---------------------------------------------------------------- 加载插件
const mod = await import('../lib/index.js')
check('插件名正确', mod.name === 'dsh-appearance', mod.name)
check('声明依赖 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject))

mod.apply(ctx)
check('注册了 8 条路由', routes.length === 8, String(routes.length))
const paths = routes.map((r) => (r.kind || '') + ' ' + r.path).sort()
check('路由路径齐全', paths.join('|').includes('/dsh-appearance/state') &&
    paths.join('|').includes('/dsh-appearance/style.css') &&
    paths.join('|').includes('/dsh-appearance/wallpaper'), paths.join(' , '))
check('有 effect 清理器', effects.length === 1)

// ---------------------------------------------------------------- GET /state（阳性）
const st0 = await call('/dsh-appearance/state')
check('GET /state ok', st0.code === 200 && st0.json && st0.json.ok === true, JSON.stringify(st0.json && st0.json.error))
check('返回 18 个 token', Array.isArray(st0.json.tokens) && st0.json.tokens.length === 18)
check('返回 8 条属性白名单', Array.isArray(st0.json.ruleProps) && st0.json.ruleProps.length === 8)
check('初始无壁纸', Array.isArray(st0.json.wallpapers) && st0.json.wallpapers.length === 0)
check('状态目录落在影子目录', st0.json.dir === shadow, st0.json.dir)

// ---------------------------------------------------------------- POST /state/save → 落盘
const saved = await call('/dsh-appearance/state/save', { method: 'POST', body: { state: { bgSolid: '#16181a', bgDim: 999 } } })
check('POST /state ok 且夹取', saved.json.ok === true && saved.json.state.bgDim === 80, JSON.stringify(saved.json.state))
const statePath = join(shadow, 'appearance.json')
check('state 文件已落盘', existsSync(statePath))
const raw = readFileSync(statePath)
check('state 文件无 BOM', !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf))
let okJson = true
try { JSON.parse(raw.toString('utf8')) } catch { okJson = false }
check('state 文件是合法 JSON', okJson)

// ---------------------------------------------------------------- GET /style.css 反映刚保存的状态
const css1 = await call('/dsh-appearance/style.css')
check('style.css 是 text/css', String(css1.headers['Content-Type']).startsWith('text/css'), String(css1.headers['Content-Type']))
check('style.css 含刚存的纯色', String(css1.body).includes('background: #16181a !important'))

// ---------------------------------------------------------------- 壁纸：上传 → 取回 → 进 CSS
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const up = await call('/dsh-appearance/wallpaper/add', { method: 'POST', body: { name: 'test.png', data: PNG_1x1 } })
check('上传壁纸 ok', up.json.ok === true, JSON.stringify(up.json))
check('上传后 state.bgImage 指向它', up.json.state.bgImage === 'test.png', up.json.state.bgImage)
check('壁纸列表里有它', up.json.wallpapers.some((w) => w.name === 'test.png'))

const got = await call('/dsh-appearance/wallpaper', { query: 'name=test.png' })
check('取回壁纸 200 + image/png', got.code === 200 && got.headers['Content-Type'] === 'image/png', String(got.headers['Content-Type']))
check('取回字节与上传一致', Buffer.isBuffer(got.body) && got.body.toString('base64') === PNG_1x1)

const css2 = await call('/dsh-appearance/style.css')
// 2026-09-26 改：壁纸必须**内联成 data URL**（官方端窗口是 dsh-app: scheme，CSS 子资源要走
// protocol handler + CSP 那套；实测"面板里选中了壁纸、style.css 也生成了，界面上却看不到"）
check('CSS 内联壁纸为 data URL', String(css2.body).includes('url(data:image/png;base64,') && String(css2.body).includes('background-size: cover'))
check('CSS 不再依赖壁纸 URL 路由', !String(css2.body).includes('/dsh-appearance/wallpaper?name='))

const bad = await call('/dsh-appearance/wallpaper', { query: 'name=nope.png' })
check('取不存在的壁纸 404', bad.code === 404, String(bad.code))

const traversal = await call('/dsh-appearance/wallpaper/add', { method: 'POST', body: { name: '../../evil.png', data: PNG_1x1 } })
check('路径穿越名被消毒', traversal.json.ok === true && traversal.json.name === '.._.._evil.png', String(traversal.json.name))
check('穿越文件没写到上级目录', !existsSync(join(shadow, '..', 'evil.png')))

// ---------------------------------------------------------------- 同源校验
const cross = await call('/dsh-appearance/state/save', { method: 'POST', body: { state: {} }, origin: 'http://evil.example' })
check('跨源 POST 被拒 403', cross.code === 403, String(cross.code))
// ⚠️ 2026-09-26 真机 bug 的回归钉：官方桌面端窗口的 origin 是它**自有的 scheme** `dsh-app:`
//    （Electron `--standard-schemes=dsh-app`）。原来只认"host 与 Host 头一致" ⇒ 它自己的窗口
//    被 403，所有 POST 静默失效（GET 不校验 ⇒ 面板照常显示，表现为"面板有、改了没用"）。
const appOrigin = await call('/dsh-appearance/state/save', { method: 'POST', body: { state: { bgSolid: '#0f1115' } }, origin: 'dsh-app://app' })
check('官方端 scheme dsh-app: 的写请求被接受', appOrigin.code === 200 && appOrigin.json.ok === true, 'status=' + appOrigin.code)
check('dsh-app 写请求真的落盘了', appOrigin.json.ok === true && appOrigin.json.state.bgSolid === '#0f1115', JSON.stringify(appOrigin.json.state && appOrigin.json.state.bgSolid))
const same = await call('/dsh-appearance/state/save', { method: 'POST', body: { state: {} }, origin: 'http://127.0.0.1:19387' })
check('同源 POST 放行', same.code === 200 && same.json.ok === true)

// ---------------------------------------------------------------- 方法校验
const wrongMethod = await call('/dsh-appearance/state', { method: 'DELETE' })
check('方法不符 405', wrongMethod.code === 405, String(wrongMethod.code))

// ---------------------------------------------------------------- reset + 删除壁纸
const del = await call('/dsh-appearance/wallpaper/delete', { method: 'POST', body: { name: 'test.png' } })
check('删壁纸 ok（test.png 已消失）', del.json.ok === true && !del.json.wallpapers.some((w) => w.name === 'test.png'),
    JSON.stringify(del.json.wallpapers))
// 顺手把"路径穿越"那条测试留下的文件也删掉，避免污染后续断言
await call('/dsh-appearance/wallpaper/delete', { method: 'POST', body: { name: '.._.._evil.png' } })
const rst = await call('/dsh-appearance/state/reset', { method: 'POST', body: {} })
check('reset 回默认', rst.json.ok === true && rst.json.state.bgSolid === '' && rst.json.state.bgImage === '')

// ---------------------------------------------------------------- 清理与输出
rmSync(shadow, { recursive: true, force: true })
console.log('=== test-host-load ===')
for (const r of results) console.log(r)
console.log('')
if (fails === 0) {
    console.log(`结论：全部通过（${results.length} 项）`)
    process.exit(0)
}
console.log(`结论：${fails} 项失败 / 共 ${results.length} 项`)
process.exit(1)
