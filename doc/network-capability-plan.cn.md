# 网络能力方案(需与英文版保持一致)

> 基于 pr-405 接口，在 master 上重构完整网络能力。本文以**当前现状**与**目标设计**为主。
> 原则：双平台统一、句柄安全、能力完整、非阻塞 DNS、全部行为规格明确。

---

## 1. 目标与范围

在 master（quickjs-ng 风格，VERSION `2026-06-04`）的 libc 事件循环框架上，构建完整的异步 socket 网络能力，接口取自 pr-405 并扩展为完整集。

**交付**：
- 完整 socket API（TCP/UDP、同步/异步、DNS 同步/异步、sockopt、组播、socketpair、inet 转换）。
- 双平台统一就绪层（POSIX `poll()` / Win `WSAPoll`）。
- intptr_t 句柄 + per-runtime 注册表。
- 非阻塞 DNS resolver 线程。
- `tests/test_socket.js`（全平台、强制自动结束）。

**改动文件**：`quickjs-libc.c`、`Makefile`、`doc/os.d.ts`（必要时 `globals.d.ts`/`std.d.ts`）、`examples/http_*.js`、新增 `tests/test_socket.js`。master 引擎/intl/temporal 及其余文件不动。

---

## 2. 现状底座

### 2.1 master libc 事件循环框架（保留并扩展）

| 组件 | 当前形态 | 本方案 |
|------|------|------|
| `JSOSRWHandler` | `rw_func[2]` + `poll_fd_index` | 保留 |
| `handle_posted_message` | 3 参 `(rt,ctx,port)` | 保留 |
| `JSWaker` POSIX | 非阻塞 pipe（read_fd/write_fd） | 保留 |
| `JSWaker` Win | `CreateEvent` 手动复位 | 改为 loopback socketpair（与 POSIX pipe 同构，供 WSAPoll 等待） |
| POSIX `js_os_poll` | 动态 `poll()`：`js_poll_expand`/`js_poll_add_poll_fd`、`poll_fd_index`、掩码 `POLLERR\|POLLHUP\|POLLNVAL\|POLLIN/POLLOUT`、每轮一个 handler `goto done`、atomics waker read_fd 作 pollfd、信号分发 | 保留框架，插入 socket pollfd + resolver waker pollfd |
| Win `js_os_poll` | `handles[64]` + WFMO；atomics waker 末尾追加；`min_delay`∈[0,10000]（`JS_AtomicsPollWaiters`） | 重写为 WSAPoll 动态数组统一就绪 |
| `JSThreadState` | `atomics_async_waker`、POSIX `poll_fds`/`poll_fds_size` | 保留；新增 `os_sock_handlers`/`os_sock_handles`(注册表)/resolver |
| `js_std_error_props` | EINVAL/EIO/EACCES/EEXIST/ENOSPC/ENOSYS/EBUSY/ENOENT/EPERM/EPIPE/EBADF | 补 EAGAIN/EWOULDBLOCK/EINPROGRESS/ECANCELED + Win WSAE* 别名 |
| `js_std_init/free_handlers` | init 链表、`js_waker_init(atomics)`、`JS_AtomicsSetAsyncWaker`、sab；free rw/signal/timers/rejected、`js_free_message_pipe`+port 解链、`js_waker_close(atomics)`、`free(poll_fds)` | 保留；加 sock 链表/注册表、Win WSAStartup/Cleanup、resolver 生命周期 |

master 当前**无 socket 代码**；pr-405 提供 socket 接口参考（`quickjs-libc.c` 工作树）。

### 2.2 引擎兼容与构建/CI
- 引擎 API 兼容：`JS_GetArrayBuffer` 仅接受 ArrayBuffer/SAB（拒绝 DataView/TypedArray）；`JS_NewPromiseCapability`/`JS_GetRuntimeOpaque`/`JS_ToCString/Int32/Int64/Uint32/Index`/`JS_NewArray/Object/Int32/Int64`/`JS_Call`/`JS_DupValue/FreeValue`/`JS_FreeValueRT`/`JS_AtomicsPollWaiters`/`js_waker_*`/`call_handler` 均具备。
- CI 已覆盖：`mingw-windows`（MinGW+Wine）、`windows-msys`（MSYS2 UCRT64 原生）、`linux-asan/ubsan/msan`、`macos`、`freebsd`、`cosmopolitan`、`qemu-alpine`。`make test` 含 `test_worker.js`（全平台）、`test_std.js`（POSIX）。

