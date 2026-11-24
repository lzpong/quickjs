# Network Capability Plan(To be consistent with the Chinese version)

> Refactor the full network capability on top of master, based on the pr-405 interface. This document focuses on the **current state** and the **target design**.
> Principles: unified across both platforms, handle safety, complete capability, non-blocking DNS, every behavior explicitly specified.

---

## 1. Goals & Scope

Build a complete asynchronous socket network capability on master's (quickjs-ng style, VERSION `2026-06-04`) libc event-loop framework. The interface is taken from pr-405 and extended to a complete set.

**Deliverables**:
- Complete socket API (TCP/UDP, sync/async, DNS sync/async, sockopt, multicast, socketpair, inet conversion).
- Unified readiness layer across both platforms (POSIX `poll()` / Win `WSAPoll`).
- intptr_t handles + per-runtime registry.
- Non-blocking DNS resolver thread.
- `tests/test_socket.js` (all platforms, forced auto-termination).

**Files changed**: `quickjs-libc.c`, `Makefile`, `doc/os.d.ts` (and `globals.d.ts`/`std.d.ts` if needed), `examples/http_*.js`, new `tests/test_socket.js`. The master engine/intl/temporal and all other files are untouched.

---

## 2. Current Foundation

### 2.1 master libc event-loop framework (kept and extended)

| Component | Current form | This plan |
|------|------|------|
| `JSOSRWHandler` | `rw_func[2]` + `poll_fd_index` | Keep |
| `handle_posted_message` | 3 args `(rt,ctx,port)` | Keep |
| `JSWaker` POSIX | non-blocking pipe (read_fd/write_fd) | Keep |
| `JSWaker` Win | `CreateEvent` manual-reset | Change to loopback socketpair (isomorphic to the POSIX pipe, waitable by WSAPoll) |
| POSIX `js_os_poll` | dynamic `poll()`: `js_poll_expand`/`js_poll_add_poll_fd`, `poll_fd_index`, masks `POLLERR\|POLLHUP\|POLLNVAL\|POLLIN/POLLOUT`, one handler per round `goto done`, atomics waker read_fd as pollfd, signal dispatch | Keep the framework, insert socket pollfd + resolver waker pollfd |
| Win `js_os_poll` | `handles[64]` + WFMO; atomics waker appended at the end; `min_delay`∈[0,10000] (`JS_AtomicsPollWaiters`) | Rewrite as a WSAPoll dynamic array with unified readiness |
| `JSThreadState` | `atomics_async_waker`, POSIX `poll_fds`/`poll_fds_size` | Keep; add `os_sock_handlers`/`os_sock_handles` (registry)/resolver |
| `js_std_error_props` | EINVAL/EIO/EACCES/EEXIST/ENOSPC/ENOSYS/EBUSY/ENOENT/EPERM/EPIPE/EBADF | Add EAGAIN/EWOULDBLOCK/EINPROGRESS/ECANCELED + Win WSAE* aliases |
| `js_std_init/free_handlers` | init lists, `js_waker_init(atomics)`, `JS_AtomicsSetAsyncWaker`, sab; free rw/signal/timers/rejected, `js_free_message_pipe`+port unlink, `js_waker_close(atomics)`, `free(poll_fds)` | Keep; add sock lists/registry, Win WSAStartup/Cleanup, resolver lifecycle |

master currently has **no socket code**; pr-405 provides the socket interface reference (`quickjs-libc.c` working tree).

### 2.2 Engine compatibility & build/CI
- Engine API compatibility: `JS_GetArrayBuffer` accepts only ArrayBuffer/SAB (rejects DataView/TypedArray); `JS_NewPromiseCapability`/`JS_GetRuntimeOpaque`/`JS_ToCString/Int32/Int64/Uint32/Index`/`JS_NewArray/Object/Int32/Int64`/`JS_Call`/`JS_DupValue/FreeValue`/`JS_FreeValueRT`/`JS_AtomicsPollWaiters`/`js_waker_*`/`call_handler` are all available.
- CI already covers: `mingw-windows` (MinGW+Wine), `windows-msys` (MSYS2 UCRT64 native), `linux-asan/ubsan/msan`, `macos`, `freebsd`, `cosmopolitan`, `qemu-alpine`. `make test` includes `test_worker.js` (all platforms), `test_std.js` (POSIX).

