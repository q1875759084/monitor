# 学习笔记

## package.json 中 SDK 与业务项目的差异

### 多入口字段：main / module / exports

业务项目通常只有 `main`，SDK 需要三个字段共存，原因是历史兼容：

```json
"main": "dist/index.cjs",      // 兜底：老版 Node / Webpack 4 读这个
"module": "dist/index.js",     // 约定：Rollup / Webpack 支持 Tree-shaking 读这个
"exports": {                   // 标准：Node 12+ 和现代打包工具优先读这个
  ".": {
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  }
}
```

优先级：`exports` > `module` > `main`。三个都写是为了向下兼容老工具链。

**面试常考**：为什么同一个包要输出 ESM 和 CJS 两种格式？
- CJS（`require`）：Node.js 原生格式，Jest 等测试工具默认用
- ESM（`import`）：支持静态分析，打包工具可以做 Tree-shaking，去掉未用到的代码

---

### types 字段

```json
"types": "dist/index.d.ts"
```

业务项目源码在本地，TypeScript 直接读源文件。SDK 发布后源码不在消费方，必须靠 `.d.ts` 提供类型，`types` 字段告诉 TS 编译器去哪找。

---

### files 字段

```json
"files": ["dist"]
```

控制 `npm publish` 实际打包哪些文件。不配置默认上传整个仓库，包体积大且泄露源码结构。

验证方法：`npm pack --dry-run`，可以看到实际会发布哪些文件，发布前必须跑一次确认。

---

### publishConfig

```json
"publishConfig": {
  "registry": "https://registry.npmjs.org",
  "access": "public"
}
```

两个字段解决两个不同的问题：

- `registry`：本地可能配了美团源/淘宝源，这里固定发布目标为官方源，防止误发到私有 registry
- `access: "public"`：scoped 包（`@scope/name` 格式）npm 默认当私有包处理（付费），加这个强制公开

---

### 依赖字段完整对比

SDK 比业务项目多一个 `peerDependencies`，三个字段的区别容易混淆：

| 字段 | 谁来安装 | 会打包进 dist 吗 | 典型用途 |
|---|---|---|---|
| `dependencies` | 消费方 `npm install` 时自动安装 | 是（SDK 自己负责） | SDK 内部用的工具函数库 |
| `peerDependencies` | 消费方自己提前安装 | 否（消费方提供） | React、web-vitals 等消费方大概率已有的库 |
| `devDependencies` | 只在本仓库开发时安装 | 否 | tsup、typescript、eslint 等构建工具 |

**业务项目 vs SDK 的本质区别**：

业务项目最终产物是 bundle（网页），Webpack/Vite 会把所有 `import` 的代码都打进去，dependencies 和 devDependencies 的区分在实践中意义不大。

SDK 的最终产物是被别人引入的库，`dependencies` 里的包会跟着 SDK 一起被安装，`peerDependencies` 里的包则声明"我需要但由你提供"——本质上都是运行时需要的东西，区别只是**谁来安装的责任归属**。

**`web-vitals` 应该放哪里？**

```json
"devDependencies": { "web-vitals": "4.2.4" }
```

tsup 的 bundle 行为取决于依赖字段：**`dependencies` 默认 external（不打包），`devDependencies` 默认 bundle（打包进 dist）**。这是 tsup 的设计原则——`dependencies` 里的包认为消费方会自己安装，不需要重复打进去；`devDependencies` 里的包只是构建工具用，tsup 会直接内联。

所以对于 `web-vitals` 这类"只是 SDK 内部用、消费方不需要直接使用"的包，放 `devDependencies` 让 tsup bundle 进 dist 是更合适的做法：消费方安装 SDK 后 `web-vitals` 对他完全透明，不出现在他的 `node_modules`，也不需要手动安装。

放 `dependencies` 虽然也能工作（tsup 会 external 掉，消费方自动安装），但 `web-vitals` 是 SDK 的内部实现细节，不应该暴露给消费方——让消费方的 `node_modules` 里多出一个他不关心的包，是不必要的依赖泄漏。

**版本固定为 `4.2.4` 而非 `^4.0.0`**：`web-vitals` 已经打包进 `dist/`，版本在构建时就已锁定，`^` 允许自动升级对运行时没有意义，反而引入不同时间构建产物不一致的风险。

**选 peer / dependencies / devDependencies 的判断标准**：
- 消费方会直接使用，且必须共享同一实例（如 React）→ `peerDependencies`
- 消费方需要感知这个包，或 SDK 需要与消费方共享同一实例 → `dependencies`
- 只是 SDK 内部实现，打包进 dist 对消费方透明 → `devDependencies` + bundle

---

## perf.ts 设计决策

### 职责分层：web-vitals 与 perf.ts 各做什么

```
浏览器底层 API
  └── PerformanceObserver          ← 浏览器原生，监听各类性能条目
        ↓
web-vitals（第三方库）
  └── onFCP / onLCP / onCLS ...   ← 封装 PerformanceObserver，处理计算逻辑和触发时机
        ↓
perf.ts（SDK 内部模块）
  └── initPerf(config)             ← 消费 web-vitals 的回调，格式化后调用 enqueue
```

**web-vitals 解决的问题**：浏览器原生 API 给的是原始性能条目，需要自己判断时机、累加计算。以几个典型指标为例：

- **FCP**：监听 `paint` 类型的 PerformanceEntry，过滤出 `name === 'first-contentful-paint'` 的条目取 `startTime`
- **LCP**：监听 `largest-contentful-paint`，但 LCP 会随着页面继续加载不断更新，需要等用户第一次交互（click/keydown）后才取最终值
- **CLS**：监听所有 `layout-shift` 条目，过滤掉用户交互引起的偏移，然后**累加**所有会话窗口的值，算法相对复杂
- **INP**：监听所有 `event` 类型的交互，取 P98 分位数（不是最大值），同样需要维护一个采样窗口

