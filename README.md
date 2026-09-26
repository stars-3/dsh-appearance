# dsh-appearance · 外观编辑器（官方桌面端 / 客户端插件）

> 源码仓库：<https://github.com/stars-3/dsh-appearance> ｜ npm：`dsh-appearance-editor`
> （作者的发布工具 `Push-ToGitHub.cmd` / `发布到npm.cmd` 留在本地、**不进公开仓库**）

> 把自制外壳（`DSH-Desktop\shell-app\`，Ctrl+Alt+U）里的**外观编辑器**搬到官方桌面端。
> 外壳那个版本长在 **Electron 主进程**里（`webContents.insertCSS` + IPC + 自绘标题栏），
> **不能直接复制**——官方端没有自定义 CSS 钩子。所以这里重写成**客户端插件**：
> 服务端存配置 + 生成 CSS，客户端把 CSS 贴进 `<style>` 并提供一个设置页面板。

## 能做什么

| 能力 | 说明 |
|---|---|
| 背景纯色 | 12 个预设 + 任意 `#rrggbb` / `rgba(...)`；同时写进 `--dsw-alias-bg-base` 与 `--dsw-specific-sidebar-fill`（只画 html/body 会被 DSH 容器盖住） |
| 壁纸 | 选本地图片（PNG / JPEG / GIF 动图 / WebP / BMP），铺法 cover/contain/repeat、调暗 0–80%、模糊 0–20px、面板不透明度 0.3–1；大图先用 canvas 缩到 ≤2560px |
| 颜色变量 | 18 个 token（含 4 个 `--dsw-specific-*`：侧栏/菜单/输入框/气泡底色——它们不走 alias，必须单独改） |
| 自定义规则 | 「读取页面类名」扫当前界面真实类名 → 选属性填值 → 生成 `[class*="类名"] { 属性: 值 !important }`；属性与取值都过**白名单**，上限 200 条 |
| 恢复默认 | 一条命令回到出厂状态 |

**没搬过来的（官方端没有对应能力，见迁移文档 §9.5）**：无边框标题栏、顶栏自动隐藏
（依赖外壳主进程 `screen.getCursorScreenPoint()` + `-webkit-app-region:drag`）、托盘菜单、
`Ctrl+Alt+U` 热键、「打开皮肤文件」按钮。

## 装

**npm（推荐，升级最省事）**：

```powershell
dsh plugin --profile desktop add dsh-appearance-editor
```

**本地源码**（开发用）：

```powershell
powershell -ExecutionPolicy Bypass -File Install-Plugin.ps1 -Profile desktop
# 或者双击 Install-Plugin.cmd（默认装到 desktop）
```

> ⚠️ **改包名要同时改两处，否则「服务端全绿、界面全坏」**（账本 **E80**，2026-09-26 真机踩过）：
> ① `cordis.patch.yml` 的 `insert.name` **必须等于包名** —— DSH 只把 bundle 包**按包名**链接进
> 模块回退目录（写成旧名 → `/dsh-appearance/*` 全 404、面板不挂载）；
> ② `client/client.js` 里 `window.__ModuleLoader__.load({ id })` **也必须等于包名** ——
> 官方端按包名注册进客户端图，加载后**断言**该 id 注册过，不一致就抛
> `loaded without registering "<pkg>" via __ModuleLoader__.load`（面板不挂载、CSS 注入失效）。
> 版本：**0.1.0 两处都错 → 0.1.1 修 ① → 0.1.2 修 ②**（现用 0.1.2）。
> 自查：`DSH-Desktop\tools\Check-PluginPackaging.ps1 -Dir <本目录>`、
> 运行时：`DSH-Desktop\tools\probe-client-bundle-ids.mjs`。
> 本地源码装（`Install-Plugin.ps1`）走另一套：拷进 `node_modules\dsh-appearance`，旧名仍可用。

装完的**生效方式（两种情形别混，2026-09-26 实测）**：**新增 bundle 会热加载**（装完约 18 秒服务端路由
即可访问）；但**改本插件内部代码后必须重启官方端** —— 服务端插件模块在进程内有缓存，
触碰 profile 也不会重新 `import`（判别法：看返回文案变没变）。**客户端那半**
（面板 / 样式）刷新页面（`Ctrl+R`）即可。之后：设置 → 插件 → **外观**。

卸载：`Install-Plugin.ps1 -Revert -Profile desktop`

## 它怎么工作（单一事实来源）

```
lib/appearance-core.js   纯逻辑：默认值 / 校验白名单 / buildCss（**逐字移植自 shell-app\main.js**）
        ↑                        ↑
lib/index.js（服务端）      client/client.js（客户端）
 · $DSH_HOME\appearance\     · 拉 GET /dsh-appearance/style.css 贴进 <style>
   ├ appearance.json         · 设置页「外观」面板（改完 POST /state 再刷新样式）
   └ wallpaper\
 · 路由：/state /reset /wallpaper /style.css
```

**CSS 只由服务端生成** —— 客户端不拼 CSS、不复制白名单，避免"两处逻辑漂移"（账本 §5.1）。

状态目录默认 `%USERPROFILE%\.dsh\appearance\`，可用 `DSH_APPEARANCE_DIR` 覆盖（自检用）。

## 自检（可复现）

```powershell
node tools\test-appearance-core.mjs     # 纯逻辑：默认值/白名单/夹取/CSS 生成（含阳性+阴性对照）
node tools\test-host-load.mjs           # 服务端：路由注册、读写落盘、壁纸上传/取回、CSS 内容
node tools\test-client-load.mjs         # 客户端：bundle 形状、服务名 vs 包名、Tab 注册、渲染
```
