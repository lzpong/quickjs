/**
 * Provides Operating System specific functions:
 * file access, sockets, signals, timers, async I/O, workers (threads)
 * The socket functions and constants (from `socket` on) are only exported when
 * the socket API is built in (`USE_NETWORK`, the default).
 */
declare module "os" {
	type Success = 0;
	type Errno = number;
	type NegativeErrno = number;
	type Result<T> = T | NegativeErrno;
	type ExitStatus = number;
	type WaitStatus = number;
	type Branded<T, B> = T & { __brand: B }; // Prevent interchangeable primitives (e.g. number)
	type OpenOption = Branded<number, "OpenOption">;
	type SocketFamily = Branded<number, "SocketFamily">;
	type SocketType = Branded<number, "SocketType">;
	type SocketOpt = Branded<number, "SocketOpt">;
	type SocketLevel = Branded<number, "SocketLevel">;
	type SocketShutOpt = Branded<number, "SocketShutOpt">;
	type MsgFlags = Branded<number, "MsgFlags">;
	type AddrInfoFlags = Branded<number, "AddrInfoFlags">;
	type NameInfoFlags = Branded<number, "NameInfoFlags">;
	type PollOpt = Branded<number, "PollOpt">;
	type PollRet = Branded<number, "PollRet">;
	type WaitpidOpt = Branded<number, "WaitpidOpt">;
	type FileDescriptor = Branded<number, "FileDescriptor">;
	/**
	 * A socket handle. Valid only within the runtime (thread) that created it,
	 * and only until it is closed. The async operations reject a handle that is
	 * not a live socket of this runtime with `-EBADF` right away.
	 */
	type SocketHandle = Branded<number, "SocketHandle">;
	type Signal = Branded<number, "Signal">;
	type StatMode = Branded<number, "StatMode">;
	type Pid = Branded<number, "Pid">;
	type TimerHandle = Branded<unknown, "TimerHandle">;
	type Callback = () => void;
	type Platform = "linux" | "darwin" | "win32" | "js";
	type WorkerMessage = any;

	interface ExecOptions {
		/**
		 * Boolean (default = `true`). If `true`, wait until the process is
		 * terminated. In this case, exec return the exit code if positive or the
		 * negated signal number if the process was interrupted by a signal. If
		 * false, do not block and return the process id of the child.
		 */
		block?: boolean;
		/** Is the file searched in the PATH @default true. */
		usePath?: boolean;
		/** Set the file to be executed @default args[0] */
		file?: string,
		/** The working directory of the new process */
		cwd?: string,
		/** Handler for stdin */
		stdin?: FileDescriptor,
		/** Handler for stdout */
		stdout?: FileDescriptor,
		/** Handler for stderr */
		stderr?: FileDescriptor,
		/** set the process environment from the object key-value pairs.
		 * If unset, it will inherit them from current process. */
		env?: { [key: string]: string },
		/** Process uid with `setuid` */
		uid?: number,
		/** Process gid with `setgid` */
		gid?: number,
	}
	type ExecNonBlockingOptions = ExecOptions & { block?: false };
	type ExecBlockingOptions = ExecOptions & { block: true };