这些计算逻辑 `web-vitals` 都封装好了，`perf.ts` 不需要关心，只消费最终结果。

**perf.ts 做的事情**：把 `web-vitals` 的回调统一接到 `enqueue`，加上 `appKey / url / ua / timestamp` 上下文字段，以及 CLS 的整数化处理。

### CLS 的整数化处理

CLS 是无单位的小数（如 `0.023`），其他指标是毫秒整数。存储时统一用整数，CLS 乘以 1000 存储（`0.023` → `23`），读取时除以 1000 还原。

原因：浮点数在数据库存储和 JSON 序列化时可能出现精度问题（`0.023000000001`），整数更可靠。

### web-vitals 回调的触发时机

`onFCP` 等函数**不是立即触发的**，而是在浏览器认为指标"稳定"时才回调：

| 指标 | 触发时机 |
|---|---|
| FCP | 首次内容绘制后立即触发 |
| TTFB | 首字节返回后立即触发 |
| LCP | 用户第一次交互（点击/键盘）后触发 |
| CLS | 页面进入 `hidden` 状态时触发最终值 |
| INP | 页面进入 `hidden` 状态时触发最终值 |

实际效果：刷新页面后，FCP 和 TTFB 的数据很快就能上报；LCP、CLS、INP 需要用户操作或切换标签后才会出现。这是 web-vitals 的设计，不是 bug。

---

## tsup：专为打 npm 库设计的构建工具

### 为什么 SDK 不用 Vite/Webpack

| | 业务仓库（video-to-audio） | SDK 仓库（monitor） |
|---|---|---|
| 构建工具 | Vite / Webpack | tsup |
| 消费者 | 浏览器 | 其他 JS 项目（通过 `import`） |
| 产物 | `index.html` + `bundle.js` | `dist/index.js` + `dist/index.cjs` + `dist/index.d.ts` |

Vite/Webpack 的目标是生成"浏览器可直接运行的页面"，会处理 HTML、CSS、代码分割、HMR 等。SDK 不需要这些，只需要把 TypeScript 源码编译成可被 `import` 的库文件，tsup 零配置就能做到。

---

### tsup.config.ts 各字段含义

```ts
export default defineConfig({
  entry: ['src/index.ts'],   // 打包入口，从这里出发分析依赖
  format: ['esm', 'cjs'],    // 同时输出 ESM 和 CJS 两种格式（原因见上方"依赖字段"章节）
  dts: true,                 // 自动从源码生成 .d.ts 类型声明文件
  clean: true,               // 每次构建前清空 dist/，避免残留旧文件
  sourcemap: true,           // 生成 sourcemap，消费方出错时可以定位到 SDK 源码行号
  treeshake: true,           // 去掉未被 import 的代码，减小包体积
})
```

**`dts: true` 为什么重要**：业务项目的 TS 编译器可以直接读源文件获取类型，但 SDK 发布后消费方拿到的只有 `dist/`，没有源码。`.d.ts` 就是"只有类型、没有实现"的声明文件，让消费方的编辑器能提供自动补全和类型校验。

**`format: ['esm', 'cjs']` 输出两个文件**：
- `dist/index.js`（ESM）：现代项目 `import` 时用，支持 Tree-shaking
- `dist/index.cjs`（CJS）：旧项目或 Node.js `require()` 时用

`package.json` 的 `exports` 字段负责告诉消费方该用哪个：

```json
"exports": {
  ".": {
    "import": "./dist/index.js",    // import 语法 → ESM
    "require": "./dist/index.cjs"   // require 语法 → CJS
  }
}
```

---

## reporter.ts 设计决策

### 结构

`reporter.ts` 是 SDK 的底层上报模块，所有其他模块（perf、error、track）都通过它发数据。对外只暴露两个函数：

```
initReporter(config)   ← SDK 初始化时调用，保存配置
enqueue(event)         ← 各采集模块调用，将事件入队
flushImmediate()       ← 页面卸载时调用，跳过 timer 立即发送
```

内部流程：

```
enqueue(event)
  ├── dev 环境 → 只打 log，不入队，直接 return
  ├── 入队 queue[]
  └── 启动 100ms timer → flush()
        ├── queue.splice() 取出全部事件
        ├── sendBeacon（优先）→ 队列满时返回 false，降级
        └── fetch + keepalive（兜底）
```

批量合并的意义：用户一次操作可能同时触发多个事件（如页面加载时 FCP、LCP、PV 同时上报），100ms 内攒批发一次请求，避免短时间内打出多个请求。

### 上报策略：sendBeacon 优先，fetch 降级

```
sendBeacon(url, blob)
  ├── 返回 true  →  成功入队，浏览器负责发送
  └── 返回 false →  队列已满，降级到 fetch + keepalive
```

**为什么优先用 `sendBeacon`**：

`sendBeacon` 是浏览器提供的异步非阻塞发送 API，有两个核心优势：
1. **页面卸载时不丢数据**：普通 `fetch` 在页面关闭时会被浏览器强制中断，`sendBeacon` 的请求由浏览器接管，即使页面已关闭也能保证发出
2. **不阻塞页面卸载**：同步 XHR 会卡住页面关闭，`sendBeacon` 完全异步