---

## 3. Target Architecture

### 3.1 Unified readiness layer across both platforms

POSIX and Win share the same dispatch logic: each pending socket operation maps to one pollfd, the event mask is set by magic, `revents != 0` means ready, and the unified `handle_socket_message(ctx, sh)` is called.

- **Event masks**: ACCEPT/RECV/RECVFROM → POLLIN (Win POLLRDNORM); SEND/SENDTO → POLLOUT (Win POLLWRNORM); CONNECT → POLLIN|POLLOUT.
- **POSIX**: master's dynamic pollfd framework, one pollfd per handler (no FD_SETSIZE limit).
- **Win**: `WSAPoll` dynamic array (no 64-handle cap), requires `_WIN32_WINNT >= 0x0600`; `winsock2.h`/`ws2tcpip.h` before `windows.h`.
- **CONNECT completion**: unified `getsockopt(SO_ERROR)` on both platforms.
- **Unified waker integration**: atomics_async_waker, each worker port's recv_pipe waker, and the resolver waker are all pollfds (POSIX read_fd / Win read_sock).
- **Signal dispatch**: both platforms dispatch `os_pending_signals` inside the loop (Win SIGINT etc. take effect).
- **min_delay**: `JS_AtomicsPollWaiters` delay + timers, clamped to [0,10000]; Sleep/min_delay when there is no fd.

**Win JSWaker = loopback socketpair**: `{SOCKET read_sock, write_sock}`; init creates a loopback TCP pair (set non-blocking); signal=send 1 byte; clear=recv drain; close=closesocket both ends. The worker message pipe waker benefits isomorphically.

**Win stdin (lazily created helper thread, only on `os.setReadHandler(0)`)**: stdin is not a socket and cannot be WSAPoll'd. The helper thread distinguishes the handle via `GetFileType`: a console (`FILE_TYPE_CHAR`) uses `WaitForSingleObject(hStdin,50ms)` to poll the stop flag and only calls `ReadFile` when ready (the idle state responds to stop promptly without relying on I/O cancellation); pipe/disk uses blocking `ReadFile`. Data is appended to a mutex-protected buffer + `js_waker_signal`; the main loop WSAPoll-waits on the stdin waker and calls `rw_func[0]` when ready; `js_os_read(0)` drains from the buffer (empty and not EOF → -EAGAIN, EOF → 0). Stop sets stop + `CancelSynchronousIo` (thread, the correct cancel API for synchronous ReadFile) + `CancelIoEx` (handle, covers pipe/disk) → bounded join (250ms); on timeout the shared state is orphaned and kept allocated (not freed, to avoid UAF; the thread exits when input arrives or the process ends), so teardown never hangs indefinitely. Dispatch is by revents, eliminating unconditional stdin preemption.

### 3.2 Handle management: intptr_t + per-runtime registry

- Internal handles are uniformly `intptr_t` (`JSOSSockHandler.sockfd` is intptr_t); **all** socket APIs use `JS_ToInt64` to read handles, and `socket()`/`accept()` return via `JS_NewInt64`. The JS-facing value = the real OS handle (Int64 safely carries intptr_t), no truncation.
- The per-runtime registry `os_sock_handles` (entries `{link, intptr_t handle}`) records every live socket created by this runtime.
- `os.close(x)`: look up the registry — a hit takes the socket path (cancel pending operations on the same handle → `closesocket`/`close` → remove from registry); a miss takes CRT close. Registry membership is the authoritative criterion for a socket (no `getsockopt(SO_TYPE)` probe needed).
- A POSIX handle is an fd, naturally consistent with `os.read/write/close`; Win SOCKET and CRT fd belong to different namespaces, authoritatively distinguished by the registry.
- `free_handlers`: walk the registry closing+freeing, walk the handlers canceling+freeing.

### 3.3 Asynchronous DNS resolver