---

## 3. 目标架构

### 3.1 双平台统一就绪层

POSIX 与 Win 共用同一分发逻辑：每个 pending socket 操作对应一个 pollfd，按 magic 设事件掩码，`revents != 0` 即就绪，调用统一的 `handle_socket_message(ctx, sh)`。

- **事件掩码**：ACCEPT/RECV/RECVFROM → POLLIN（Win POLLRDNORM）；SEND/SENDTO → POLLOUT（Win POLLWRNORM）；CONNECT → POLLIN|POLLOUT。
- **POSIX**：master 动态 pollfd 框架，每 handler 一个 pollfd（无 FD_SETSIZE 限制）。
- **Win**：`WSAPoll` 动态数组（无 64 句柄上限），需 `_WIN32_WINNT >= 0x0600`；`winsock2.h`/`ws2tcpip.h` 在 `windows.h` 前。
- **CONNECT 完成判定**：双平台统一 `getsockopt(SO_ERROR)`。
- **waker 统一接入**：atomics_async_waker、各 worker port 的 recv_pipe waker、resolver waker 均作为 pollfd（POSIX read_fd / Win read_sock）。
- **信号分发**：双平台均在循环内分发 `os_pending_signals`（Win SIGINT 等生效）。
- **min_delay**：`JS_AtomicsPollWaiters` delay + timers，钳制 [0,10000]；无 fd 时 Sleep/min_delay。

**Win JSWaker = loopback socketpair**：`{SOCKET read_sock, write_sock}`；init 创建 loopback TCP 对（设非阻塞）；signal=send 1 字节；clear=recv drain；close=closesocket 两端。worker message pipe waker 同构受益。

**Win stdin（懒创建辅助线程，仅 `os.setReadHandler(0)` 时）**：stdin 非 socket，无法 WSAPoll。辅助线程按 `GetFileType` 区分句柄：控制台（`FILE_TYPE_CHAR`）用 `WaitForSingleObject(hStdin,50ms)` 轮询 stop、仅就绪时 `ReadFile`（空闲态可及时响应 stop，无需依赖 I/O 取消）；管道/磁盘阻塞 `ReadFile`。数据追加 mutex 保护的 buffer + `js_waker_signal`；主循环 WSAPoll 等待 stdin waker，就绪调 `rw_func[0]`；`js_os_read(0)` 从 buffer drain（空且未 EOF→-EAGAIN，EOF→0）。停止置 stop + `CancelSynchronousIo`(线程，同步 ReadFile 的正确取消 API) + `CancelIoEx`(句柄，覆盖管道/磁盘) → 有界 join(250ms)；超时则孤儿化保留共享状态（不 free，避免 UAF；线程随输入到达或进程结束退出），teardown 永不无限挂起。按 revents 分发，杜绝无条件 stdin 抢占。

### 3.2 句柄管理：intptr_t + per-runtime 注册表

- 内部句柄统一 `intptr_t`（`JSOSSockHandler.sockfd` 为 intptr_t）；**全部** socket API 用 `JS_ToInt64` 取句柄，`socket()`/`accept()` 用 `JS_NewInt64` 返回。JS 面向值=真实 OS 句柄（Int64 安全承载 intptr_t），无截断。
- per-runtime 注册表 `os_sock_handles`（条目 `{link, intptr_t handle}`）记录本 runtime 创建的所有存活 socket。
- `os.close(x)`：查注册表——命中走 socket 路径（取消同句柄 pending 操作→`closesocket`/`close`→移除注册表）；未命中走 CRT close。注册表成员资格是 socket 的权威判据（无需 `getsockopt(SO_TYPE)` 探针）。
- POSIX 句柄即 fd，与 `os.read/write/close` 天然一致；Win SOCKET 与 CRT fd 属不同命名空间，注册表权威区分。
- `free_handlers`：遍历注册表关闭+free、遍历 handlers 取消+free。

### 3.3 异步 DNS resolver

单持久 resolver 线程（懒创建）+ mutex/cond + pending/done 队列 + JSWaker 回主循环 drain。

