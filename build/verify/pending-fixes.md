# 待应用的实现修复（验收未过的项）

来源：`build/verify/acceptance.mjs`（独立验收台）。契约依据：[PROTOCOL.md](../PROTOCOL.md) §5（幂等计费）、§6（同意/金额不变量）。
改动落在 `build/skeleton/`，在写入方停止写入后应用。

---

## 决策已定：Agent 需要登录（对齐现有测试与 SSE 路由）

骨架作者把"匿名不能用 Agent"**有意写进了两条测试**（`quota.test.mjs:51`、`e2e.test.mjs:177`），
而 SSE 路由对"无凭据"已经回答 `401 UNAUTHENTICATED`。所以真正的问题不是策略，而是**同一个条件给了两个答案**，
以及**快照谎报了可用额度**。保留作者策略，修掉矛盾——改动最小。

### 缺陷 1 — 快照与请求互相矛盾；两条 Agent 通道答案不一致

**实测**

```
POST /api/agent/chat  (无凭据) -> 403 {"code":"ANON_LIMIT_REACHED"}
POST /api/v3/demo/messages (无凭据) -> 401 {"code":"UNAUTHENTICATED"}     ← 同一条件，不同答案
GET  /api/access      (无凭据) -> {"agentTrial":{"limit":2,"used":0,"remaining":2,"hasRemaining":true}}   ← 谎报
```

**改动**

1. `src/server.mjs` → `agentChat()`：在解析 principal 之后、`quota.check` 之前加：

```js
const { principalId, anonymous } = resolvePrincipal(req);
if (anonymous) {
  // 与 SSE 通道同条件同答案：缺的是登录，不是额度。
  return sendError(res, 401, 'UNAUTHENTICATED', 'authentication required');
}
```

2. `src/quota.mjs` → `accessSnapshot()`：匿名主体不谎报 Agent 试用：

```js
if (a.anonymous) {
  return {
    hasSubscription: false, hasPurchase: false,
    accessType: null, signInRequired: true,
    accessEndDate: null, remainingTime: null,
    agentTrial: { limit: 0, used: 0, remaining: 0, hasRemaining: false },
  };
}
```

   `quota.check()` 对匿名的拒绝保持不变（store 层仍拒绝；HTTP 层现在根本走不到那里）。

3. `test/e2e.test.mjs:177`（`1b)` 那条）：期望值从 `403 / ANON_LIMIT_REACHED` 改为
   `401 / UNAUTHENTICATED`——测试名也要改成"匿名调用返回 401，与 SSE 通道一致"。
   `test/quota.test.mjs:51` 不必改（它测的是 store 层 `check()`，行为未变）。

**预期**：验收台的"匿名一致性"与"同状态码"两项转为 PASS；3 个 NDJSON 顺序断言改用登录主体后转为 PASS。

---

## 缺陷 2 — `request_id` 未幂等（会重复扣费并生成第二份不同回答）

**实测**

```
POST /api/v3/demo/messages {..., "request_id":"req-acceptance-1"}  -> x-message-id: msg_..._1
POST 完全相同（同一 request_id）                                    -> x-message-id: msg_..._2
```

**改动**

1. `src/stream-hub.mjs`
   - `createMessage()` 记录 `principalId`，`describe()` 一并返回；
   - 新增 `findByRequestId(channel, requestId)`；
   - 续传与重放都校验同一 principal，不匹配按 404（`messageId` 不是跨账号凭据）。
2. `src/server.mjs` → `chatMessages()`：在 **401 检查之后、额度检查之前**插入重放分支：

```js
const existing = requestId ? hub.findByRequestId(channel, requestId) : null;
if (existing && existing.principalId === principalId) {
  // 同一逻辑请求：回放，不新建、不再扣费、不再调模型。
  return chatResumeStream(req, res, channel, existing.messageId, new URL('http://localhost/?from_seq=0'));
}
```

   必须先于额度检查：原来那次已经付过费，此刻额度耗尽也必须能重放/续传。

**预期**：剩下 2 项转为 PASS → **23/23**。

---

## 已确认是测试自身的 bug（不必改实现）

| 失败用例 | 原因 |
|---|---|
| e2e `1) POST /api/agent/chat ...` | `assert.notMatch` 在 Node 里不存在 → `assert.doesNotMatch` |
| e2e `3) resume ...` | `assert.equal(part1.frames.length, 4)` 太脆（生产者太快时断开前已收满 29 帧）→ 按**实际收到的最大 seq** 作游标 |
| e2e `4) exhausting a limit ...` | 对 SSE 路由用了 `postJson()`（按 JSON 解析）→ `SyntaxError: Unexpected token 'd', "data: {"me"...`，应改流式读取 |
| stream-hub `unknown message and bad cursors ...` | 在**新建的空 hub** 上用另一个 `seeded()` 的 `messageId`，于是得到 `MESSAGE_NOT_FOUND` 而非 `INVALID_FROM_SEQ` |
| quota `resolvePrincipal ...` | 单独运行 11/11 通过；全量运行的失败待其它修复落地后复验（疑顺序/共享状态） |

文档修正：`node --test test/` 在 Node 24 会 `MODULE_NOT_FOUND`；正确用法是 `node --test` 或直接给文件路径。