	interface Stat {
		dev: number;
		ino: number;
		mode: StatMode;
		nlink: number;
		uid: number;
		gid: number;
		rdev: number;
		size: number;
		blocks: number;
		/** milliseconds since 1970 */
		atime: number;
		/** milliseconds since 1970 */
		mtime: number;
		/** milliseconds since 1970 */
		ctime: number;
	}
	interface SocketAddr {
		/** @example 80 */
		port: number;
		/** Numeric IP string @example "8.8.8.8" or "::1" */
		addr: string;
		/** Defaults to the socket family, or (without a socket, e.g. getnameinfo) to the family of `addr`. */
		family?: SocketFamily;
	}
	/**
	 * A flattened getaddrinfo() entry. `addr`/`port`/`family` are laid out so the
	 * entry can be passed directly to bind()/connect()/sendto().
	 */
	interface SocketAddrInfo extends SocketAddr {
		/** AI_* flags reported by the resolver. */
		flags: number;
		family: SocketFamily;
		socktype: SocketType;
		protocol: number;
		/** Canonical name, or null when not requested/available. */
		canonname: string | null;
	}
	interface HintAddr {
		/** @example 80 or "http" */
		service?: number | string;
		/** @default any */
		family?: SocketFamily;
		/** @default any */
		socktype?: SocketType;
		/** AI_* flags @default 0 */
		flags?: AddrInfoFlags;
	}
	/** Result of getnameinfo()/getnameinfoAsync(). */
	interface NameInfo {
		host: string;
		service: string;
	}
	/* Windows-specific open flags */
	export const O_TEXT: OpenOption;
	export const O_BINARY: OpenOption;
	/* POSIX constants */
	export const O_APPEND: OpenOption;
	export const O_CREAT: OpenOption;
	export const O_EXCL: OpenOption;
	export const O_RDONLY: OpenOption;
	export const O_RDWR: OpenOption;
	export const O_TRUNC: OpenOption;
	export const O_WRONLY: OpenOption;
	export const S_IFBLK: StatMode;
	export const S_IFCHR: StatMode;
	export const S_IFDIR: StatMode;
	export const S_IFIFO: StatMode;
	export const S_IFMT: StatMode;
	export const S_IFREG: StatMode;
	/* POSIX-only stat mode bits */
	export const S_IFLNK: StatMode;
	export const S_IFSOCK: StatMode;
	export const S_ISGID: StatMode;
	export const S_ISUID: StatMode;
	export const SIGABRT: Signal;
	export const SIGFPE: Signal;
	export const SIGILL: Signal;
	export const SIGINT: Signal;
	export const SIGSEGV: Signal;
	export const SIGTERM: Signal;
	/* POSIX-only signals */
	export const SIGALRM: Signal;
	export const SIGCHLD: Signal;
	export const SIGCONT: Signal;
	export const SIGPIPE: Signal;
	export const SIGQUIT: Signal;
	export const SIGSTOP: Signal;
	export const SIGTSTP: Signal;
	export const SIGTTIN: Signal;
	export const SIGTTOU: Signal;
	export const SIGUSR1: Signal;
	export const SIGUSR2: Signal;
	export const WNOHANG: WaitpidOpt;
	export const AF_INET: SocketFamily;
	export const AF_INET6: SocketFamily;
	/** Not exported where the socket headers lack AF_UNIX (some Windows SDKs). */
	export const AF_UNIX: SocketFamily;
	export const SOCK_STREAM: SocketType;
	export const SOCK_DGRAM: SocketType;
	export const SOCK_RAW: SocketType;
	export const SOL_SOCKET: SocketLevel;
	export const SO_REUSEADDR: SocketOpt;
	export const SO_ERROR: SocketOpt;
	export const SO_RCVBUF: SocketOpt;
	export const SO_SNDBUF: SocketOpt;
	export const SO_KEEPALIVE: SocketOpt;
	export const SO_BROADCAST: SocketOpt;
	export const IPPROTO_IP: SocketLevel;
	export const IPPROTO_TCP: SocketLevel;
	export const IPPROTO_UDP: SocketLevel;
	export const IPPROTO_IPV6: SocketLevel;
	export const TCP_NODELAY: SocketOpt;
	/* multicast */
	export const IP_ADD_MEMBERSHIP: SocketOpt;
	export const IP_DROP_MEMBERSHIP: SocketOpt;
	export const IP_MULTICAST_IF: SocketOpt;
	export const IP_MULTICAST_TTL: SocketOpt;
	export const IP_MULTICAST_LOOP: SocketOpt;
	export const IPV6_JOIN_GROUP: SocketOpt;
	export const IPV6_LEAVE_GROUP: SocketOpt;
	export const IPV6_MULTICAST_IF: SocketOpt;
	export const IPV6_MULTICAST_HOPS: SocketOpt;
	export const IPV6_MULTICAST_LOOP: SocketOpt;
	/* sockopt extensions */
	export const IPV6_V6ONLY: SocketOpt;
	export const SO_LINGER: SocketOpt;
	export const SO_RCVTIMEO: SocketOpt;
	export const SO_SNDTIMEO: SocketOpt;
	export const SO_ACCEPTCONN: SocketOpt;
	export const SO_TYPE: SocketOpt;
	export const IP_TTL: SocketOpt;
	export const IP_TOS: SocketOpt;
	/* platform-dependent sockopt extensions (not available everywhere) */
	export const SO_REUSEPORT: SocketOpt;
	export const SO_PROTOCOL: SocketOpt;
	export const SO_DOMAIN: SocketOpt;
	export const TCP_KEEPIDLE: SocketOpt;
	export const TCP_KEEPINTVL: SocketOpt;
	export const TCP_KEEPCNT: SocketOpt;
	/* shutdown() how (Windows maps to SD_RECEIVE/SD_SEND/SD_BOTH) */
	export const SHUT_RD: SocketShutOpt;
	export const SHUT_WR: SocketShutOpt;
	export const SHUT_RDWR: SocketShutOpt;
	/* recv/send flags */
	export const MSG_PEEK: MsgFlags;
	export const MSG_OOB: MsgFlags;
	/** Ignored on Windows: non-blocking Winsock sockets reject it. */
	export const MSG_WAITALL: MsgFlags;
	/* POSIX-only recv/send flags */
	export const MSG_DONTWAIT: MsgFlags;
	export const MSG_TRUNC: MsgFlags;
	export const MSG_NOSIGNAL: MsgFlags;
	/* getaddrinfo hints flags */
	export const AI_PASSIVE: AddrInfoFlags;
	export const AI_CANONNAME: AddrInfoFlags;
	export const AI_NUMERICHOST: AddrInfoFlags;
	export const AI_NUMERICSERV: AddrInfoFlags;
	export const AI_V4MAPPED: AddrInfoFlags;
	export const AI_ALL: AddrInfoFlags;
	export const AI_ADDRCONFIG: AddrInfoFlags;
	/* getnameinfo flags */
	export const NI_NUMERICHOST: NameInfoFlags;
	export const NI_NUMERICSERV: NameInfoFlags;
	export const NI_NOFQDN: NameInfoFlags;
	export const NI_NAMEREQD: NameInfoFlags;
	export const NI_DGRAM: NameInfoFlags;
	/* getaddrinfo/getnameinfo error codes (returned negated). Compare against
	   these constants, never hard-coded numbers: on POSIX they share the numeric
	   space with the errno values, on Windows they carry Winsock values (the
	   WSA* names) like the other socket errors */
	export const EAI_AGAIN: Errno;
	export const EAI_BADFLAGS: Errno;
	export const EAI_FAIL: Errno;
	export const EAI_FAMILY: Errno;
	export const EAI_MEMORY: Errno;
	export const EAI_NONAME: Errno;
	export const EAI_SERVICE: Errno;
	export const EAI_SOCKTYPE: Errno;
	export const EAI_SYSTEM: Errno;
	export const EAI_OVERFLOW: Errno;
	/** string representing the platform. */
	export const platform: Platform;
	/** Open a file. `flags` defaults to read-only. Return a handle or `< 0` if error. */
	export function open(filename: string, flags?: OpenOption, mode?: number): Result<FileDescriptor>;
	/** Close a file handle or socket. For sockets, pending operations are cancelled (reject `-ECANCELED`). An out-of-range file handle returns `-EBADF`. */
	export function close(fd: FileDescriptor | SocketHandle): Result<Success>;
	/** Seek in the file. Use `std.SEEK_*` for whence */
	export function seek(fd: FileDescriptor, offset: number, whence: number): Result<number>;
	export function seek(fd: FileDescriptor, offset: bigint, whence: number): Result<bigint>;
	/** Read `length` bytes from the file handle `fd` to the `ArrayBuffer` buffer at byte position `offset` */
	export function read(fd: FileDescriptor, buffer: ArrayBuffer, offset: number, length: number): Result<number>;
	/** Write `length` bytes to the file handle `fd` from the ArrayBuffer `buffer` at byte position `offset` */
	export function write(fd: FileDescriptor, buffer: ArrayBuffer, offset: number, length: number): Result<number>;
	/** Return `true` is fd is a TTY (terminal) handle. */
	export function isatty(fd: FileDescriptor): boolean;
	/** Return the TTY size as `[width, height]` or `null` if not available. */
	export function ttyGetWinSize(fd: FileDescriptor): [width: number, height: number] | null;
	/** Set the TTY in raw mode. */
	export function ttySetRaw(fd: FileDescriptor): void;
	/** Remove a file. */
	export function remove(filename: string): Result<Success>;
	/** Rename a file from `oldpath` to `newpath`. */
	export function rename(oldpath: string, newpath: string): Result<Success>;
	/** Get the canonicalized absolute pathname of `path` */
	export function realpath(path: string): [absPath: string, code: Success | Errno];
	/** Return the current working directory */
	export function getcwd(): [cwd: string, code: Success | Errno];
	/** Change the current directory to `path`. Return 0 if OK or `-errno`. */
	export function chdir(path: string): Result<Success>;
	/** Create a directory at `path`. Return 0 if OK or `-errno`. */
	export function mkdir(path: string, mode?: number): Result<Success>;
	/** Get a file status */
	export function stat(path: string): [fileStatus: Stat, code: Success | Errno]
	/** Get a link status (POSIX only) */
	export function lstat(path: string): [linkStatus: Stat, code: Success | Errno]
	/** Change the access and modification times of the file `path` @returns ms since 1970. */
	export function utimes(path: string, atime: number, mtime: number): Result<Success>;
	/** Create a link at `linkpath` containing the string `target` (POSIX only). */
	export function symlink(target: string, linkpath: string): Result<Success>;
	/** Get link target (POSIX only) */
	export function readlink(path: string): [linkTarget: string, code: Success | Errno];
	/** List directory entries */
	export function readdir(dirPath: string): [dirFilenames: string[], code: Success | Errno];
	/** Set the single `func` read handler to be called each time data can be read from `fd`. */
	export function setReadHandler(fd: FileDescriptor, func: Callback): void;
	/** Remove the read handler for `fd`. */
	export function setReadHandler(fd: FileDescriptor, func: null): void;
	/** Set the single `func` write handler to be called each time data can be written to `fd`. */
	export function setWriteHandler(fd: FileDescriptor, func: Callback): void;
	/** Remove the write handler for `fd`. */
	export function setWriteHandler(fd: FileDescriptor, func: null): void;
	/** Set the single `func` to be called when `signal` happens. Work in main thread only */
	export function signal(signal: Signal, func: Callback): void
	/** Call the default handler when `signal` happens. */
	export function signal(signal: Signal, func: null): void
	/** Ignore when `signal` happens. */
	export function signal(signal: Signal, func: undefined): void
	/** Send the signal `sig` to the process `pid` (POSIX only). */
	export function kill(pid: Pid, signal: Signal): Result<number>;
	/** Execute a process with the arguments args (POSIX only). */
	export function exec(args: string[], options?: ExecBlockingOptions): Result<ExitStatus>;
	/** Execute a process with the arguments args (POSIX only). */
	export function exec(args: string[], options: ExecNonBlockingOptions): Result<Pid>;
	/** `waitpid` Unix system call (POSIX only). */
	export function waitpid(pid: Pid, options: WaitpidOpt): [ret: Result<Pid | Success>, status: WaitStatus];
	/** `getpid` Unix system call (POSIX only). */
	export function getpid(): Result<Pid>;
	/** `dup` Unix system call (POSIX only). */
	export function dup(fd: FileDescriptor): Result<FileDescriptor>;
	/** `dup2` Unix system call (POSIX only). */
	export function dup2(oldFd: FileDescriptor, newFd: FileDescriptor): Result<FileDescriptor>;
	/** `pipe` Unix system call (POSIX only). */
	export function pipe(): [readFd: FileDescriptor, writeFd: FileDescriptor] | null;
	/** Return the current time in milliseconds (monotonic). */
	export function now(): number;
	/** Sleep during `delay_ms` milliseconds. */
	export function sleep(delay_ms: number): Result<number>;
	/** Sleep during `delay_ms` milliseconds. Resolves to `undefined`. */
	export function sleepAsync(delay_ms: number): Promise<undefined>;
	/** Call the function func after `delay` ms. */
	export function setTimeout(func: Callback, delay: number): TimerHandle;
	/** Cancel a timer. */
	export function clearTimeout(handle: TimerHandle): void;
	/** Create a non-blocking socket. `protocol` defaults to 0. */
	export function socket(family: SocketFamily, type: SocketType, protocol?: number): Result<SocketHandle>;
	/** Get a socket option, stored into `data`. Returns the number of bytes written (>=0) or `-errno`. `level` defaults to `SOL_SOCKET`. @example os.getsockopt(sock, os.SO_RCVBUF, new Uint32Array(1).buffer) */
	export function getsockopt(sockfd: SocketHandle, name: SocketOpt, data: ArrayBuffer, level?: SocketLevel): Result<number>;
	/** Set a socket option from `data`. `level` defaults to `SOL_SOCKET`. For multicast membership use an ArrayBuffer of exactly the option size (e.g. 8 bytes for ip_mreq). @example os.setsockopt(sock, os.SO_REUSEADDR, new Uint32Array([1]).buffer) */
	export function setsockopt(sockfd: SocketHandle, name: SocketOpt, data: ArrayBuffer, level?: SocketLevel): Result<Success>;
	/**
	 * Get address information for a given node and/or service. A `null` node
	 * with the AI_PASSIVE flag yields the wildcard address to bind to.
	 * Returns `-EAI_*` on error.
	 * @example os.getaddrinfo("localhost", {service: "80", socktype: os.SOCK_STREAM})
	 */
	export function getaddrinfo(node: string | null | undefined, hint?: HintAddr): Result<Array<SocketAddrInfo>>;
	/** Non-blocking getaddrinfo() resolved on a worker thread. Rejects with `-EAI_*` on error. Requests are served one at a time, so a slow lookup delays the ones queued behind it. */
	export function getaddrinfoAsync(node: string | null | undefined, hint?: HintAddr): Promise<Array<SocketAddrInfo>>;
	/** Reverse-resolve a sockaddr to host/service names. `flags` are NI_*. Returns `-EAI_*` on error. */
	export function getnameinfo(addr: SocketAddr, flags?: NameInfoFlags): Result<NameInfo>;
	/** Non-blocking getnameinfo() resolved on a worker thread. Rejects with `-EAI_*` on error. */
	export function getnameinfoAsync(addr: SocketAddr, flags?: NameInfoFlags): Promise<NameInfo>;
	/** Return the local host name, or `-errno`. */
	export function gethostname(): Result<string>;
	/** Convert a binary address (ArrayBuffer of 4 bytes for AF_INET, 16 for AF_INET6) to a string. */
	export function inet_ntop(family: SocketFamily, addr: ArrayBuffer): Result<string>;
	/** Convert an address string to a binary ArrayBuffer (4 bytes for AF_INET, 16 for AF_INET6). */
	export function inet_pton(family: SocketFamily, addr: string): Result<ArrayBuffer>;
	/** Create a pair of connected non-blocking sockets. POSIX uses socketpair(domain, type); Windows ignores the arguments and returns a loopback TCP pair. `domain` defaults to AF_UNIX, `type` to SOCK_STREAM. */
	export function socketpair(domain?: SocketFamily, type?: SocketType): Result<[SocketHandle, SocketHandle]>;
	/** Get current address to which the socket sockfd is bound */
	export function getsockname(sockfd: SocketHandle): Result<SocketAddr>;
	/** Get address of the peer connected to the socket sockfd */
	export function getpeername(sockfd: SocketHandle): Result<SocketAddr>;
	/** Bind socket to a specific address */
	export function bind(sockfd: SocketHandle, addr: SocketAddr): Result<Success>;
	/** Mark `sockfd` as passive socket that will `accept()` a `backlog` number of incoming connection (SOMAXCONN by default). */
	export function listen(sockfd: SocketHandle, backlog?: number): Result<Success>;
	/** Shut down part of a full-duplex connection */
	export function shutdown(sockfd: SocketHandle, how: SocketShutOpt): Result<Success>;
	/**
	 * Accept incoming connections. Resolves `[remotefd, remoteaddr]`, rejects
	 * with `-errno` on error. A failed accept (e.g. -EMFILE) ends the pending
	 * request: call accept() again to go on.
	 */
	export function accept(sockfd: SocketHandle): Promise<[remotefd: SocketHandle, remoteaddr: SocketAddr]>;
	/**
	 * Connect `sockfd` to `addr`. Resolves 0 on success, rejects with `-errno`
	 * on error (never a synchronous throw).
	 */
	export function connect(sockfd: SocketHandle, addr: SocketAddr): Promise<Success>;
	/**
	 * Send up to `length` bytes from `buffer` (starting at byte `offset`) on
	 * `sockfd`. `flags` are MSG_*. Resolves bytes sent, rejects with `-errno`.
	 *
	 * `length` defaults to the rest of the buffer from `offset`. The range
	 * `offset .. offset+length` must lie inside the buffer, otherwise a
	 * RangeError is thrown. A `length` of 0 sends nothing and resolves to 0.
	 * While the operation is pending the buffer may be detached or resized:
	 * the operation then rejects with `-EINVAL` if the range no longer fits.
	 * On POSIX a closed peer never raises SIGPIPE: the error is `-EPIPE`.
	 */
	export function send(sockfd: SocketHandle, buffer: ArrayBuffer, length?: number, offset?: number, flags?: MsgFlags): Promise<number>;
	/**
	 * Receive up to `length` bytes into `buffer` (starting at byte `offset`)
	 * from `sockfd`. `flags` are MSG_*. Resolves bytes received, 0 on EOF;
	 * rejects with `-errno`. Same range rules as send(), except that a
	 * `length` of 0 is refused (RangeError) because 0 means end of stream.
	 */
	export function recv(sockfd: SocketHandle, buffer: ArrayBuffer, length?: number, offset?: number, flags?: MsgFlags): Promise<number>;
	/**
	 * Send up to `length` bytes from `buffer` (starting at byte `offset`) on
	 * `sockfd` to `addr`. Same rules as send().
	 */
	export function sendto(sockfd: SocketHandle, addr: SocketAddr, buffer: ArrayBuffer, length?: number, offset?: number, flags?: MsgFlags): Promise<number>;
	/**
	 * Receive up to `length` bytes into `buffer` (starting at byte `offset`)
	 * from `sockfd`. Same rules as recv(). Resolves `[bytesReceived, remoteAddr]`.
	 */
	export function recvfrom(sockfd: SocketHandle, buffer: ArrayBuffer, length?: number, offset?: number, flags?: MsgFlags): Promise<[total: number, from: SocketAddr]>;