**`sendBeacon` 的限制**：
- 只支持 POST，无法自定义 HTTP 方法
- 发送的 `Blob` 需要指定 `type: 'application/json'`，否则后端收到的 Content-Type 为空
- 浏览器对 `sendBeacon` 队列大小有限制（各浏览器不同，通常 64KB），超限时返回 `false`

**`fetch + keepalive` 作为降级**：

```ts
fetch(url, { method: 'POST', body, keepalive: true })
```

`keepalive: true` 让 fetch 请求在页面卸载后继续存活，行为接近 `sendBeacon`，但有更灵活的 header 控制。失败时静默处理，不影响业务流程——监控上报本身不是核心链路，上报失败不应该影响用户。

### 页面卸载时的上报策略

普通场景下，事件攒 100ms 批量发。但页面卸载时 100ms timer 还没到就已经关闭，队列里的事件会丢失。

**解决方案**：监听 `visibilitychange` 事件，在页面进入 `hidden` 状态时立即调用 `flushImmediate()`：

```ts
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushImmediate()
  }
})
```

**为什么用 `visibilitychange` 而不是 `beforeunload` / `unload`**：

| 事件 | 触发时机 | 可靠性 |
|---|---|---|
| `beforeunload` | 页面关闭前 | 移动端不可靠，部分场景不触发 |
| `unload` | 页面卸载时 | 已被现代浏览器限制，`sendBeacon` 在此时可能失败 |
| `visibilitychange hidden` | 页面切到后台/关闭标签 | **推荐**，覆盖切后台、关闭标签、跳转等所有场景 |

`visibilitychange` 是目前最可靠的页面离开信号，Google 官方文档和 `web-vitals` 库本身都用这个时机触发最终上报。

### 多环境策略

SDK 只关心一件事：`env === 'development'` 时不上报。

```
development  →  不上报（debug 模式下打印到 console）
staging      →  正常上报
production   →  正常上报
```

测试/生产的**数据隔离不在 SDK 里做**，由消费方传不同的 `reportUrl` 实现：

```ts
// 生产环境
init({ appKey: 'video', reportUrl: 'https://api.daibao.site/monitor/collect', env: 'production' })

// 测试环境
init({ appKey: 'video', reportUrl: 'http://150.158.118.89:3000/monitor/collect', env: 'staging' })
```

这样做的好处：SDK 不耦合任何具体的 URL 规则，消费方可以自由决定测试/生产如何路由。

`MonitorEnv` 类型收窄为联合类型 `'development' | 'staging' | 'production'`，传错字符串在编译期报错。

### 为什么不用事件订阅模式

事件订阅（EventBus/EventEmitter）适合的场景是：**生产者不知道谁在消费，或者需要多个消费者**。

```
// 适合事件订阅：多个消费者
emit('monitor:event', data)
  ├── reporter  →  上报后端
  ├── storage   →  写 localStorage
  └── ui        →  显示错误提示
```

当前 `enqueue` 的消费者只有一个（reporter），且各采集模块本来就知道自己在做监控上报，直接 `import { enqueue }` 调用更合适：

- **类型安全**：函数参数有 TS 类型约束，事件名是字符串，类型安全要额外定义映射表
- **调试友好**：调用栈直接可见，事件订阅需要追踪事件流
- **无额外成本**：不需要维护全局 EventBus 单例

如果未来需要在上报的同时写缓存或触发 UI，再引入事件订阅，当前阶段引入是 YAGNI。

---

## SDK 本地联调的三种方式

### npm link / 本地路径安装

这两种方式都有各自的问题：`npm link` 依赖全局软链，容易出现多实例问题，且 `npm install` 后 link 会被覆盖；本地路径安装（`npm install /path/to/sdk`）每次 SDK 改动后需要重新 install，开发体验较差。

### yalc（推荐）

`yalc` 是专为本地 SDK 联调设计的工具，模拟完整的 npm 发布/安装流程，但数据存在本机的 `~/.yalc` store 中，不需要真正发包。

**安装**

```bash
npm i -g yalc
```

**工作流**

```bash
# 1. SDK 目录：构建并发布到本地 store
cd /Desktop/monitor
npm run build
yalc publish
# 输出：@q1875759084/monitor@0.1.0 published in store

# 2. 消费方目录：从 store 安装
cd /Desktop/video-to-audio
yalc add @q1875759084/monitor
# package.json 会记录为：
# "@q1875759084/monitor": "file:.yalc/@q1875759084/monitor"

# 3. SDK 改动后：重新构建并推送（消费方自动感知，无需重新 install）
cd /Desktop/monitor
npm run build
yalc push
```

**与 npm link 的核心差异**

| | npm link | yalc |
|---|---|---|
| 消费的是 | 源码软链 | dist 构建产物 |
| 行为是否贴近真实发布 | 否 | 是 |
| 多实例问题 | 有 | 无 |
| SDK 更新后消费方是否自动感知 | 是（软链实时） | 需要 `yalc push` |

**清理**

```bash
# 消费方移除 yalc 安装的包，恢复 package.json
yalc remove @q1875759084/monitor
npm install
```

`.yalc/` 目录和 `yalc.lock` 文件需要加入 `.gitignore`，不应提交到仓库。

---

## 监控 SDK 的多环境上报设计

### 三层概念容易混淆

接入监控 SDK 时，涉及三个看起来相似、实则完全独立的概念：

| 层 | 变量 | 回答的问题 | 谁维护 |
|---|---|---|---|
| 部署环境标识 | `DEPLOY_ENV` | 代码跑在哪台服务器 | CI/CD 平台构建时注入 |
| SDK 上报行为 | `MonitorEnv` | 要不要上报 | SDK 内部判断 |
| 上报目标地址 | `reportUrl` | 数据写到哪个库 | 业务薄封装（`utils/monitor.ts`）配置 |