A single persistent resolver thread (lazily created) + mutex/cond + pending/done queues + JSWaker to drain back on the main loop.

```
JSResolver { pthread_t thread; mutex; cond; list pending; list done; JSWaker waker; atomic_int stop; BOOL started; int outstanding; }
request { link; type; node/service/host string copies (C); hints/flags (C); C result (addrinfo* or sockaddr+host/service); int err; JSValue resolve, reject;  /* touched only on the main thread */ }
```

- **The thread touches only C data**: wait cond → pop pending → `getaddrinfo`/`getnameinfo` (blocking, off the main loop) → C result into done (mutex) → `js_waker_signal`. It never calls JS APIs or touches JSValue refcounts.
- **Main-loop drain**: poll/WSAPoll includes the resolver waker; ready → take done → build the JS result → `JS_Call(resolve/reject)` (DupValue before call, free-after-call) → `JS_FreeValueRT` → free C data → `outstanding--`.
- **Async entry**: create promise → DupValue resolve/reject → copy arguments into the C request → enqueue pending (`outstanding++`) → signal cond → return promise.
- **Natural-exit criterion**: `outstanding` = number of submitted-but-not-drained requests, modified only on the main thread (submit +1 / drain -1, the thread never touches it). The "no more events" condition on both platforms uses `outstanding==0`; **the thread's started flag does not participate in the exit criterion** — this avoids a persistent thread flag preventing the script from exiting naturally; the loop keeps waiting only while DNS is outstanding, preserving fire-and-forget completion.
- **Lifecycle**: `free_handlers` sets stop → broadcast → join → clean up leftover pending/done (`JS_FreeValueRT`+free C) → `js_waker_close`; before WSACleanup and free(ts).
- Synchronous `getaddrinfo`/`getnameinfo` are kept for simple scenarios.

### 3.4 Ownership model: per-runtime

A socket is owned by the runtime that created it (`os_sock_handlers`/registry hang off the per-runtime `JSThreadState`, each worker has its own event loop; consistent with `os.setReadHandler` etc.). An Int64 handle can be passed by value via `postMessage`, but polling/ownership does not transfer with the value. The d.ts notes that a handle is valid only within the creating runtime.

---

## 4. API Design

### 4.1 Function table

> Buffer APIs are uniformly **ArrayBuffer-only** (consistent with the engine/os.read/write). Handle `SocketHandle = Branded<number,"SocketHandle">`. `Result<T> = T | NegativeErrno`.

| Function | length | Signature |
|------|------|------|
| `socket` | 3 | `(domain, type, protocol?) → Result<SocketHandle>` |
| `bind` | 2 | `(sock, addr) → Result<0>` |
| `listen` | 2 | `(sock, backlog?) → Result<0>` (backlog defaults to SOMAXCONN) |
| `accept` | 1 | `(sock) → Promise<[SocketHandle, SocketAddr]>` |
| `connect` | 2 | `(sock, addr) → Promise<0>` |
| `recv` | 5 | `(sock, buf, length?, offset?, flags?) → Promise<number>` |
| `send` | 5 | `(sock, buf, length?, offset?, flags?) → Promise<number>` |
| `recvfrom` | 5 | `(sock, buf, length?, offset?, flags?) → Promise<[number, SocketAddr]>` |
| `sendto` | 6 | `(sock, addr, buf, length?, offset?, flags?) → Promise<number>` |
| `shutdown` | 2 | `(sock, how) → Result<0>` |
| `getsockopt` | 4 | `(sock, optname, optval, level?) → Result<number>` (returns optlen, level defaults to SOL_SOCKET) |
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
| `socketpair` | 2 | `(domain?, type?) → Result<[SocketHandle,SocketHandle]>` (POSIX native; Win loopback TCP pair) |
| `close` | — | reuses `os.close` (registry authoritative distinction) |

### 4.2 Constants

