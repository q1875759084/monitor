# track.ts —— 行为埋点模块

## 职责

- **PV 自动上报**：页面首次加载 + SPA 路由切换（pushState / replaceState / popstate）全量覆盖
- **trackEvent 手动埋点**：业务侧主动上报自定义事件（按钮点击、搜索、表单提交等）

---

## 关键设计决策

### PV 自动采集的覆盖范围

浏览器原生事件只能覆盖前进/后退（`popstate`），SPA 通过 `pushState` / `replaceState` 进行的路由跳转不触发任何事件。`track.ts` 通过 patch 这两个方法补全覆盖：

```
首次加载           → 直接调用 reportPV()
pushState 跳转    → patch 后派发 spa_navigation 事件 → reportPV()
replaceState 跳转  → 同上
浏览器前进/后退    → popstate 事件 → reportPV()
```

### patchHistory 的实现方式：装饰器模式

```typescript
const patchMethod = (original) => function(...args) {
  const result = original.apply(this, args)           // ① 先执行原始逻辑，功能不丢失
  window.dispatchEvent(new Event('spa_navigation'))   // ② 追加监控行为
  return result
}
history.pushState = patchMethod(history.pushState)
history.replaceState = patchMethod(history.replaceState)
```

通过闭包保住 `original` 引用，新函数先还原原始行为再扩展，原始功能完整保留。

patch 内部触发自定义事件 `spa_navigation` 而非直接调用 `reportPV`，目的是职责解耦——patch 只负责"通知路由发生了变化"，`initTrack` 内部负责监听并决定如何响应。

---

## 初始化时序

### 为什么 monitor.init() 必须是入口文件的第一行

`patchHistory` 依赖一个前提：**在 `history.pushState` 被任何其他代码保存引用之前完成 patch**。

React Router 内部使用 [`history`](https://github.com/remix-run/history) 库，该库在**实例化时**就把 `window.history.pushState` 的引用固定下来：

```js
// history 库内部（简化）
const globalHistory = window.history
// 此后路由跳转调用的是 globalHistory.pushState 这个固定引用
// 而不是每次重新读取 window.history.pushState
```

这意味着如果 monitor 在路由库实例化之后才 patch，路由库拿着的仍是 patch 前的原始引用，之后的路由跳转不会触发 `spa_navigation`，PV 上报会全部丢失。

"我在做 PV 自动采集时，发现 React Router 在初始化时就把 pushState 的引用固定了，所以 SDK 必须在路由库之前执行——这让我深入理解了 JS 引用语义和模块执行顺序" 

**正确的调用时序**：

```
main.tsx / index.tsx
  │
  ├─ 1. monitor.init()                 ← 必须第一行
  │       └─ initTrack()
  │            └─ patchHistory()
  │                 history.pushState  = 装饰器版本（闭包持有 original）
  │                 history.replaceState = 装饰器版本
  │
  ├─ 2. ReactDOM.createRoot(...).render(<App />)
  │
  └─ 3. <BrowserRouter> / createBrowserRouter 挂载
              └─ history 库初始化，保存 window.history.pushState 的引用
                   └─ 此时读到的已经是装饰器版本 ✅
```

**错误的调用时序**（PV 丢失）：

```
main.tsx
  │
  ├─ 1. ReactDOM.createRoot(...).render(<App />)
  │
  ├─ 2. <BrowserRouter> 挂载
  │       └─ history 库保存了原始 pushState 的引用 ← 固定了，后续 patch 无效
  │
  └─ 3. monitor.init()    ← 太晚，路由库已经拿着旧引用了
```

### 与路由库不冲突

monitor patch 执行后，`history.pushState` 指向包裹函数，包裹函数第一步将参数原封不动地传给原始方法，路由库感知不到任何差异：

```
React Router 调用 history.pushState(state, '', '/goods/123')
  → monitor 包裹函数
      ① original.apply(this, [state, '', '/goods/123'])  ← 路由跳转正常发生
      ② dispatchEvent('spa_navigation')                  ← monitor 追加上报
  → 返回原始方法的返回值（路由库无感）
```

### popstate 触发时 location 是否已更新

以浏览器后退为例（history 栈为 `/b → /a`，当前在 `/a`，点击后退）：

```
用户点击后退
    ↓
浏览器修改 location（/a → /b）   ← 先变
    ↓
触发 popstate 事件               ← 后通知
    ↓
回调执行，location.pathname === '/b'  ✅
```

`popstate` 的语义是"导航**已经发生**，通知你现在在哪"，而不是"导航**即将发生**"。回调执行时 `location` 已经是目标地址，`reportPV` 读到的是正确的跳转后 URL。

`pushState` / `replaceState` 同理——`original.apply` 执行完后 `location` 立即变为目标地址，随后我们才 `dispatchEvent('spa_navigation')`，所以三条路径读到的都是跳转后的目标地址：

| 触发方式 | location 状态 |
|---|---|
| 首次加载 | 当前页面地址 ✅ |
| `pushState` → `spa_navigation` 回调 | `original.apply` 执行后地址已变 ✅ |
| `popstate` 回调 | 事件触发前地址已变 ✅ |

### 微前端场景的多层 patch 链

qiankun / wujie 等微前端框架同样会 patch `pushState` 以隔离子应用路由，与 monitor 形成多层包裹链：

```
（主应用初始化时）
monitor patch → 原始 pushState

（qiankun 子应用挂载时）
qiankun patch → monitor patch → 原始 pushState
```

只要每一层都遵循"先调上一层、再做自己的事"约定，链条就不断。**真正的风险**是某一层用 `Object.defineProperty` 将属性锁定为不可写，导致后续 patch 静默失败——主流框架均未这样做。

**子应用卸载时的已知待完善点**：当前 `initTrack` 没有返回 `destroy` 函数，子应用卸载后全局 `history.pushState` 仍指向包裹函数，`_config` 也保留在内存中。对普通 SPA 无影响；微前端场景需要 `initTrack` 返回 cleanup 函数并在子应用 `unmount` 时调用，当前不受影响，留作后续增强点。

---

## url 与 path 的分层记录

```typescript
enqueue({
  ...
  url: location.href,         // 完整 URL（含 query），还原用户实际进入的路径
  props: {
    path: location.pathname,  // 纯路径，后端按此字段聚合 PV，无需在 SQL 里截取
    referrer: document.referrer,
  }
})
```

高基数字段（含 query 的完整 URL）放在 `url`，用于溯源；低基数字段（pathname）放在 `props.path`，用于聚合统计。避免将带 query 的完整 URL 直接用于 GROUP BY，否则同一页面会因参数不同被拆散成无数行。

---

## trackEvent 不去重

与 `error.ts` 中手动上报 `trackError` 的设计保持一致：业务主动埋点不存在循环触发的问题，且同名事件代表真实的多次行为（如多次点击），去重会丢数据。