```
JSResolver { pthread_t thread; mutex; cond; list pending; list done; JSWaker waker; atomic_int stop; BOOL started; int outstanding; }
请求 { link; type; node/service/host 字符串副本(C); hints/flags(C); C 结果(addrinfo* 或 sockaddr+host/service); int err; JSValue resolve, reject;  /* 仅主线程操作 */ }
```

- **线程只碰 C 数据**：wait cond→pop pending→`getaddrinfo`/`getnameinfo`（阻塞，离开主循环）→C 结果入 done（mutex）→`js_waker_signal`。绝不调用 JS API、不动 JSValue refcount。
- **主循环 drain**：poll/WSAPoll 含 resolver waker；就绪→取 done→构建 JS 结果→`JS_Call(resolve/reject)`（DupValue 后调用，free-after-call）→`JS_FreeValueRT`→free C 数据→`outstanding--`。
- **Async 入口**：创建 promise→DupValue resolve/reject→拷贝参数到 C 请求→enqueue pending（`outstanding++`）→signal cond→返回 promise。
- **自然退出判据**：`outstanding`=已提交未 drain 的请求数，仅主线程改（submit +1 / drain -1，线程不碰）。双平台 "no more events" 条件用 `outstanding==0`，**线程 started 不参与退出判据**——避免持久线程标志阻止脚本自然退出；有未完成 DNS 才继续等，保留 fire-and-forget 完成能力。
- **生命周期**：`free_handlers` 置 stop→broadcast→join→清理 pending/done 残留（`JS_FreeValueRT`+free C）→`js_waker_close`；在 WSACleanup 与 free(ts) 之前。
- 同步 `getaddrinfo`/`getnameinfo` 保留供简单场景。

### 3.4 所有权模型：per-runtime

socket 归创建它的 runtime 所有（`os_sock_handlers`/注册表挂在 per-runtime `JSThreadState`，每个 worker 独立事件循环；与 `os.setReadHandler` 等一致）。Int64 句柄可经 `postMessage` 传值，但 polling/属主不随值转移。d.ts 注明句柄仅在创建 runtime 内有效。

---

## 4. API 设计

### 4.1 函数表

> 缓冲 API 一律 **ArrayBuffer-only**（与引擎/os.read/write 一致）。句柄 `SocketHandle = Branded<number,"SocketHandle">`。`Result<T> = T | NegativeErrno`。

| 函数 | length | 签名 |
|------|------|------|
| `socket` | 3 | `(domain, type, protocol?) → Result<SocketHandle>` |
| `bind` | 2 | `(sock, addr) → Result<0>` |
| `listen` | 2 | `(sock, backlog?) → Result<0>`（backlog 缺省 SOMAXCONN） |
| `accept` | 1 | `(sock) → Promise<[SocketHandle, SocketAddr]>` |
| `connect` | 2 | `(sock, addr) → Promise<0>` |
| `recv` | 5 | `(sock, buf, length?, offset?, flags?) → Promise<number>` |
| `send` | 5 | `(sock, buf, length?, offset?, flags?) → Promise<number>` |
| `recvfrom` | 5 | `(sock, buf, length?, offset?, flags?) → Promise<[number, SocketAddr]>` |
| `sendto` | 6 | `(sock, addr, buf, length?, offset?, flags?) → Promise<number>` |
| `shutdown` | 2 | `(sock, how) → Result<0>` |
| `getsockopt` | 4 | `(sock, optname, optval, level?) → Result<number>`（返回 optlen，level 缺省 SOL_SOCKET） |
| `setsockopt` | 4 | `(sock, optname, optval, level?) → Result<0>` |
| `getsockname` | 1 | `(sock) → Result<SocketAddr>` |
| `getpeername` | 1 | `(sock) → Result<SocketAddr>` |
| `getaddrinfo` | 2 | `(node, hints?) → Result<SocketAddrInfo[]>` |
| `getaddrinfoAsync` | 2 | `(node, hints?) → Promise<SocketAddrInfo[]>` |
| `getnameinfo` | 2 | `(addr, flags?) → Result<{host,service}>` |
| `getnameinfoAsync` | 2 | `(addr, flags?) → Promise<{host,service}>` |
| `gethostname` | 0 | `() → Result<string>` |
| `inet_ntop` | 2 | `(family, addrBuf) → Result<string>` |
| `inet_pton` | 2 | `(family, str) → Result<ArrayBuffer>` |
| `socketpair` | 2 | `(domain?, type?) → Result<[SocketHandle,SocketHandle]>`（POSIX 原生；Win loopback TCP 对） |
| `close` | — | 复用 `os.close`（注册表权威区分） |