- **socket basics**: AF_INET/AF_INET6, SOCK_STREAM/DGRAM/RAW, SOL_SOCKET, SO_REUSEADDR/RCVBUF/SNDBUF/ERROR/KEEPALIVE/BROADCAST, IPPROTO_IP/TCP/UDP/IPV6, TCP_NODELAY, SHUT_RD/WR/RDWR (Win=SD_RECEIVE/SD_SEND/SD_BOTH).
- **multicast**: IP_ADD/DROP_MEMBERSHIP, IP_MULTICAST_IF/TTL/LOOP, IPV6_JOIN/LEAVE_GROUP, IPV6_MULTICAST_IF/HOPS/LOOP.
- **sockopt extensions (platform-guarded)**: IPV6_V6ONLY, SO_REUSEPORT (POSIX), SO_LINGER, SO_RCVTIMEO/SO_SNDTIMEO, SO_ACCEPTCONN, SO_TYPE, SO_PROTOCOL, SO_DOMAIN, IP_TTL, IP_TOS, TCP_KEEPIDLE/TCP_KEEPINTVL/TCP_KEEPCNT (POSIX).
- **MSG_***: MSG_PEEK/OOB/DONTWAIT/WAITALL/TRUNC/NOSIGNAL (platform-guarded; stored in `sh->flags`, default 0).
- **AI_***: AI_PASSIVE/CANONNAME/NUMERICHOST/NUMERICSERV/V4MAPPED/ALL/ADDRCONFIG (hints.ai_flags).
- **NI_***: NI_NUMERICHOST/NUMERICSERV/NOFQDN/NAMEREQD/DGRAM.
- **EAI_***: EAI_AGAIN/BADFLAGS/FAIL/FAMILY/MEMORY/NONAME/SERVICE/SOCKTYPE/SYSTEM/OVERFLOW.
- **errno**: EAGAIN/EWOULDBLOCK/EINPROGRESS/ECANCELED; on Win EAGAIN/EWOULDBLOCK=WSAEWOULDBLOCK, EINPROGRESS=WSAEINPROGRESS, and a WSAE* alias subset is exported (WSAEWOULDBLOCK/INPROGRESS/CONNREFUSED/CONNRESET/TIMEDOUT/ADDRINUSE/ADDRNOTAVAIL/NOTCONN/INVAL/FAULT/NETUNREACH/HOSTUNREACH etc.). ECANCELED uses an `#ifndef` fallback definition.

### 4.3 d.ts types
`SocketHandle`, `SocketAddrInfo` (with socktype), `HintAddr` (with `flags?`), `NameInfo` ({host,service}), `MsgFlags`/`AddrInfoFlags`/`NameInfoFlags` branded types; the above constant declarations; all function signatures; recv/send/recvfrom/sendto include `flags?`.

---

## 5. Key Behavior Specifications

| Topic | Specification |
|------|------|
| Handles | Carried as intptr_t, passed as Int64 in JS, consistent across the whole table (socket/bind/listen/accept/connect/recv/send/recvfrom/sendto/shutdown/getsockopt/setsockopt/getsockname/getpeername/close/sock_cancel), no truncation |
| Registry/close | socket()/accept() register; os.close looks up the table to authoritatively distinguish socket/CRT; before closing, cancel pending on the same handle (reject `-ECANCELED`); free_handlers cleans up everything |
| accept | New handle set non-blocking (POSIX `fcntl O_NONBLOCK`, on failure close and set -errno; Win inherits) |
| connect | Immediate failure returns a promise via `reject(-errno)` (no synchronous throw); EINPROGRESS/WSAEWOULDBLOCK treated as async in-progress |
| recv/send length | `length==0` throws RangeError; EOF expressed by recv returning 0; offset/length clamped to the buffer; buffer detach re-validated → `-EINVAL`; Win length clamped to INT_MAX |
| recv/send flags | Optional trailing flags (MSG_*), default 0 for backward compatibility |
| getaddrinfo | Keep the head pointer, `freeaddrinfo(whole chain)` on both success/failure paths; hints include service/family/socktype/ai_flags; errors return -EAI_* (exported) |
| errno cross-platform | js_get_sockerrno: Win `-WSAGetLastError()`, POSIX `-errno`; EAGAIN/EWOULDBLOCK/EINPROGRESS exported as WSAE* values on Win, JS compares with `os.E*` constants (do not hardcode numbers) |
| Buffer keep-alive | C holds bufval/resolve/reject references (ref_count>0 acts as an external root); resolve/reject DupValue before call, free-after-call (promise reactions are async jobs, no synchronous user code) |
| Signals/atomics | Signal dispatch on both platforms; atomics waker/port waker/resolver waker uniformly integrated into the readiness layer |
| Natural exit | resolver `outstanding==0` participates in the no-more-events criterion on both platforms (thread started does not); the script can exit naturally after async DNS completes |
| Win stdin teardown | Console wait polls stop; `CancelSynchronousIo`+`CancelIoEx`+bounded join (250ms), on timeout orphan and keep the state, never hangs indefinitely |
| Design boundaries | per-runtime ownership (§3.4); ArrayBuffer-only; multicast options use an ArrayBuffer of exactly the option size (e.g. ip_mreq 8 bytes) |

