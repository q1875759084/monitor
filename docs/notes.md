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