三层正交，互不干扰。

---

### DEPLOY_ENV：真实的部署环境

由 CI/CD 在构建时通过 webpack `DefinePlugin` 注入，业务代码通过 `__DEPLOY_ENV__` 读取：

```
dev         → 本地开发机（npm run dev，未注入时的默认值）
test        → 测试服务器，QA 验功能
production  → 生产服务器，真实用户访问
```

这是**业务概念**，SDK 不认识它，也不应该认识它。

---

### MonitorEnv：SDK 的上报行为开关

SDK 里的 `MonitorEnv = 'development' | 'staging' | 'production'`，**不是环境的名字，是上报行为的分类**，实际只有两档：

```
'development'  →  不上报（本地开发，噪音多，没有意义）
'staging'      →  正常上报
'production'   →  正常上报（行为与 staging 完全一致）
```

`staging` 和 `production` 的上报行为在当前 SDK 实现中**没有任何差别**，都走正常上报逻辑。SDK 提供两个值是为了语义区分，方便调用方表达「我在测试环境」还是「我在生产环境」，为将来可能的差异化处理预留扩展点（比如生产环境采样率降低）。

这就是为什么 `test`、`beta` 等业务环境都可以映射到 `'staging'`——它们的上报需求相同（正常上报），SDK 不需要知道具体叫什么名字。

```ts
// utils/monitor.ts 中的映射
const ENV_MAP: Record<string, MonitorEnv> = {
  dev:        'development',  // 不上报
  test:       'staging',      // 正常上报
  production: 'production',   // 正常上报
  // 未来新增 beta 环境：加一行即可，SDK 不需要动
  // beta:    'staging',
};
```

---

### reportUrl：数据隔离的真正手段

数据隔离**不靠 MonitorEnv 区分，靠 reportUrl 指向不同的服务器实例**。

monitor-backend 使用 SQLite（进程内嵌入式数据库），数据库文件跟随 Node.js 进程走。不同服务器上各自运行一个 monitor-backend 实例，物理上就是两个独立的 `.sqlite3` 文件，天然隔离，无需额外配置。

```
test 服务器
  nginx: /monitor/collect → localhost:3100（test 的 monitor-backend）
                                └── test.sqlite3

production 服务器
  nginx: /monitor/collect → localhost:3100（production 的 monitor-backend）
                                └── production.sqlite3
```

前端的 `reportUrl` 路径可以完全一致（都是 `/monitor/collect`），靠**不同域名/服务器**区分打到哪个实例，后端本身不感知环境差异。

---

### 完整数据流

```
本地开发
  DEPLOY_ENV=dev
    → MonitorEnv='development' → 不上报，console 打印
    → reportUrl 无意义（不会发请求）

测试服务器
  DEPLOY_ENV=test
    → MonitorEnv='staging'    → 正常上报
    → reportUrl='/monitor/collect' → test 服务器 nginx → test 的 monitor-backend → test.sqlite3

生产服务器
  DEPLOY_ENV=production
    → MonitorEnv='production' → 正常上报
    → reportUrl='/monitor/collect' → production 服务器 nginx → production 的 monitor-backend → production.sqlite3
```

---

### 与 MySQL 等独立数据库的对比

SQLite 是进程内嵌入式数据库，数据文件跟随进程，不是独立的数据库服务。

| | SQLite | MySQL/PostgreSQL |
|---|---|---|
| 进程模型 | 嵌入在应用进程里 | 独立服务进程 |
| 多环境隔离 | 天然隔离（不同服务器→不同文件） | 需要手动建不同 database/schema |
| 数据持久化 | Docker Volume 挂载文件 | 连接独立数据库服务 |

使用 SQLite 的项目，只要部署在不同服务器/容器上，数据隔离就自动成立，省去了 MySQL 方案中手动管理多个 database 的步骤。

---

## error.ts 设计决策

### 职责定位：灾难级错误的兜底网 —— 白屏级

`error.ts` 监听的是**逃逸到 `window` 的未处理错误**——没有任何业务代码接住它们，页面通常已经白屏或功能完全失效。这是被动兜底，不是主动采集。

```
能被 error.ts 捕获：
✅ 未被 try/catch 包裹的运行时错误（TypeError、ReferenceError）
✅ 未被 .catch() 处理的 Promise rejection
✅ 图片 / 脚本 / 样式资源 404

不能被 error.ts 捕获：
❌ axios/fetch 请求失败（被拦截器 catch，变成"已处理的 rejection"）
❌ React ErrorBoundary 捕获的渲染错误（被 React 拦截，不冒泡到 window）
❌ 业务 try/catch 内部处理的错误
```

**这两类盲区不是 error.ts 的设计缺陷，而是职责边界。** 接口错误和 ErrorBoundary 捕获的错误属于"业务代码已知但需要上报"的场景，由 `trackError`（将在 track.ts 中实现）负责主动上报。

### 两层错误监控的分工

```
error.ts（被动兜底）         trackError（主动上报）
─────────────────────       ─────────────────────────────
window 逃逸的未处理错误  VS  业务代码捕获后主动调用
通常已导致白屏            VS  降级处理后仍在运行
消防报警器（出事才响）    VS  安全巡检记录（主动发现）
```

企业级监控（Sentry、字节 RUM）都是这两层并存，缺一不可：
- 只有 `error.ts`：接口失败、表单报错、ErrorBoundary 内的错误全部不可见
- 只有 `trackError`：开发者忘记埋点的路径漏报，灾难性崩溃无兜底