### 4.2 常量

- **socket 基础**：AF_INET/AF_INET6、SOCK_STREAM/DGRAM/RAW、SOL_SOCKET、SO_REUSEADDR/RCVBUF/SNDBUF/ERROR/KEEPALIVE/BROADCAST、IPPROTO_IP/TCP/UDP/IPV6、TCP_NODELAY、SHUT_RD/WR/RDWR（Win=SD_RECEIVE/SD_SEND/SD_BOTH）。
- **组播**：IP_ADD/DROP_MEMBERSHIP、IP_MULTICAST_IF/TTL/LOOP、IPV6_JOIN/LEAVE_GROUP、IPV6_MULTICAST_IF/HOPS/LOOP。
- **sockopt 扩展（平台守卫）**：IPV6_V6ONLY、SO_REUSEPORT(POSIX)、SO_LINGER、SO_RCVTIMEO/SO_SNDTIMEO、SO_ACCEPTCONN、SO_TYPE、SO_PROTOCOL、SO_DOMAIN、IP_TTL、IP_TOS、TCP_KEEPIDLE/TCP_KEEPINTVL/TCP_KEEPCNT(POSIX)。
- **MSG_***：MSG_PEEK/OOB/DONTWAIT/WAITALL/TRUNC/NOSIGNAL（平台守卫；存 `sh->flags`，缺省 0）。
- **AI_***：AI_PASSIVE/CANONNAME/NUMERICHOST/NUMERICSERV/V4MAPPED/ALL/ADDRCONFIG（hints.ai_flags）。
- **NI_***：NI_NUMERICHOST/NUMERICSERV/NOFQDN/NAMEREQD/DGRAM。
- **EAI_***：EAI_AGAIN/BADFLAGS/FAIL/FAMILY/MEMORY/NONAME/SERVICE/SOCKTYPE/SYSTEM/OVERFLOW。
- **errno**：EAGAIN/EWOULDBLOCK/EINPROGRESS/ECANCELED；Win 下 EAGAIN/EWOULDBLOCK=WSAEWOULDBLOCK、EINPROGRESS=WSAEINPROGRESS，并导出 WSAE* 别名子集（WSAEWOULDBLOCK/INPROGRESS/CONNREFUSED/CONNRESET/TIMEDOUT/ADDRINUSE/ADDRNOTAVAIL/NOTCONN/INVAL/FAULT/NETUNREACH/HOSTUNREACH 等）。ECANCELED 用 `#ifndef` 回退定义。

### 4.3 d.ts 类型
`SocketHandle`、`SocketAddrInfo`（含 socktype）、`HintAddr`（含 `flags?`）、`NameInfo`（{host,service}）、`MsgFlags`/`AddrInfoFlags`/`NameInfoFlags` branded 类型；上述常量声明；全部函数签名；recv/send/recvfrom/sendto 含 `flags?`。

---

## 5. 关键行为规格

| 主题 | 规格 |
|------|------|
| 句柄 | intptr_t 承载，JS 以 Int64 传递，全表一致（socket/bind/listen/accept/connect/recv/send/recvfrom/sendto/shutdown/getsockopt/setsockopt/getsockname/getpeername/close/sock_cancel），无截断 |
| 注册表/close | socket()/accept() 登记；os.close 查表权威区分 socket/CRT；关闭前取消同句柄 pending（reject `-ECANCELED`）；free_handlers 全清理 |
| accept | 新句柄设非阻塞（POSIX `fcntl O_NONBLOCK`，失败则 close 并置 -errno；Win 继承） |
| connect | 立即失败以 `reject(-errno)` 返回 promise（不抛同步异常）；EINPROGRESS/WSAEWOULDBLOCK 视为异步进行中 |
| recv/send 长度 | `length==0` 抛 RangeError；EOF 由 recv 返回 0 表达；offset/length 钳制到缓冲区；缓冲区 detach 重验→`-EINVAL`；Win length 钳制 INT_MAX |
| recv/send flags | 可选尾部 flags（MSG_*），缺省 0 向后兼容 |
| getaddrinfo | 保存头指针，成功/失败两路径均 `freeaddrinfo(整链)`；hints 含 service/family/socktype/ai_flags；错误返回 -EAI_*（已导出） |
| errno 跨平台 | js_get_sockerrno：Win `-WSAGetLastError()`、POSIX `-errno`；EAGAIN/EWOULDBLOCK/EINPROGRESS Win 以 WSAE* 值导出，JS 用 `os.E*` 常量比较（勿硬编码数值） |
| 缓冲区保活 | C 持 bufval/resolve/reject 引用（ref_count>0 作外部根）；resolve/reject DupValue 后调用、free-after-call（promise 反应为异步 job，无同步用户码） |
| 信号/atomics | 双平台信号分发；atomics waker/port waker/resolver waker 统一接入就绪层 |
| 自然退出 | resolver `outstanding==0` 计入双平台 no-more-events 判据（线程 started 不参与）；async DNS 完成后脚本可自然退出 |
| Win stdin teardown | 控制台 wait 轮询 stop；`CancelSynchronousIo`+`CancelIoEx`+有界 join(250ms)，超时孤儿化保留状态，永不无限挂起 |
| 设计边界 | per-runtime 所有权（§3.4）；ArrayBuffer-only；组播选项用恰好选项大小的 ArrayBuffer（如 ip_mreq 8 字节） |

