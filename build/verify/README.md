# verify/ — 独立验收

`acceptance.mjs` 是**独立于 `build/skeleton` 实现**的端到端验收脚本。独立性的具体含义：

| 维度 | 做法 |
|---|---|
| 进程 | 把骨架当作**独立进程**启动（`node src/server.mjs`），因此连它的启动入口一起验证 |
| 传输 | 真实 loopback HTTP（`fetch`），不调用实现内部的函数 |
| 解析 | NDJSON 与 SSE 解析**在本文件里手写**，刻意不复用 `src/frames.mjs` 的解析器——否则编码器的 bug 会被解码器的同一个 bug 掩盖 |
| 断言来源 | `build/PROTOCOL.md`，不是实现本身 |

运行：

```bash
NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
cd /Users/xiaolv/Documents/deepseek-harness/default-workspace
"$NODE" build/verify/acceptance.mjs     # 全通过时打印 ACCEPTANCE: PASS 并以 0 退出
```

## 覆盖的契约（27 项）

| # | 契约 | 断言要点 |
|---|---|---|
| 0 | `GET /api/access` | 返回 `agentTrial{limit,used,remaining,hasRemaining}`；limit 为正整数 |
| 1 | 确定性内核路径 | `POST /api/bazi-calculate` 返回四柱 Facts + 给模型看的 `narrationPrompt`；坏日期是**类型化 4xx** 而不是崩溃 |
| 2 | 通道 A（NDJSON） | `content-type: text/plain`；首帧 `conversation_id`；`reasoning` → `phase_change` → `content` 顺序；无 `error` 帧 |
| 3 | 通道 B（SSE） | `content-type: text/event-stream`；**第 1 帧之前**就给出 `x-message-id`；`seq` 单调 |
| 4 | **续传不变量** | 中途断开后 `?from_seq=N`：只返回 `seq > N`；从 `N+1` 开始（无缺口）；严格递增（无重复/乱序）；两段**互不相交**；以终止帧 + `[DONE]` 收尾 |
| 5 | **幂等计费** | 同一 `request_id` 重放：**同一个 `x-message-id`**，且额度**不再扣减** |
| 6 | 额度契约 | 额度耗尽返回**类型化 code + HTTP 状态**；`/api/access` 同步反映 `hasRemaining:false` |
| 7 | 鉴权边界 | 无凭据访问聊天流是 **401（去登录）**，不是 403（额度）——两者补救措施不同 |

第 4、5 项是这份骨架存在的理由：断线"接着写"而不是重生成，以及重试不重复扣费。

---

# kernel-crosscheck.mjs — 历法内核的独立交叉验证

日柱锚点是唯一一个错一处就静默污染所有命盘的常数。所以这份脚本**不复用内核的任何常量或对照表**：
期望值全部来自外部来源，把它们串起来的算术写在文件头注释里（可手算复核）。

| 来源 | 提供什么 |
|---|---|
| [Zenodo 中国历法公共数据集](https://zenodo.org/records/22820072)（CC BY 4.0）A3 资产 | **1949-10-01 = 甲子日**（原文注明"三源一致"，作者另用 4 条现代记载与《春秋》隐公三年交叉验证），覆盖 1900–2052 共 55,883 天 |
| [2000-01-01 老黄历](https://nongli.d777.com/2000-1-1) | **己卯年 丙子月 戊午日**，以及十二时辰完整八字：子时壬子 · 丑时癸丑 · 寅时甲寅 · 卯时乙卯 · 辰时丙辰 · 巳时丁巳 · 午时戊午 · 未时己未 · 申时庚申 · 酉时辛酉 · 戌时壬戌 · 亥时癸亥 |

两个来源**互相印证**：1949-10-01 到 2000-01-01 相隔 18354 天，`18354 mod 60 = 54`，
序号 54 → 天干 `54 mod 10 = 4` = 戊、地支 `54 mod 12 = 6` = 午 → **戊午**，与老黄历一致。

它还顺带钉住了三条只有多柱数据才能验证的规则：
- **年柱以立春为界**：2000-01-01 仍是己卯（若内核在 1 月 1 日换年就会错成庚辰）；
- **月干五虎遁**：己年子月为丙子（只验证月支是验证不出月干的）；
- **时干五鼠遁**：戊日子时为壬子。

运行（内核尚未实现时以 2 退出，并说明"无可验证对象"）：

```bash
"$NODE" build/verify/kernel-crosscheck.mjs
```

除锚点外还查四条结构性不变量：日柱逐日 +1 且 60 日回归（跨度 5 年）、十二时辰窗口、
年柱不在 1 月 1 日翻转、`computeFacts` 纯函数性。

## 已知的运行特性

- 端口取 `20000 + pid % 20000`，起服务后等待 stdout 的 `listening` 再发请求。
- 第 4 项的语义对"生产者速度"不敏感：脚本按**实际收到的最大 seq** 做游标，因此生成器太快（整段已完成）时仍然成立——不会像"必须正好收到 4 帧"那样脆弱。
- 脚本最后 `SIGTERM` 清理子进程；失败时以非 0 退出并列出失败项与实测值。