### 监听三类错误的实现细节

#### JS 运行时错误（`window.addEventListener('error')`）

```ts
window.addEventListener('error', (event: ErrorEvent) => {
  if (event.message !== undefined) {
    handleJsError(config, event)
  }
})
```

`event.message !== undefined` 用于区分 JS 错误（`ErrorEvent`，有 `message` 字段）和资源错误（普通 `Event`，无 `message`）。两者都触发 `window error`，通过这个字段区分处理目标。

跨域脚本（CDN 加载的第三方 JS）出错时，浏览器出于安全限制，`message` 固定为 `"Script error."`，`filename / lineno / stack` 全部为空。无法获取详情，但数量统计仍有意义（可发现第三方依赖异常）。

#### 资源加载错误（capture 阶段）

```ts
window.addEventListener('error', (event: Event) => {
  handleResourceError(config, event)
}, true)  // ← capture 阶段，这个 true 至关重要
```

资源加载失败（`<img>`、`<script>`、`<link>` 等）触发的 `error` 事件**不冒泡**，只能在 capture 阶段（从 window 向下传播时）拦截。如果不加 `true`，资源错误完全监听不到。

通过 `event.target.tagName` 过滤，只处理资源类元素，避免与 JS 错误处理逻辑重叠。

#### 未处理的 Promise 异常（`unhandledrejection`）

```ts
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  handleUnhandledRejection(config, event)
})
```

`event.reason` 可能是 Error 对象、字符串或任意值（`reject(42)` 这类写法），需要分情况提取 `message` 和 `stack`。

**注意**：axios、fetch 等网络请求失败**不会**触发 `unhandledrejection`，因为业务代码通常用 `try/catch` 或 `.catch()` 处理了，rejection 已被消费，不是"未处理的"。

### 错误去重：防止循环错误打满 rate-limit

同一条错误在页面生命周期内可能触发成百上千次（如渲染循环里的 `TypeError`）。不做去重会在短时间内触发大量上报，既无意义又打满 rate-limit 配额（120次/分钟）。

```ts
const reportedErrors = new Set<string>()

// 指纹 = message + filename + lineno，相同指纹只上报一次
const fingerprint = makeFingerprint(message, filename, lineno)
if (reportedErrors.has(fingerprint)) return
reportedErrors.add(fingerprint)
```

使用 `Set` 而非 LRU 缓存：页面生命周期有限，Set 不会无限膨胀，实现简单且够用。

### trackError：手动上报 API

`trackError` 是 `error.ts` 对外暴露的手动上报函数，用于补充自动捕获覆盖不到的盲区：

```ts
// index.ts 统一导出
export { trackError } from './error'

// 消费方使用
import { trackError } from '@q1875759084/monitor'
trackError(error, { componentStack })
```

#### 两类盲区的接入示例

**1. React ErrorBoundary**
```tsx
componentDidCatch(error: Error, info: React.ErrorInfo) {
  trackError(error, { componentStack: info.componentStack })
}
```

**2. axios 响应拦截器**
```ts
// request.ts 里，API 返回非 200 时
trackError(new Error(`API ${url} failed: ${code}`), { url, code, message })
```

#### 为什么 trackError 不走去重

自动捕获需要去重，是因为循环错误会被 `window.onerror` 触发成百上千次。但 `trackError` 是业务层主动调用的，已经在 `try/catch` / `componentDidCatch` 里，业务代码本身控制了调用时机，不会循环触发。

此外，不同调用点的 `props` 可能不同（同一个 Error 在不同 ErrorBoundary 层级捕获，`componentStack` 不一样），去重反而会丢数据。

#### `_config` 的设计：跨越时间边界的参数传递

`trackError` 不接收 `config` 参数，依赖模块级变量 `_config`：

```ts
let _config: MonitorConfig | null = null

export function initError(config: MonitorConfig): void {
  _config = config   // 初始化时保存
  // ...注册 window 监听器
}

export function trackError(error: Error | string, props?: Record<string, unknown>): void {
  if (!_config) return  // 未初始化时静默失败
  enqueue({ appKey: _config.appKey, ... })
}
```

**为什么必须用模块级变量，而不是每次传 config：**

`init()` 在应用启动时同步执行，此时 config 可用。但 `trackError` 是运行时任意时刻被调用的公共 API，config 早已离开调用栈。两个时间点之间需要一个持久存储桥接——模块级变量就是这个桥。

```
应用启动
  init(config)
    initError(config)  →  _config = config（持久化）
    注册 window 监听器  →  回调通过闭包访问 config ✓
    
（用户操作，若干秒后...）

window.onerror 触发   →  浏览器回调，无法传 config，通过 _config 读取 ✓
trackError(error)     →  业务层调用，签名不含 config，通过 _config 读取 ✓
```

`reporter.ts` 的 `let config` 是同样的模式：`initReporter(config)` 保存一次，`enqueue()` 运行时随时读。这是 SDK 中处理"初始化时配置，运行时使用"场景的标准做法。

**未初始化时静默失败**（`if (!_config) return`）：监控上报不是核心链路，在 `init()` 前意外调用 `trackError` 不应抛异常影响业务。

#### `_config` 为何不被垃圾回收

JS 引擎的 GC 基于**可达性**判断：从根对象（`window`、调用栈等）出发能访问到的对象不会被回收。`_config` 的可达链路如下：

```
window（GC 根，标签页存在就不会被回收）
  └── window.addEventListener 注册的回调
        └── 回调所在的模块（error.ts）
              └── 模块顶层变量 _config  ← 始终可达
```

