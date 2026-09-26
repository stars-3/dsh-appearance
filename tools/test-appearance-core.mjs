/**
 * test-appearance-core.mjs —— 纯逻辑自检（默认值 / 白名单 / 夹取 / CSS 生成）
 *
 * 惯例（账本 §2 强化行）：**先跑阳性对照**（已知正确答案的输入必须得到那个答案），
 * 再跑**阴性对照**（非法输入的任何片段都不许出现在输出里）。
 *
 * 用法： node tools\test-appearance-core.mjs
 */
import {
    APPEARANCE_RULE_PROPS, APPEARANCE_TOKENS, appearanceDefaults,
    buildCss, isColor, safeName, validateState,
} from '../lib/appearance-core.js'

let fails = 0
const results = []
function check(what, ok, detail) {
    results.push((ok ? '  OK   ' : '  FAIL ') + what + (detail ? '  → ' + detail : ''))
    if (!ok) fails++
}

// ---------------------------------------------------------------- 基本形状
const def = appearanceDefaults()
check('默认值字段齐全', ['bgSolid', 'bgImage', 'bgFit', 'bgDim', 'bgBlur', 'surfaceAlpha', 'tokens', 'rules']
    .every((k) => k in def))
check('token 表 18 个', APPEARANCE_TOKENS.length === 18, String(APPEARANCE_TOKENS.length))
check('属性白名单 8 条', Object.keys(APPEARANCE_RULE_PROPS).length === 8)
check('token 含 4 个 specific', APPEARANCE_TOKENS.filter((p) => p[0].startsWith('--dsw-specific-')).length === 4)

// ---------------------------------------------------------------- 颜色校验
check('isColor 认 #rgb/#rrggbb/rgba', isColor('#abc') && isColor('#16181a') && isColor('rgba(1,2,3,.5)'))
check('isColor 拒关键字', !isColor('red') && !isColor('url(x)'))
check('非法纯色被丢弃', validateState({ bgSolid: 'red' }).bgSolid === '')
check('合法纯色保留', validateState({ bgSolid: '#16181a' }).bgSolid === '#16181a')

// ---------------------------------------------------------------- 数值夹取
check('bgDim 夹到 0..80', validateState({ bgDim: 999 }).bgDim === 80 && validateState({ bgDim: -5 }).bgDim === 0)
check('bgBlur 夹到 0..20', validateState({ bgBlur: 99 }).bgBlur === 20 && validateState({ bgBlur: -1 }).bgBlur === 0)
check('surfaceAlpha 夹到 .3..1', validateState({ surfaceAlpha: 5 }).surfaceAlpha === 1 &&
    Math.abs(validateState({ surfaceAlpha: 0 }).surfaceAlpha - 0.9) < 1e-9)
check('bgFit 白名单', validateState({ bgFit: 'nonsense' }).bgFit === 'cover' && validateState({ bgFit: 'repeat' }).bgFit === 'repeat')

// ---------------------------------------------------------------- 壁纸名安全（路径穿越）
check('safeName 去分隔符', safeName('a/b\\c.png') === 'a_b_c.png', safeName('a/b\\c.png'))
check('带路径的 bgImage 被丢弃', validateState({ bgImage: '../../evil.png' }).bgImage === '')
check('不存在的壁纸被丢弃', validateState({ bgImage: 'a.png' }, () => false).bgImage === '')
check('存在的壁纸保留', validateState({ bgImage: 'a.png' }, () => true).bgImage === 'a.png')

// ---------------------------------------------------------------- 规则白名单
const badRules = [
    { cls: 'x', prop: 'position', value: 'fixed' },            // 属性不在白名单
    { cls: 'x', prop: 'font-size', value: 'javascript:1' },    // 取值不合法
    { cls: 'x', prop: 'color', value: '#fff' },                // 合法 ← 唯一该留下的
    { cls: 'a<script>', prop: 'color', value: '#fff' },        // 类名非法
    { cls: 'x', prop: 'opacity', value: '1.5' },               // 越界
]
check('规则白名单只留 1 条', validateState({ rules: badRules }).rules.length === 1,
    JSON.stringify(validateState({ rules: badRules }).rules))
const many = Array.from({ length: 300 }, () => ({ cls: 'a', prop: 'color', value: '#fff' }))
check('规则上限 200', validateState({ rules: many }).rules.length === 200)
check('rules 非数组不炸', validateState({ rules: 'oops' }).rules.length === 0)

