/**
 * dsh-appearance —— 宿主（服务端）入口
 *
 * 职责很薄：把"外观配置"落盘，并在 DSH 的 web 服务上挂几条**同源**路由供客户端插件用：
 *   GET  /dsh-appearance/state              → { state, wallpapers, defaults, tokens, ruleProps, presets }
 *   POST /dsh-appearance/state              → 保存（服务端**再校验一次**）
 *   POST /dsh-appearance/reset              → 恢复默认
 *   POST /dsh-appearance/wallpaper          → { name, data(base64) } 存壁纸
 *   POST /dsh-appearance/wallpaper/delete   → { name } 删壁纸
 *   GET  /dsh-appearance/wallpaper?name=…   → 壁纸字节（同源 http，Chromium 能直接当背景图）
 *   GET  /dsh-appearance/style.css          → **生成好的 CSS**（唯一真源在 lib/appearance-core.js）
 *
 * 为什么 CSS 由服务端生成（而不是客户端自己拼）：这样"空白名单校验 + CSS 生成"只有一份实现，
 * 客户端只负责把 style.css 贴进 <style>，不会再出现"两处逻辑漂移"（账本 §5.1 单一事实来源）。
 *
 * 状态目录：`$DSH_HOME\appearance\`（默认 `%USERPROFILE%\.dsh\appearance\`），
 * 可用环境变量 `DSH_APPEARANCE_DIR` 覆盖（自检/影子环境用）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import {
    APPEARANCE_RULE_PROPS, APPEARANCE_TOKENS, PRESET_COLORS, appearanceDefaults,
    buildCss, safeName, validateState,
} from './appearance-core.js'

export const name = 'dsh-appearance'

const BASE = '/dsh-appearance'
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024          // 壁纸最大 24MB（base64 前）
const WALLPAPER_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

function log(...args) {
    try { console.log('[dsh-appearance]', ...args) } catch { }
}

function dataDir() {
    if (process.env.DSH_APPEARANCE_DIR) return process.env.DSH_APPEARANCE_DIR
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
    return join(home, 'appearance')
}
function stateFile() { return join(dataDir(), 'appearance.json') }
function wallpaperDir() { return join(dataDir(), 'wallpaper') }

function ensureDirs() {
    const d = dataDir()
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    const w = wallpaperDir()
    if (!existsSync(w)) mkdirSync(w, { recursive: true })
}

function wallpaperExists(n) {
    const f = join(wallpaperDir(), safeName(n))
    return existsSync(f) && statSync(f).isFile()
}

function listWallpapers() {
    try {
        return readdirSync(wallpaperDir())
            .filter((n) => WALLPAPER_MIME[extname(n).toLowerCase()])
            .map((n) => ({ name: n, bytes: (() => { try { return statSync(join(wallpaperDir(), n)).size } catch { return 0 } })() }))
            .sort((a, b) => b.name.localeCompare(a.name))
    } catch { return [] }
}

export function loadState() {
    const def = appearanceDefaults()
    try {
        if (!existsSync(stateFile())) return def
        // 记事本等编辑器存的 UTF-8 会带 BOM，JSON.parse 不认 —— 先剥掉
        const raw = JSON.parse(String(readFileSync(stateFile(), 'utf8')).replace(/^\uFEFF/, ''))
        return validateState(raw, wallpaperExists)
    } catch (e) {
        log('外观配置读取失败，用默认值: ' + (e && e.message))
        return def
    }
}

export function saveState(s) {
    const clean = validateState(s, wallpaperExists)
    try {
        ensureDirs()
        // ⚠️ 无 BOM 的 UTF-8（与 AGENTS.md 的 JSON 红线同因：BOM 会让 node 端 JSON.parse 炸）
        writeFileSync(stateFile(), JSON.stringify(clean, null, 2), 'utf8')
    } catch (e) {
        log('外观配置写入失败: ' + (e && e.message))
    }
    return clean
}

function wallpaperUrl(n) {
    return BASE + '/wallpaper?name=' + encodeURIComponent(n)
}

/**
 * 壁纸内联成 data URL（2026-09-26 改）。
 *
 * 为什么不用 `url(/dsh-appearance/wallpaper?name=…)`：官方端窗口的 origin 是自有的
 * `dsh-app:` scheme，CSS 里的**子资源**要走 Electron 的 protocol handler + CSP 那一套；
 * 实测"面板里能选中壁纸、style.css 也生成了，但界面上什么都看不到"。
 * 用户的自制外壳当初也是这么解的（"壁纸用 data URL 注入"），照它的做法最稳。
 * 超过 12MB 就不内联、退回 URL 形式（那种图本来也不适合当壁纸）。
 */