只要 `window` 上的监听器还在，整个 `error.ts` 模块就是可达的，`_config` 就不会被回收。直到标签页关闭、JS 运行时销毁，才连同 `window` 一起释放。

这也解释了为什么不需要手动清理：页面生命周期内 `_config` 本来就应该一直存在，SPA 中没有"部分卸载 SDK"的场景。

#### 模块单例模式

`_config` 是**模块单例**的典型实现——ES 模块无论被 `import` 多少次，只执行一次，模块级变量全局只有一份：

```ts
// error.ts 被 import 10 次，_config 也只有一个
let _config: MonitorConfig | null = null
```

对比经典的 Class 单例写法，模块单例更简洁，不需要 `getInstance()` 样板代码，是 JS/TS 生态中的惯用模式。

**同类设计在其他知名项目中的应用：**

- **React 调度器（`react-reconciler`）**：`ReactCurrentDispatcher.current` 是模块级变量，React 在 render 阶段将其切换为包含 `useState`/`useEffect` 实现的对象，在其他阶段切换回报错版本。Hooks 调用时通过读这个模块变量获取当前调度器——和 `_config` 一样，是跨越调用栈边界传递上下文的桥梁。

- **Redux `createStore`**：返回的 store 对象持有 `currentState`、`listeners` 等模块内部变量，外部通过 `getState()`/`subscribe()` 闭包访问，本质也是模块级单例状态。

- **`axios` 实例**：`axios.create()` 返回的实例持有 `defaults` 配置，拦截器链通过闭包访问，整个应用共享同一份配置。

**面试角度的价值**：

能把"一个模块级变量"讲清楚，需要串联三个知识点——ES 模块的加载机制（只执行一次）、GC 的可达性算法（为何不被回收）、设计模式（单例）。这三个知识点单独问都是常规题，能在一个具体实现里把它们联系起来，是理解深度的体现。

---

## traceId 链路设计

### 设计目标

接口错误上报时，仅知道"哪个接口失败了"还不够——同一个接口在不同的请求上下文里可能有不同的失败原因。`traceId` 的作用是将**前端的一次请求**和**后端对应的处理日志**关联起来，便于联调和排查。

### 完整链路

```
前端请求拦截器
  生成 traceId（nanoid / uuid）
  写入请求头 X-Trace-Id: <traceId>
  挂到 config.metadata.traceId 供后续取用
        ↓
后端中间件
  从请求头读取 X-Trace-Id
  写入后端日志（与业务日志绑定）
  原样写回响应头 X-Trace-Id: <traceId>
        ↓
前端响应拦截器（错误分支）
  优先读 error.config.metadata.traceId（前端自己生成的，一定有）
  降级读 error.response.headers['x-trace-id']（网关覆盖的情况）
  调用 trackError(error, { traceId, url, method, status })
```

### 为什么由前端生成而非后端/网关生成

- **网关生成写入响应头**：请求头里没有 traceId，前端日志和后端日志无法在请求发出前就关联；请求失败时响应可能不存在，traceId 丢失。
- **前端生成写入请求头**：traceId 在请求发出时就确定，无论请求成功失败，前端都能从 `config.metadata` 取到，后端也能从请求日志中看到同一个 traceId。

### bizAxios SDK 设计

`traceId` 的注入不应由各业务项目手动处理，而应封装在 `bizAxios` 请求库 SDK 中。原因：

1. **防止遗漏**：业务开发人员轮换后，新人可能不了解每个请求都需要加 traceId 的约定
2. **职责清晰**：traceId 是基础设施关心的事，不是业务逻辑

```typescript
// bizAxios/src/interceptors.ts

// 请求拦截器：生成并注入 traceId
instance.interceptors.request.use((config) => {
  const traceId = nanoid(16);
  config.headers['X-Trace-Id'] = traceId;
  (config as any).metadata = { traceId }; // 挂在 config 上，响应时取用
  return config;
});

// 响应拦截器：错误分支上报
instance.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const traceId =
      (error.config as any)?.metadata?.traceId          // 优先：前端自己生成的
      ?? error.response?.headers?.['x-trace-id'];       // 降级：后端/网关回写的

    trackError(error, {
      traceId,
      url: error.config?.url,
      method: error.config?.method,
      status: error.response?.status,
    });

    return Promise.reject(error);
  }
);
```

### 职责边界：bizAxios 与 monitor 的关系

`bizAxios` **不应**自己调用 `monitor.init()`，初始化由业务项目负责：

```
业务项目
  ├── monitor.init({ appKey, env })   ← 业务负责初始化
  └── bizAxios.create({ baseURL })    ← bizAxios 只是 monitor 的使用方
```

`trackError` 内部有 `if (!_config) return` 守卫，若 monitor 未初始化则静默跳过，不会导致崩溃。两个 SDK 通过"约定初始化顺序"解耦，而非由 bizAxios 强制拉起 monitor。

### bizAxios 是否需要前后端双包

| 场景 | 建议 |
|---|---|
| 后端是 Node.js，需要共享 `TraceContext`、`ApiResponse<T>` 等 TS 类型 | 适合做 monorepo 双包 |
| 后端只需要"读请求头 + 写响应头 + 写日志"这一薄层逻辑 | 以文档约定代替独立包，成本更低 |

当前阶段后端部分很薄，不值得单独维护一个 npm 包。后端只需遵守约定：**读取 `X-Trace-Id` 请求头，原样写回响应头，并将其注入到日志上下文中**。

---

## appKey 与 reportUrl 的数据隔离机制

### 独立应用（不同子域名）

每个应用部署在各自的子域名下，`reportUrl` 使用同域相对路径，展开后天然指向各自的服务器：

