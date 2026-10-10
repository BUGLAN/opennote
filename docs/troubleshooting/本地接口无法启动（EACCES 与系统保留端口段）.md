# 排查：Opennote 在线，但本地接口起不来、`/opennote-ingest` 入不了库

> 记录时间：2026-10-10。适用平台：**Windows**。涉及：本地桥（`electron/bridge.cjs`）、
> 浏览器剪藏扩展、`opennote-ingest` 技能。
>
> 本文只写**能被命令复现**的事实；推断部分明确标注。

## 1. 症状

- Opennote 桌面版**正在运行**、窗口正常、设置里「开启本地导入接口」是打开的；
- 但 `/opennote-ingest` 用不了：
  - 默认（收件箱）通道 → `exit 5` · `IMP-4007`「无法确定要投进哪个笔记本」；
  - `--channel bridge` → `exit 3` · `IMP-1001`「连不上本地桥」。
- 设置面板的接口状态是「**启动失败**」，地址行是占位符 `—`。

**关键区分**：「应用在线」≠「本地接口在监听」。前者是窗口在，后者是一个 TCP 监听套接字在。
本项目里这是两件独立的事（`bridge.json` 的 `enabled` 是**用户偏好**，不是当前状态）。

## 2. 一句话根因

桥在 `127.0.0.1:8787` 上 `listen()` 被操作系统拒绝（`EACCES`），因为 `8787–8796`
整段落进了 **Windows 的系统保留端口段**；而这个保留段之所以能划到「常用应用端口区」，
是因为本机把 **TCP 动态端口范围**从默认的 `49152–65535` 改成了 `1024–15000`。

## 3. 取证（四条命令，逐条可复跑）

```powershell
# ① 系统保留端口段：看 8787–8796 是否落在某个段里
netsh int ipv4 show excludedportrange protocol=tcp

# ② TCP 动态端口范围：默认应为 49152 / 16384
netsh int ipv4 show dynamicport tcp

# ③ 谁把动态范围拉下来了（遗留优化项）
reg query "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v MaxUserPort

# ④ 桥到底在不在监听（本机回环）
netstat -ano | findstr :8787
```

本机 2026-10-10 的实测输出：

```text
①  8755 – 8854          ← 8787–8796 整段在其中
②  Start Port 1024 / Number of Ports 13977      （默认是 49152 / 16384）
③  MaxUserPort  REG_DWORD  0x3a98 = 15000
④  （空）                ← 没有任何进程在监听 8787
```

`15000 − 1024 + 1 = 13977`，与 ② 的 `Number of Ports` **精确吻合** —— 这是 ③ 就是元凶的直接证据。
旁证：同一台机器 `netsh int ipv4 show dynamicport udp` 仍是默认的 `49152 / 16384`
（`MaxUserPort` 只管 TCP，没被污染）。

逐端口绑定实测（Node）：

```text
8787 → EACCES   8788 → EACCES   8800 → EACCES   8854 → EACCES
8855 → OK       8856 → OK       9797 → OK       15001 → OK       18787 → OK
```

边界与 ① 的保留段**完全吻合**（段内全 `EACCES`，段外全 OK）。

## 4. 为什么"以前一直没事"

两个条件同时成立才会发作：

1. **长期条件**：`MaxUserPort=15000` 把动态范围拉低到 `1024`，于是「常用应用端口区」第一次
   变得**可以被 HNS/`winnat` 保留**。（默认 `49152–65535` 时，8000 / 8080 / 8188 / 8787
   这些端口**结构上够不着**保留段 —— 这就是别的应用看起来"没事"的原因。）
2. **每次开机的抽签**：`winnat` 划哪些段**不固定**。本机 `bridge.log` 显示 10/1、10/8 两次
   开机会话里 `8787` 一直好好的（`bridge.start` 有成功记录），10/10 那次开机才抽中
   `8755–8854`。

时间线（`bridge.log` + 系统日志交叉验证）：

| 开机会话 | 8787 能否绑定 | 依据 |
| --- | --- | --- |
| 10/1 12:39 开机（异常重启后） | 可用 | 10/1、10/2、10/4、10/6、10/7 多次 `bridge.start port 8787` |
| 10/8 22:35 开机 | 可用 | 10/9 多次 `bridge.start port 8787` |
| **10/10 11:08 开机**（10:49 意外关机 → Event 41/6008） | **不可用** | 12:12 与 14:32 两次 `bridge.listen-error / IMP-1002 / EACCES` |

期间**没有任何安装或更新**能解释它：Docker Desktop 装于 2025-09-10，最近一次 Windows 更新是
2026-09-20。所以变量只有「重启」+「保留段抽签」。

## 5. 这不只是本机问题（同源故障已被独立定位）