---

## 6. 实施步骤

> 底座=`master:quickjs-libc.c`；接口参考=pr-405 工作树。注释只述现行。每步 Read 复核 + 静态清单对应项。

- **Step 0 分支**：`git switch -c pr-405-onto-master master`。
- **Step 1 结构**：winsock 头（windows.h 前）+ `_WIN32_WINNT>=0x0600`；POSIX socket 头；`MagicSocket` 枚举；`JSOSSockHandler`（intptr_t sockfd + poll_fd_index + flags + length/offset/buffer/bufval/sockaddr/resolve/reject）；注册表条目 `JSOSockHandle`；`JSThreadState` 加 os_sock_handlers/os_sock_handles/resolver。保留 master rw_func[2]/atomics/poll_fds。
- **Step 2 助手/errno**：`JS_ToSockaddrStruct`/`JS_ToSockaddrObj`（memset/family 缺省取 getsockname/inet_pton/port≤65535/inet_ntop）；`js_get_sockerrno`；error_props 补全 + Win WSAE* 别名。
- **Step 3 注册表+生命周期+close**：注册表 add/remove/lookup；`free_sock_handler`（不关 fd）；`js_os_sock_cancel`（intptr_t，reject -ECANCELED）；`js_os_close` 查表区分 + 取消 pending。
- **Step 4 统一 handle_socket_message**：`(ctx,sh)` 双平台；缓冲区重验钳制；recv/send/recvfrom/sendto 传 sh->flags + Win length 钳制；CONNECT getsockopt(SO_ERROR)；ACCEPT 设非阻塞；errno 早退平台判定；resolve/reject DupValue+free-after-call。
- **Step 5 POSIX poll**：空判定加 os_sock_handlers；rw 后 port 前加 socket pollfd 循环（按 magic 掩码，poll_fd_index）+ resolver waker read_fd；分发 revents!=0→handle_socket_message，resolver waker→drain。
- **Step 6 Win WSAPoll**：JSWaker 改 socketpair；动态 WSAPOLLFD 数组（socket/atomics/port/resolver/stdin waker）；按 revents 分发（socket→handle_socket_message，port→handle_posted_message 3参，atomics→js_waker_clear，resolver→drain，stdin→rw_func[0]）；信号分发；min_delay；stdin 辅助线程 + os.read(0) buffer drain。
- **Step 7 API+funcs+常量**：§4.1 全部函数（intptr_t/JS_ToInt64/JS_NewInt64，socket()/accept() 登记注册表）；getaddrinfo 整链释放 + ai_flags；recv_send resolving_funcs 初始化 {JS_NULL,JS_NULL} + length==0 校验；connect 立即失败 reject；getnameinfo/gethostname/inet_ntop/inet_pton/socketpair；funcs 表按 length 注册；常量按 §4.2（平台守卫）。
- **Step 8 异步 DNS**：resolver 结构/线程/队列/waker；getaddrinfoAsync/getnameinfoAsync；POSIX/Win 就绪层接 resolver waker。
- **Step 9 init/free**：init 加 sock 链表/注册表 + Win WSAStartup（失败 exit(1)）+ resolver 懒标记；free 加 handlers 取消+free、注册表关闭+free、resolver stop+broadcast+join+清理+waker_close、Win WSACleanup（在 free(ts) 前）；保留 master atomics waker/poll_fds/port 解链；WSAStartup/Cleanup 对称。
- **Step 10 Makefile**：LIBS `else -lws2_32`；test 目标加 `$(WINE) ./qjs$(EXE) tests/test_socket.js`（全平台）。
- **Step 11 d.ts/示例**：os.d.ts 完整集签名（ArrayBuffer-only，组播指引）；examples/http_*.js 适配（句柄 Int64 透明传递，可演示 getaddrinfoAsync）；d.ts↔C↔示例签名一致。
- **Step 12 测试**：tests/test_socket.js 覆盖 loopback TCP/UDP、同 socket 并发多操作、getsockname/getpeername、get/setsockopt（含 level）、getaddrinfo 同步+异步、getnameinfo 同步+异步、gethostname、inet_ntop/pton 往返、socketpair 双向、MSG_PEEK/WAITALL、组播冒烟（8 字节 ArrayBuffer join→loopback 收发→leave）、close 取消 pending（reject -ECANCELED）；所有等待带 setTimeout 兜底 os.exit，正常完成显式退出。