```
video.xxx.com/monitor/collect
  → video 服务器的 nginx → video 的 monitor-backend

security.xxx.com/monitor/collect
  → security 服务器的 nginx → security 的 monitor-backend
```

代码中两个项目的 `reportUrl` 字符串写的都是 `/monitor/collect`，**看起来一样，实际请求打到了不同的服务器**——隔离在部署层（nginx + 服务器）完成，不依赖代码层的差异。

此时 `appKey` 的作用是**标识来源**（日志里知道是哪个应用上报的），而不是隔离手段。

### 微前端（同一域名）

多个子应用部署在同一域名下，所有上报请求展开后指向同一个 monitor-backend：

```
app.xxx.com/video    （video 子应用）
app.xxx.com/security （security 子应用）

两者的 reportUrl 展开后都是：
https://app.xxx.com/monitor/collect → 同一个 monitor-backend
```

数据存在同一个 SQLite 里，此时 **`appKey` 是唯一的隔离手段**：

```sql
-- 查 video 子应用的数据
SELECT * FROM monitor_events WHERE app_key = 'video-to-audio';

-- 查 security 子应用的数据
SELECT * FROM monitor_events WHERE app_key = 'security-quiz-game';
```

因此微前端场景下，每个子应用**必须有独立且语义明确的 `appKey`**，不能共用同一个值，否则无法区分数据归属。

### 总结

| 部署方式 | 隔离手段 | appKey 的作用 |
|---|---|---|
| 独立应用（不同子域名） | nginx + 不同服务器 | 标识来源，辅助定位 |
| 微前端（同一域名） | appKey 字段过滤 | 唯一隔离手段，不可重复 |

---

## monitor-backend 路由前缀与 nginx 转发设计

### 为什么不用 /api/collect 而用 /monitor/collect

`/api` 通常是业务后端的专属前缀，nginx 中一般有：

```nginx
location /api/ {
    proxy_pass http://localhost:3030;  # 业务后端
}
```

如果 monitor-backend 也使用 `/api/collect`，nginx 就必须把这条规则单独提前，否则会被业务后端拦截——**运维层的隐患，且不直观**。

使用独立前缀 `/monitor/` 可以避免歧义：

```nginx
location /api/ {
    proxy_pass http://localhost:3030;   # 业务后端
}

location /monitor/ {
    proxy_pass http://localhost:3100;   # monitor-backend（独立进程，独立端口）
}
```

语义上一眼可以区分，运维配置也更清晰。

### nginx proxy_pass 的端口号与进程的关系

nginx 的 `proxy_pass` 端口号对应的是**后端进程监听的端口**，不同进程监听不同端口：

```
浏览器 → nginx:443（统一入口）
            ├─ /api/*     → proxy_pass localhost:3030（业务后端进程）
            └─ /monitor/* → proxy_pass localhost:3100（monitor-backend 进程）
```

两个 `proxy_pass` 端口不同是必然的——它们是两个独立进程，不可能共享同一个端口。

### monitor-backend 的两种部署方案

以 `video.xxx.com` 和 `security.xxx.com` 为例，两者都需要上报到 `/monitor/collect`，但 monitor-backend 是共享还是独立是一个部署架构选择：

**方案一：各业务独立一个 monitor-backend 实例**

```
video.xxx.com/monitor/collect → video 服务器 nginx → localhost:3100（video 专属）
security.xxx.com/monitor/collect → security 服务器 nginx → localhost:3100（security 专属）
```

数据物理隔离（不同进程 / SQLite 文件），但每新增一个业务就要多维护一个容器。

**方案二：共享单个 monitor-backend 实例（推荐）**

nginx 的 `proxy_pass` 可以指向任意 IP，不限于 `localhost`：

```nginx
# video 服务器的 nginx
location /monitor/ {
    proxy_pass http://monitor.internal:3100;  # 指向专用监控服务器
}

# security 服务器的 nginx（相同配置）
location /monitor/ {
    proxy_pass http://monitor.internal:3100;  # 同一台监控服务器
}
```

所有业务的上报数据汇聚到一个 monitor-backend，靠 `appKey` 区分来源，**只需维护一个容器**。

| | 方案一：各自独立 | 方案二：共享单实例 |
|---|---|---|
| 隔离级别 | 物理隔离（不同进程/文件） | 逻辑隔离（同库不同 appKey） |
| 运维成本 | 每新增一个业务多一个容器 | 只维护一个容器 |
| 数据查询 | 各查各的 | 统一查询，跨应用对比方便 |
| 适用场景 | 对数据隔离有严格要求 | 个人项目、小团队 |

个人项目推荐方案二：monitor-backend 独立部署在一台服务器，各业务 nginx 统一往那里转发，`appKey` 做逻辑隔离。

---

## npm 发包流程与 SDK 工程化

### SDK 与业务仓库的本质区别

业务仓库（video-to-audio、carry-hub 等）的产物是**部署到服务器的静态资源**，`dist/` 不进 git，构建只在 CI/CD 或本地发布时发生一次。

SDK 仓库（monitor）的产物有**双重作用**：

| 产物 | 作用 |
|---|---|
| `src/`（源码） | 版本管理、Code Review、本地开发调试（`file:../monitor`） |
| `dist/`（编译产物） | npm 发包的实际内容，业务项目安装后直接使用，**不需要再编译 SDK 的源码** |

因此 SDK 的 `dist/` **必须提交到 git 或在发包前 build**，且 `package.json` 的 `files` 字段只包含 `dist`，源码不发布到 npm：

```json
"files": ["dist"]   // npm pack 只打包 dist 目录，src/ docs/ 等不上传
```