- [`microsoft/WSL#13454`](https://github.com/microsoft/WSL/issues/13454)：`MaxUserPort`
  导致 WSL2 镜像网络故障。
- [`nmap/nmap#3499`](https://github.com/nmap/nmap/pull/3499)（[邮件列表原文](https://seclists.org/nmap-dev/2026/q4/0)）：
  nmap 安装器的「网络性能优化」选项会写 `MaxUserPort`，作者实测在 Windows 11 上**把动态端口范围
  从 `49152–65535` 变成 `1024–65534`**，该 PR 的修法是**删除这个值**。
- 微软文档确认 Vista/Server 2008 起的默认动态范围是 `49152–65535`：
  [TCP/IP 的预设动态端口范围已变更](https://learn.microsoft.com/zh-tw/troubleshoot/windows-server/networking/default-dynamic-port-range-tcpip-chang)。

## 6. 解法

### 6.1 根治法（推荐，需管理员 + 重启）

删除那个遗留优化项，让动态范围回到默认：

```powershell
# 管理员
reg delete "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v MaxUserPort /f
# 重启后验收（期望 Start Port 49152 / Number of Ports 16384）
netsh int ipv4 show dynamicport tcp
```

之后 `8787` 回到「结构上够不着保留段」的状态，**不用改 Opennote、不用改客户端**。

> 该值本身是**净亏**：默认有 16384 个临时端口，`MaxUserPort=15000` 把它缩到 13977，
> 同时把常用应用端口区暴露给保留段。若确有高并发需求，改用显式设置：
> `netsh int ipv4 set dynamicport tcp start=49152 num=16384`。

### 6.2 保留 `MaxUserPort` 时的本地规避（需管理员）

把 `8787–8796` 注册成「**已管理**排除段」，`winnat` 就不会再自动划走它 ——
而**已管理排除段里的端口仍然可以被程序 bind**（实测：本机已管理的 `50000–50059` 段绑定全部成功，
被 `winnat` 抢走的 `8755–8854` 段则 `EACCES`）：

```powershell
net stop winnat
netsh int ipv4 add excludedportrange protocol=tcp startport=8787 numberofports=10 store=persistent
net start winnat
```

**置信度说明**：机制由「已管理段可绑定」的实测支撑；但「新增排除段 + 重启 winnat 后 `8787` 恢复」
这一步需要提权，**没有在本机亲手验证**，执行后请用第 3 节的 ① 与 ④ 复核。

### 6.3 应用侧规避（无需管理员）

在「设置 · 文件 · 导入与接口」把端口改到保留段之外（**建议 ≥ 15001**，避开 `winnat`
会划段的动态范围 `1024–15000`；仅"不常用"的端口**不解决问题**，因为保留段每次开机会重划）。

改完之后：

- **CLI / Skill** 会自动跟上（先读 `bridge.json` 的 `port`），可直接入库；
- **浏览器扩展**读不到 `bridge.json`（MV3 无文件系统访问），只能扫 `8787–8796` ——
  所以它会报「本地接口未开启」。面板在端口落于段外时会明确提示这一点；
  想让扩展也用上，需要更新扩展并显式填写地址。
- 若暂时不想动端口，收件箱通道可以显式指定笔记本绕过：
  `--workspace "<笔记本绝对路径>"`。

### 6.4 不要指望的解法

- **「换个不常用的端口」**：只要还落在 `1024–15000` 里，下次开机仍可能被抽中。
- **「重启一下就好」**：确实是抽签，但**不保证**，而且下次可能再来。
- **「把 `8787–8796` 全占住看看」**：那会得到 `IMP-1003`（端口被占用）—— 与 `EACCES`
  （被系统保留）是**两种不同的诊断**，别混。

## 7. `EACCES` 与 `EADDRINUSE` 必须分开对待

| | `EADDRINUSE` | `EACCES` |
| --- | --- | --- |
| 含义 | 端口被**别的进程**占用 | 端口落进 **OS 保留段** |
| 换一个端口有用吗 | 有用 | **有用**（但同一保留段内的端口都没用） |
| 正确反应 | 顺序扫下一个 | **同样要扫下一个**，绝不能一遇即放弃 |
| 上报码 | `IMP-1003`「端口都被占用了」 | `IMP-1002`「本地接口启动失败」 |

旧版 `bridge.cjs` 写的是 `if (code !== 'EADDRINUSE') break`，于是起始端口一被系统保留，
**10 个候选只试了第 1 个**就整体放弃。这正是本次故障里桥永远起不来的直接机制之一。

## 8. 相关产品改动（本次一并落地）

| 改动 | 位置 | 作用 |
| --- | --- | --- |
| `EACCES` 不再中断扫描 | `electron/bridge.cjs` `start()` | 段内部分被保留时仍能绑上可用端口 |
| 公布实际端口 | `bridge.json` 新增 `port` | 端口从「各客户端硬编码」变成「服务端公布」 |
| 端口偏好持久化 | `bridge.json` 新增 `startPort` | 用户显式选的端口跨重启记住，**但只作兜底相位** |
| 「默认段优先」 | `start()` 的扫描相位 | 冻结段可用时永远优先它 —— 保护**不会自动更新**的旧扩展与旧 Skill |
| Skill 先读已公布端口 | `opennote-ingest.mjs` `probeBridge()` | 段外端口也能被发现；`--check` 新增 `how` |
| 文案改正 | `IMP-1002` | 不再误导成「安全软件」，改指真实原因 |
| 段外端口提示 | 设置面板 | 端口落在段外时明确告知「扩展无法自动发现」 |
| 跨产物一致性门禁 | `scripts/verify-contract.cjs` `BR-3b` | 5 处端口清单漂移当场红 |

契约侧同步：`docs/import/02` §5.2.1（扫描相位 / 客户端发现 / `bridge.json` 字段表）、
`docs/import/00` §6.8③b③c、`docs/import/01` `FR-41`。