function wallpaperDataUrl(n) {
    try {
        const file = join(wallpaperDir(), safeName(n))
        if (!existsSync(file)) return ''
        const st = statSync(file)
        if (st.size > 12 * 1024 * 1024) { log(`壁纸 ${n} 太大（${st.size}B），退回 URL 形式`); return '' }
        const mime = WALLPAPER_MIME[extname(file).toLowerCase()] || 'application/octet-stream'
        return 'data:' + mime + ';base64,' + readFileSync(file).toString('base64')
    } catch (e) {
        log('壁纸内联失败，退回 URL 形式: ' + (e && e.message))
        return ''
    }
}

function sendJson(response, code, body) {
    let text
    try { text = JSON.stringify(body) } catch (e) { text = JSON.stringify({ ok: false, error: '结果无法序列化: ' + (e && e.message) }) }
    try {
        response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(text)
    } catch { /* 连接已断，忽略 */ }
}

function sendText(response, code, text, type) {
    try {
        response.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(text)
    } catch { /* 忽略 */ }
}

/**
 * 只有"本机自己的窗口"能写。接受三种情况：
 *   ① 没有 Origin —— 同源 GET / 非浏览器调用；
 *   ② Origin 的 host 与 Host 头一致 —— 普通同源 http 页面（网页端 3080 那种）；
 *   ③ Origin 是官方桌面端的**自有 scheme** `dsh-app:` —— 官方端窗口就在这个 origin 上
 *      （Electron `--standard-schemes=dsh-app`；外部网页伪造不出这个 origin，所以仍然安全）。
 *
 * ⚠️ 2026-09-26 真机踩到（**功能静默失效**）：原来只认 ②，而官方端窗口是 ③
 *    ⇒ 它**自己的窗口**被当成跨源拒掉：GET 不校验（面板照常显示），所有 POST 返回 403
 *    ⇒ "面板能打开，但保存/上传一律无效"。守护插件抄的是同一段代码，一起坏。
 *    判据：`~\.dsh\appearance\appearance.json` 从来不存在（服务端只在保存成功时写它）。
 */
function isTrustedOrigin(request) {
    const origin = request.headers && request.headers.origin
    if (!origin) return true
    try {
        const u = new URL(origin)
        if (u.host && u.host === (request.headers.host || '')) return true
        if (u.protocol === 'dsh-app:') return true
    } catch { /* 解析不了的 origin 一律不信 */ }
    return false
}

export const inject = ['webServer']