### 首次发包流程（手动）

```bash
# 1. 登录 npm
npm login

# 2. 确认包名与 npm 用户名的 scope 匹配
#    包名：@cmjndy/monitor，scope 必须是已有用户名或 Organization
#    错误示例：@q1875759084/monitor → scope 不存在 → 404 Scope not found

# 3. 构建产物
npm run build

# 4. 发布（scoped 包默认 private，必须加 --access public）
npm publish --access public
```

**关于 npm Token**：账号开启了 2FA 或使用 Granular Access Token 时，直接 publish 会报 `E403`。解决方式是在 npm 网站生成 **Granular Access Token** 并勾选 **Bypass 2FA**，然后：

```bash
npm config set //registry.npmjs.org/:_authToken YOUR_TOKEN
npm publish --access public
```

### 后续版本发布

每次修改 SDK 后，遵循语义化版本（Semantic Versioning）：

```bash
npm version patch   # 0.1.0 → 0.1.1，bug 修复
npm version minor   # 0.1.0 → 0.2.0，新增功能（向下兼容）
npm version major   # 0.1.0 → 1.0.0，破坏性变更

npm run build
npm publish --access public
```

`npm version` 会自动修改 `package.json`，并创建一个 git tag（如 `v0.2.0`）。

业务项目升级 SDK：

```bash
npm install @cmjndy/monitor@latest
# 或指定版本
npm install @cmjndy/monitor@0.2.0
```

### 本地开发阶段用 file: 协议

发布到 npm 之前（或修改 SDK 后未发版），业务项目通过 `file:` 协议直接引用本地路径：

```json
"@cmjndy/monitor": "file:../monitor"
```

每次修改 SDK 源码后需要重新 build，然后在业务项目重新安装：

```bash
# monitor 目录
npm run build

# 业务项目目录
npm install
```

`file:` 引用的是本地 `dist/` 产物（受 `package.json` 的 `files` 字段控制），不是直接读源码。

### CI/CD 接入的可行性

当前是手动发包，后续可接入 GitHub Actions 实现自动化：

```yaml
# .github/workflows/publish.yml（示意）
on:
  push:
    tags:
      - 'v*'          # 推送 v0.2.0 等 tag 时触发

jobs:
  publish:
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}  # token 存在 GitHub Secrets
```

流程：本地改代码 → `npm version minor` 生成 tag → `git push --tags` → CI 自动 build + publish，无需手动操作。`NPM_TOKEN` 存在 GitHub 仓库的 Secrets 里，不暴露在代码中。

### npm 如何识别"发的是哪个包"

`npm publish` 时，registry 完全依赖当前目录 `package.json` 的两个字段：

```
name    → 确定包的身份（全 registry 唯一命名空间）
version → 确定版本（同一包的同一版本只能发一次，不可覆盖）
```

识别链：

```
npm publish（在 monitor/ 目录执行）
  → 读 ./package.json → name: "@cmjndy/monitor", version: "0.1.1"
  → 向 registry 发请求
  → registry 按 name 找到对应包的命名空间
  → 按 version 检查是否已存在（存在则报错 E403 "cannot publish over existing version"）
  → 不存在则将 dist/ 内容挂在 @cmjndy/monitor@0.1.1 下
```

`npm version patch` 只做两件事，不访问网络：
1. 修改 `package.json` 的 `version` 字段（`0.1.0` → `0.1.1`）
2. 创建 git commit + tag（`v0.1.1`）

真正"告诉 npm 这是哪个包、哪个版本"的是随后 `npm publish` 时读取的 `package.json`。只要在正确目录下执行，就不会混淆。

### 镜像源与多 registry 路由

#### 使用淘宝镜像能找到 npmjs 的包吗

取决于镜像源的类型：

| 镜像源类型 | 能否找到 npmjs 的包 |
|---|---|
| 代理镜像（淘宝 npmmirror、Nexus/Verdaccio 配了 upstream） | ✅ 能，镜像会回源到 npmjs 拉取 |
| 完全私有 registry（无 upstream，只有内部包） | ❌ 不能，404 |

淘宝镜像（`registry.npmmirror.com`）是代理镜像，所有 npmjs 上的包都会被同步或按需回源，`@cmjndy/monitor` 可以正常安装。企业私有 registry 通常也配置了指向 npmjs 的 proxy，除非公司明确禁止外网包。

#### 依赖来自多个 registry 时如何路由

npm 的规则：**项目只有一个默认 registry**，但可以通过 `.npmrc` 给特定 scope 配置独立的 registry：

```ini
# .npmrc
registry=https://registry.npmmirror.com      # 默认：所有无 scope 的包走淘宝镜像

@cmjndy:registry=https://registry.npmjs.org  # @cmjndy scope → 走官方 npm
@company:registry=https://npm.company.com    # @company scope → 走公司私有源
```

安装时 npm 按 scope 路由：

```
npm install @cmjndy/monitor  → scope @cmjndy → registry.npmjs.org
npm install @company/ui      → scope @company → npm.company.com
npm install axios            → 无 scope      → 默认 registry.npmmirror.com
```

**这也是企业 SDK 都用 `@scope/package-name` 命名的原因之一**——scoped 包可以精确路由到对应 registry，无 scope 的包只能走默认源，无法针对性配置。

#### 当前项目的配置建议

在 `video-to-audio/` 目录加 `.npmrc`，确保 `@cmjndy` 的包始终走官方 npm：

```ini
@cmjndy:registry=https://registry.npmjs.org
```

其他依赖继续走项目或系统默认的 registry，互不影响。