// ---------------------------------------------------------------- buildCss：纯色（阳性）
const cssSolid = buildCss({ bgSolid: '#16181a' })
check('纯色写 html/body', cssSolid.includes('html, body { background: #16181a !important; }'))
check('纯色同时补 bg-base', cssSolid.includes('--dsw-alias-bg-base: #16181a !important'))
check('纯色同时补侧栏 specific', cssSolid.includes('--dsw-specific-sidebar-fill: #16181a !important'))
check('空状态不含 html/body 背景规则', !/html, body \{ background/.test(buildCss({})))

// ---------------------------------------------------------------- buildCss：壁纸（阳性）
const cssWall = buildCss(
    { bgImage: 'a.png', bgDim: 50, bgBlur: 4, surfaceAlpha: 0.5, bgFit: 'repeat' },
    { wallpaperExists: () => true, wallpaperUrl: (n) => '/wp/' + n },
)
check('壁纸用 body::before', cssWall.includes('body::before'))
check('壁纸 url 正确', cssWall.includes('url(/wp/a.png)'))
check('壁纸 repeat 铺法', cssWall.includes('background-size: auto') && cssWall.includes('background-repeat: repeat'))
check('壁纸调暗 → brightness(0.50)', cssWall.includes('brightness(0.50)'))
check('壁纸模糊 → blur(4px)', cssWall.includes('blur(4px)'))
// surfaceAlpha=0.5 → 叠层 token 补偿成 1-(0.5)^(1/3)=0.206（三层合成后≈0.5）；浮层 0.85 下限
check('壁纸叠层透明度（深色，补偿后）', cssWall.includes('rgba(21,21,23,0.206)'))
check('壁纸叠层透明度（浅色，补偿后）', cssWall.includes('rgba(255,255,255,0.206)'))
check('壁纸时 html/body 透明', cssWall.includes('html, body { background: transparent !important; }'))

// ---------------------------------------------------------------- token 与规则
check('token 覆盖带 !important', buildCss({ tokens: { '--dsw-alias-link': '#0af' } }).includes('--dsw-alias-link: #0af !important'))
check('token 非法值不进 CSS', !buildCss({ tokens: { '--dsw-alias-link': 'red' } }).includes('--dsw-alias-link'))
check('规则进 CSS', buildCss({ rules: [{ cls: 'abc', prop: 'border-radius', value: '8px' }] })
    .includes('[class*="abc"] { border-radius: 8px !important; }'))

// 2026-09-26 真机实测（diag.json）：官方端三层嵌套容器都读同一个 token，半透明**相乘**
// ⇒ 0.41 叠成 ~0.80，壁纸看不见。修法是**数值补偿**（A'=1-(1-A)^(1/3)）；
// ❌ 别用结构选择器（`body > div > div`）压平容器 —— 实测连设置面板一起命中，面板会变全透明。
const cssComp = buildCss({ bgImage: 'a.png', surfaceAlpha: 0.41 }, { wallpaperExists: () => true, wallpaperUrl: () => 'data:image/gif;base64,AA' })
check('叠层 token 做补偿（0.41 → 0.161）', cssComp.includes('--dsw-alias-bg-base: rgba(21,21,23,0.161) !important'))
check('浮层 token 有 0.85 不透明下限（设置面板要能看清）', cssComp.includes('--dsw-alias-bg-layer-1: rgba(21,21,23,0.85) !important'))
check('不再用结构选择器压平容器（会伤到设置面板）', !cssComp.includes('body > div'))
check('surfaceAlpha=1 时补偿不失真', buildCss({ bgImage: 'a.png', surfaceAlpha: 1 }, { wallpaperExists: () => true }).includes('rgba(21,21,23,1) !important'))

// ---------------------------------------------------------------- 阴性对照：注入串一个字都不许进
const evil = buildCss({
    bgSolid: '#000; } body { display:none',
    bgImage: 'a.png',
    tokens: { '--dsw-alias-link': 'url(javascript:1)' },
    rules: [
        { cls: 'x', prop: 'position', value: 'fixed' },
        { cls: 'x"]{display:none}["'.slice(0, 12), prop: 'color', value: '#fff' },
    ],
    bgDim: 10,
}, { wallpaperExists: () => true })
check('阴性：display:none 未进 CSS', !evil.includes('display:none'))
// ⚠️ 阴性对照必须指名"注入后会变成什么形态"，不能用裸关键词 ——
//    `position: fixed` / `background-position` 在**合法**的壁纸 CSS 里本来就存在（都栽过）。
check('阴性：注入的 position 规则未进 CSS', !evil.includes('[class*="x"] { position: fixed'))
check('阴性：合法壁纸规则仍在（positive 共存）', evil.includes('body::before { content: ""; position: fixed;'))
check('阴性：javascript: 未进 CSS', !evil.includes('javascript:'))
check('阴性：引号注入未进 CSS', !evil.includes(']{'))

// ---------------------------------------------------------------- 输出
console.log('=== test-appearance-core ===')
for (const r of results) console.log(r)
console.log('')
if (fails === 0) {
    console.log(`结论：全部通过（${results.length} 项）`)
    process.exit(0)
}
console.log(`结论：${fails} 项失败 / 共 ${results.length} 项`)
process.exit(1)
