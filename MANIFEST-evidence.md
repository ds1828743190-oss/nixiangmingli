# 取证归档清单（MANIFEST-evidence）

本文件记录**未纳入版本控制**的抓取产物，便于追溯与校验。它们仍在本机，并有单独归档。

> 这些是从 FateTell / FateMaster.AI 抓取的第三方资源（JS bundle、DOM、截图、网络响应），
> **仅供个人研究，不要再分发**。理由与边界见 [NOTICE.md](NOTICE.md)。

## 总量

- 文件数：**925**
- 体积：**246.5 MiB**（约 259 MB）

## 分目录

| 目录 | 文件数 | 体积 (MiB) | 主要类型 |
|---|---|---|---|
| `reverse/fatetell/raw` | 163 | 143.6 | .js×57, .txt×50, .json×33, .err×10, .ndjson×4 |
| `reverse/fatemaster/raw` | 600 | 89.0 | .js×301, .txt×151, .json×72, .html×21, .bin×17 |
| `reverse/logged-in/raw` | 162 | 14.0 | .(none)×79, .js×35, .json×21, .txt×8, .png×8 |

## 关键文件摘要（sha256，便于校验你手上那份是否同一批）

| 文件 | 体积 (MiB) | sha256 |
|---|---|---|
| `reverse/fatetell/raw/app-graph.json` | 93.1 | `1163fea60df2e968dba372d4b7d7b49e25f67b53c39a0a0796e1fbd277e9a00c` |
| `reverse/fatemaster/raw/app-graph-partial.json` | 18.8 | `01a67f129dbba9e976e5e48ea37691567cdf32cef1fd54ca2ad374a5196b3eaf` |
| `reverse/logged-in/raw/fatetell-chat.json` | 4.1 | `68bd276aa8b1ee258de28020ed841db147a8d7bd64e8fcd6d4080c5b3a6d4466` |
| `reverse/logged-in/raw/fatemaster-agent.json` | 3.4 | `1beec32bb6af622e341f9cddc7ce47abdb3cfb8b8b2ec79475cbf92555443c26` |

## 归档

```bash
# 取证归档（第三方资源，个人研究用，勿分发）
tar czf fatetell-fatemaster-evidence-<date>.tar.gz -C <workspace> reverse
```

代码与文档的可移植归档则由 `git archive` 生成（只含纳入版本控制的文件），见仓库根 `README.md`。