	export class Worker {
		/**
		 * In the created worker, `Worker.parent` represents the parent worker
		 * and is used to send or receive messages.
		 */
		static parent?: Worker;
		/**
		 * Constructor to create a new thread (worker) with an API close to
		 * the `WebWorkers`. `module_filename` is a string specifying the
		 * module filename which is executed in the newly created thread. As
		 * for dynamically imported module, it is relative to the current
		 * script or module path. Threads normally don’t share any data and
		 * communicate between each other with messages. Nested workers are
		 * not supported. An example is available in `tests/test_worker.js`.
		 */
		constructor(module_filename: string);
		/**
		 * Send a message to the corresponding worker. msg is cloned in the
		 * destination worker using an algorithm similar to the HTML structured
		 * clone algorithm. SharedArrayBuffer are shared between workers.
		 *
		 * Current limitations: `Map` and `Set` are not supported yet.
		 */
		postMessage(msg: WorkerMessage): void;
		/**
		 * Getter and setter. Set a function which is called each time a
		 * message is received. The function is called with a single argument.
		 * It is an object with a `data` property containing the received
		 * message. The thread is not terminated if there is at least one non
		 * `null` onmessage handler.
		 */
		onmessage: ((event: { data: WorkerMessage }) => void) | null;
	}
}