---

## 7. 验证

### 7.1 静态清单（逐项核对）
- [ ] 无 `r_func`/`w_func` 残留；`JSOSRWHandler` 仍 rw_func[2]+poll_fd_index；`handle_posted_message` 全 3 参。
- [ ] `atomics_async_waker` 在 init/free/POSIX poll/Win WSAPoll 均接入。
- [ ] `JSOSSockHandler.sockfd` intptr_t + poll_fd_index + flags；全表 JS_ToInt64/JS_NewInt64；注册表登记/移除配对。
- [ ] `handle_socket_message` 双平台统一 (ctx,sh)；无 WSAEventSelect/JSOSSockEvent/os_sock_events/event_update/netEvents 残留。
- [ ] Win WSAPoll 动态数组、按 revents 分发、含信号/atomics/resolver/port/stdin waker、无无条件 stdin。
- [ ] Win JSWaker=socketpair，signal/clear/close 正确，worker pipe waker 一致。
- [ ] `#if _WIN32/#else/#endif` 配对；winsock 头在 windows.h 前；_WIN32_WINNT>=0x0600。
- [ ] funcs length↔d.ts 一致；常量平台守卫正确。
- [ ] §5 行为规格逐处 Read 复核（句柄/close/accept/connect/长度/getaddrinfo/errno）。
- [ ] resolver 线程只碰 C 数据；resolve/reject 主线程 Dup/Free；free_handlers stop+broadcast+join+清理在 WSACleanup/free(ts) 前。
- [ ] 双平台 no-more-events 用 `resolver.outstanding==0`（非 started）；submit/drain 计数配对；async DNS 后脚本自然退出。
- [ ] Win stdin 控制台 wait 轮询 stop + `CancelSynchronousIo`/`CancelIoEx` + 有界 join(250ms) + 超时孤儿化兜底。
- [ ] WSAStartup/Cleanup 对称；ECANCELED 导出且 Win 有定义/回退。
- [ ] Makefile LIBS else -lws2_32 + test_socket.js。

### 7.2 CI（主要手段）
- POSIX：linux-asan/ubsan/msan 捕获内存问题；linux/macos/freebsd/cosmopolitan/qemu-alpine 多平台。
- Windows：mingw-windows(Wine)+windows-msys(原生) 跑 make test（含 test_socket.js）；验证 Wine WSAPoll，具体 quirk 针对性修复。
- 回归：test_worker.js（atomics waker+port+Win socketpair waker）、test_std.js(POSIX)、test_loop.js。

### 7.3 完成标准
静态清单全 ✅；CI 双平台+sanitizer 全绿；test_socket.js 自动结束且断言通过；test_worker/test_std 无回归。

---

## 8. 执行顺序
Step 0 分支 → 1 结构 → 2 助手/errno → 3 注册表+close → 4 统一 handle_socket_message → 5 POSIX poll → 6 Win WSAPoll → 7 API+funcs+常量 → 8 异步 DNS → 9 init/free → 10 Makefile → 11 d.ts/示例 → 12 测试 → 7.1 静态复核 → 确认提交 → CI 验证。