---

## 6. Implementation Steps

> Foundation=`master:quickjs-libc.c`; interface reference=pr-405 working tree. Comments describe only the current state. Each step: Read re-check + corresponding static-checklist item.

- **Step 0 branch**: `git switch -c pr-405-onto-master master`.
- **Step 1 structures**: winsock headers (before windows.h) + `_WIN32_WINNT>=0x0600`; POSIX socket headers; `MagicSocket` enum; `JSOSSockHandler` (intptr_t sockfd + poll_fd_index + flags + length/offset/buffer/bufval/sockaddr/resolve/reject); registry entry `JSOSockHandle`; `JSThreadState` adds os_sock_handlers/os_sock_handles/resolver. Keep master rw_func[2]/atomics/poll_fds.
- **Step 2 helpers/errno**: `JS_ToSockaddrStruct`/`JS_ToSockaddrObj` (memset/family defaults from getsockname/inet_pton/port≤65535/inet_ntop); `js_get_sockerrno`; complete error_props + Win WSAE* aliases.
- **Step 3 registry+lifecycle+close**: registry add/remove/lookup; `free_sock_handler` (does not close fd); `js_os_sock_cancel` (intptr_t, reject -ECANCELED); `js_os_close` table lookup distinction + cancel pending.
- **Step 4 unified handle_socket_message**: `(ctx,sh)` on both platforms; buffer re-validation clamping; recv/send/recvfrom/sendto pass sh->flags + Win length clamping; CONNECT getsockopt(SO_ERROR); ACCEPT set non-blocking; errno early-exit platform check; resolve/reject DupValue+free-after-call.
- **Step 5 POSIX poll**: add os_sock_handlers to the empty check; add the socket pollfd loop after rw and before port (mask by magic, poll_fd_index) + resolver waker read_fd; dispatch revents!=0 → handle_socket_message, resolver waker → drain.
- **Step 6 Win WSAPoll**: JSWaker changed to socketpair; dynamic WSAPOLLFD array (socket/atomics/port/resolver/stdin waker); dispatch by revents (socket → handle_socket_message, port → handle_posted_message 3 args, atomics → js_waker_clear, resolver → drain, stdin → rw_func[0]); signal dispatch; min_delay; stdin helper thread + os.read(0) buffer drain.
- **Step 7 API+funcs+constants**: all §4.1 functions (intptr_t/JS_ToInt64/JS_NewInt64, socket()/accept() register in the registry); getaddrinfo whole-chain free + ai_flags; recv_send resolving_funcs initialized {JS_NULL,JS_NULL} + length==0 check; connect immediate-failure reject; getnameinfo/gethostname/inet_ntop/inet_pton/socketpair; funcs table registered by length; constants per §4.2 (platform-guarded).
- **Step 8 async DNS**: resolver struct/thread/queues/waker; getaddrinfoAsync/getnameinfoAsync; POSIX/Win readiness layer integrates the resolver waker.
- **Step 9 init/free**: init adds sock lists/registry + Win WSAStartup (exit(1) on failure) + resolver lazy flag; free adds handlers cancel+free, registry close+free, resolver stop+broadcast+join+cleanup+waker_close, Win WSACleanup (before free(ts)); keep master atomics waker/poll_fds/port unlink; WSAStartup/Cleanup symmetric.
- **Step 10 Makefile**: LIBS `else -lws2_32`; test target adds `$(WINE) ./qjs$(EXE) tests/test_socket.js` (all platforms).
- **Step 11 d.ts/examples**: os.d.ts complete-set signatures (ArrayBuffer-only, multicast guidance); examples/http_*.js adapted (handles passed transparently as Int64, can demonstrate getaddrinfoAsync); d.ts↔C↔example signatures consistent.
- **Step 12 tests**: tests/test_socket.js covers loopback TCP/UDP, multiple concurrent operations on the same socket, getsockname/getpeername, get/setsockopt (with level), getaddrinfo sync+async, getnameinfo sync+async, gethostname, inet_ntop/pton round-trip, socketpair bidirectional, MSG_PEEK/WAITALL, multicast smoke (8-byte ArrayBuffer join → loopback send/recv → leave), close canceling pending (reject -ECANCELED); every wait has a setTimeout fallback os.exit, normal completion exits explicitly.