export function apply(ctx) {
    ensureDirs()
    log(`状态目录 ${dataDir()}（壁纸 ${listWallpapers().length} 张）`)

    ctx.inject(['webServer'], (host) => {
        const routes = [
            {
                path: BASE + '/state', method: 'GET',
                run: () => ({
                    ok: true,
                    state: loadState(),
                    wallpapers: listWallpapers(),
                    defaults: appearanceDefaults(),
                    tokens: APPEARANCE_TOKENS,
                    ruleProps: Object.keys(APPEARANCE_RULE_PROPS),
                    presets: PRESET_COLORS,
                    dir: dataDir(),
                }),
            },
            {
                // ⚠️ 路径必须**唯一**：host.webServer.register 的形状是 {kind:'exact', path, handler}，
                //    匹配只看 path（没有 method 字段）⇒ 同一路径注册两条（GET+POST）很可能只有一条生效。
                //    所以 POST 一律挂到子路径上（state/save、state/reset、wallpaper/add）。
                path: BASE + '/state/save', method: 'POST',
                run: (body) => ({ ok: true, state: saveState(body && body.state ? body.state : body) }),
            },
            {
                path: BASE + '/state/reset', method: 'POST',
                run: () => ({ ok: true, state: saveState(appearanceDefaults()) }),
            },
            {
                // 页面侧诊断回传（2026-09-26 新增）：客户端把"它看到的事实"写进 diag.json，
                // 于是**从服务端就能定位样式/资源加载类问题**，不必靠肉眼或让用户开 DevTools。
                // ⚠️ 不要再给同一路径加 GET —— 路由器只按 path 匹配（账本 E74）。
                path: BASE + '/diag', method: 'POST',
                run: (body) => {
                    try {
                        ensureDirs()
                        const payload = Object.assign({ at: new Date().toISOString() }, body || {})
                        writeFileSync(join(dataDir(), 'diag.json'), JSON.stringify(payload, null, 2), 'utf8')
                        return { ok: true }
                    } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
                },
            },
            {
                path: BASE + '/wallpaper/add', method: 'POST',
                run: (body) => {
                    const nm = safeName(body && body.name)
                    if (!nm || !WALLPAPER_MIME[extname(nm).toLowerCase()]) {
                        return { ok: false, error: '只支持 PNG / JPEG / GIF / WebP / BMP' }
                    }
                    const data = String((body && body.data) || '')
                    if (!data) return { ok: false, error: '没有收到图片数据' }
                    const buf = Buffer.from(data, 'base64')
                    if (!buf.length) return { ok: false, error: '图片数据为空' }
                    if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, error: `图片太大（>${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB）` }
                    ensureDirs()
                    writeFileSync(join(wallpaperDir(), nm), buf)
                    const st = loadState()
                    return { ok: true, name: nm, bytes: buf.length, wallpapers: listWallpapers(), state: saveState(Object.assign({}, st, { bgImage: nm })) }
                },
            },
            {
                path: BASE + '/wallpaper/delete', method: 'POST',
                run: (body) => {
                    const nm = safeName(body && body.name)
                    if (!nm) return { ok: false, error: '缺少 name' }
                    try { unlinkSync(join(wallpaperDir(), nm)) } catch { /* 不存在就算了 */ }
                    const st = loadState()
                    if (st.bgImage === nm) saveState(Object.assign({}, st, { bgImage: '' }))
                    return { ok: true, wallpapers: listWallpapers(), state: loadState() }
                },
            },
        ]

        const readBody = (request, limit) => new Promise((resolve) => {
            let raw = ''
            let blown = false
            request.on('data', (chunk) => {
                raw += chunk
                if (raw.length > limit) { blown = true; raw = ''; request.destroy() }
            })
            request.on('end', () => {
                if (blown || !raw) { resolve({}); return }
                try { resolve(JSON.parse(raw)) } catch { resolve({}) }
            })
            request.on('error', () => resolve({}))
        })

        const disposers = routes.map((route) => host.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: async (request, response) => {
                if (request.method !== route.method) {
                    sendJson(response, 405, { ok: false, error: `本路由只接受 ${route.method}` })
                    return
                }
                if (route.method === 'POST' && !isTrustedOrigin(request)) {
                    // 拒绝时把 origin/host 记下来 —— 这类失效原来完全静默，查了半天
                    log(`拒绝写请求 ${route.path}：origin=${request.headers && request.headers.origin} host=${request.headers && request.headers.host}`)
                    sendJson(response, 403, { ok: false, error: '只接受来自本机 DSH 窗口/网页端的写请求' })
                    return
                }
                const body = route.method === 'POST'
                    ? await readBody(request, route.path.endsWith('/wallpaper/add') ? MAX_UPLOAD_BYTES * 2 : 64 * 1024)
                    : {}
                let result
                try { result = await route.run(body, request) }
                catch (e) { result = { ok: false, error: String((e && e.message) || e) } }
                sendJson(response, 200, result)
            },
        }))

        // 生成 CSS（唯一真源 appearance-core）；壁纸字节走同源 http
        disposers.push(host.webServer.register({
            kind: 'exact',
            path: BASE + '/style.css',
            handler: (request, response) => {
                if (request.method !== 'GET') { sendText(response, 405, 'GET only'); return }
                const css = buildCss(loadState(), {
                    wallpaperExists,
                    // 优先内联 data URL；内联不了（太大 / 读失败）才退回同源 URL
                    wallpaperUrl: (n) => wallpaperDataUrl(n) || wallpaperUrl(n),
                })
                sendText(response, 200, css, 'text/css; charset=utf-8')
            },
        }))

        // 壁纸字节（?name=xxx；用 query 而不是路径参数，因为 register 只支持 kind:'exact'）
        disposers.push(host.webServer.register({
            kind: 'exact',
            path: BASE + '/wallpaper',
            handler: (request, response) => {
                if (request.method !== 'GET') { sendText(response, 405, 'GET only'); return }
                let nm = ''
                try { nm = safeName(new URL(request.url, 'http://127.0.0.1').searchParams.get('name')) } catch { }
                const mime = WALLPAPER_MIME[extname(nm).toLowerCase()]
                const file = join(wallpaperDir(), nm)
                if (!nm || !mime || !existsSync(file)) { sendText(response, 404, 'wallpaper not found'); return }
                try {
                    const buf = readFileSync(file)
                    response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': buf.length })
                    response.end(buf)
                } catch (e) { sendText(response, 500, 'read failed: ' + (e && e.message)) }
            },
        }))

        host.effect(() => () => {
            for (const d of disposers) { try { if (typeof d === 'function') d() } catch { } }
        }, 'dsh-appearance: http routes')
    })

    log(`已挂载 ${BASE}/*`)
}
