# NOTICE — 归属、第三方来源与使用边界

## 本仓库中属于本项目原创的部分

- `build/` 下的全部代码与文档：骨架、历法内核（除下述系数表）、验证脚本、流程/协议/内容方案。
- `reverse/` 下的三份分析报告与两份汇总（`*.md`）：这些是**我们对公开信息的分析与结论**，
  不是对方的内容。报告内只引用了理解结论所必需的**短标识符**（端点路径、字段名、工具名等）。

## 第三方来源（已注明、未打包再分发）

| 内容 | 来源 | 处理方式 |
|---|---|---|
| **VSOP87D 地球级数系数** | 公开的 VSOP87D 副本（[docs.rs/stem-branch](https://docs.rs/stem-branch/0.1.0/src/stem_branch/vsop87d_earth.rs.html)，原始出自 Bureau des Longitudes 的 VSOP87 系列） | 用脚本**机械提取**为 `build/kernel/vsop87d-earth.mjs`（数值级数，属公开科学数据）。提取脚本与原始 JSON/HTML 留在 `build/kernel/.vsop/` 作为审计凭据 |
| **节气时刻对照表**（用于验证精度） | [日历网 2020–2035 二十四节气表](https://m.rili.com.cn/24jieqi/71169.html)、ljgw.cn 节气查询 | **仅在测试/审计中以引用形式使用**，未随仓库分发原始页面。出处见 `build/kernel/REFERENCES.md` 与 `build/verify/kernel-accuracy.md` |
| **Meeus《Astronomical Algorithms》** | 书籍 | 仅使用其公开的算法步骤（章动/光行差/开普勒求解），未复制其表格 |
| **REA（`rea-agents`）** | MIT 许可的第三方 npm 包 | **未 vendor**。本机曾用 `pnpm add rea-agents@6.4.0` 安装于 `rea/`，该目录被 `.gitignore` 排除；需要时自行安装 |

## 明确**未**纳入版本控制的内容

`reverse/**/raw/` 等抓取产物（JS bundle、DOM、截图、网络响应）——它们是从 FateTell / FateMaster.AI
抓取的**第三方资源**，属于对方的内容，**不适合再分发**。它们仍保留在本机，并有单独归档
（见 [`MANIFEST-evidence.md`](MANIFEST-evidence.md)），归档仅供**个人研究**使用，不要公开传播或再发布。

## 使用边界

- 本仓库的取证部分仅针对**公开可访问**的页面与公开 JS bundle；未登录、未付费、未绕过任何技术措施
  （登录态那一份为用户本人主动提供会话后的一次只读观察）。
- 若基于本仓库构建产品：**借鉴结构与协议可以，复制对方的文案、视觉素材、品牌与实现代码不可以**。
  具体边界见 [`build/PLAN.md`](build/PLAN.md) §0「可复用边界」。
- 命理类内容在多地属文化娱乐服务：上线前请自行完成免责声明、渠道规则（应用商店抽成与审查）
  与敏感个人信息（生辰）处理等合规工作。

## 免责

代码按"现状"提供，不含任何担保。历法计算的精度边界、以及尚未实现的部分（见各模块 `todos`
与 `build/verify/VERIFICATION.md`）均已如实标注；**请勿把本仓库的精度数字当作超出其测量范围的保证**。