---

## 7. Verification

### 7.1 Static checklist (item-by-item check)
- [ ] No `r_func`/`w_func` residue; `JSOSRWHandler` still rw_func[2]+poll_fd_index; `handle_posted_message` all 3 args.
- [ ] `atomics_async_waker` integrated in init/free/POSIX poll/Win WSAPoll.
- [ ] `JSOSSockHandler.sockfd` intptr_t + poll_fd_index + flags; whole table JS_ToInt64/JS_NewInt64; registry register/remove paired.
- [ ] `handle_socket_message` unified (ctx,sh) on both platforms; no WSAEventSelect/JSOSSockEvent/os_sock_events/event_update/netEvents residue.
- [ ] Win WSAPoll dynamic array, dispatch by revents, includes signal/atomics/resolver/port/stdin waker, no unconditional stdin.
- [ ] Win JSWaker=socketpair, signal/clear/close correct, worker pipe waker consistent.
- [ ] `#if _WIN32/#else/#endif` paired; winsock headers before windows.h; _WIN32_WINNT>=0x0600.
- [ ] funcs length↔d.ts consistent; constant platform guards correct.
- [ ] §5 behavior specs Read re-checked everywhere (handles/close/accept/connect/length/getaddrinfo/errno).
- [ ] resolver thread touches only C data; resolve/reject Dup/Free on the main thread; free_handlers stop+broadcast+join+cleanup before WSACleanup/free(ts).
- [ ] Both platforms' no-more-events uses `resolver.outstanding==0` (not started); submit/drain counts paired; script exits naturally after async DNS.
- [ ] Win stdin console wait polls stop + `CancelSynchronousIo`/`CancelIoEx` + bounded join (250ms) + timeout orphan fallback.
- [ ] WSAStartup/Cleanup symmetric; ECANCELED exported and defined/fallback on Win.
- [ ] Makefile LIBS else -lws2_32 + test_socket.js.

### 7.2 CI (primary means)
- POSIX: linux-asan/ubsan/msan catch memory issues; linux/macos/freebsd/cosmopolitan/qemu-alpine multi-platform.
- Windows: mingw-windows (Wine)+windows-msys (native) run make test (including test_socket.js); verify Wine WSAPoll, fix specific quirks targetedly.
- Regression: test_worker.js (atomics waker+port+Win socketpair waker), test_std.js (POSIX), test_loop.js.

### 7.3 Completion criteria
Static checklist all ✅; CI both platforms+sanitizers all green; test_socket.js auto-terminates and assertions pass; test_worker/test_std no regression. Once satisfied, hand to the user to confirm commit/merge.

---

## 8. Execution Order
Step 0 branch → 1 structures → 2 helpers/errno → 3 registry+close → 4 unified handle_socket_message → 5 POSIX poll → 6 Win WSAPoll → 7 API+funcs+constants → 8 async DNS → 9 init/free → 10 Makefile → 11 d.ts/examples → 12 tests → 7.1 static re-check → Confirm Submission → CI verification.
