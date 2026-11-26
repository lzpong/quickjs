/**
 * Provides standard library functions: file I/O, environment, error codes.
 */
declare module "std" {
	type Branded<T, B> = T & { __brand: B };
	type FileDescriptor = Branded<number, "FileDescriptor">;
	/** errno values. On Windows the socket API reports Winsock values, so the socket errors below carry them there (same values as the WSAE* names). Compare against these constants, never hard-coded numbers. */
	interface StdError {
		EINVAL: number;
		EIO: number;
		EACCES: number;
		EEXIST: number;
		ENOSPC: number;
		ENOSYS: number;
		EBUSY: number;
		ENOENT: number;
		EPERM: number;
		EPIPE: number;
		EBADF: number;
		ECANCELED: number;
		ENOMEM: number;
		EMFILE: number;
		EINTR: number;
		/* socket errors, exported when the socket API is built in (USE_NETWORK) */
		EAGAIN: number;
		EWOULDBLOCK: number;
		EINPROGRESS: number;
		ECONNREFUSED: number;
		ECONNRESET: number;
		ECONNABORTED: number;
		ETIMEDOUT: number;
		EADDRINUSE: number;
		EADDRNOTAVAIL: number;
		ENOTCONN: number;
		ENOTSOCK: number;
		ENETUNREACH: number;
		ENETDOWN: number;
		EHOSTUNREACH: number;
		EOPNOTSUPP: number;
		ESHUTDOWN: number;
		EMSGSIZE: number;
		EISCONN: number;
		EALREADY: number;
		EAFNOSUPPORT: number;
		EPROTONOSUPPORT: number;
		ENOPROTOOPT: number;
		ENOBUFS: number;
		EFAULT: number;
		/* Windows-only Winsock names */
		WSAEWOULDBLOCK: number;
		WSAEINPROGRESS: number;
		WSAECONNREFUSED: number;
		WSAECONNRESET: number;
		WSAECONNABORTED: number;
		WSAETIMEDOUT: number;
		WSAEADDRINUSE: number;
		WSAEADDRNOTAVAIL: number;
		WSAENOTCONN: number;
		WSAENOTSOCK: number;
		WSAEINVAL: number;
		WSAEFAULT: number;
		WSAENETUNREACH: number;
		WSAENETDOWN: number;
		WSAEHOSTUNREACH: number;
		WSAEOPNOTSUPP: number;
		WSAESHUTDOWN: number;
		WSAEMSGSIZE: number;
		WSAEISCONN: number;
		WSAEALREADY: number;
		WSAEAFNOSUPPORT: number;
		WSAEPROTONOSUPPORT: number;
		WSAENOPROTOOPT: number;
		WSAENOBUFS: number;
	}
	export const Error: StdError;
	export const SEEK_SET: number;
	export const SEEK_CUR: number;
	export const SEEK_END: number;
	/** Exit the process with the given status. */
	export function exit(code?: number): void;
	/** Force a garbage collection cycle. */
	export function gc(): void;
	/** Evaluate a string as a script. */
	export function evalScript(str: string): any;
	/** Load and evaluate a script file. */
	export function loadScript(filename: string): void;
	/** Return the environment variable `name`, or undefined. */
	export function getenv(name: string): string | undefined;
	/** Set the environment variable `name` to `value`. */
	export function setenv(name: string, value: string): void;
	/** Remove the environment variable `name`. */
	export function unsetenv(name: string): void;
	/** Return the environment as key-value pairs. */
	export function getenviron(): { [key: string]: string };
	/** Download a URL and return its contents as a string (or null on error). */
	export function urlGet(url: string): string | null;
	/** Load a file and return its contents as a string (or null on error). */
	export function loadFile(filename: string): string | null;
	/** Return the error message for an errno value. */
	export function strerror(errno: number): string;
	/** Parse extended JSON. */
	export function parseExtJSON(str: string): any;
	/** Open a file. `flags` is a stdio mode string (e.g. "r", "w"). */
	export function open(filename: string, flags: string, errorObj?: object): FILE | null;
	/** Open a process pipe. */
	export function popen(command: string, flags: string, errorObj?: object): FILE | null;
	/** Wrap a file descriptor in a FILE. */
	export function fdopen(fd: FileDescriptor, flags: string, errorObj?: object): FILE | null;
	/** Create a temporary file. */
	export function tmpfile(errorObj?: object): FILE | null;
	/** Write a string to stdout. */
	export function puts(str: string): void;
	/** Formatted print to stdout. */
	export function printf(fmt: string, ...args: any[]): number;
	/** Formatted print to a string. */
	export function sprintf(fmt: string, ...args: any[]): string;

	export class FILE {
		close(): number;
		puts(str: string): void;
		printf(fmt: string, ...args: any[]): number;
		flush(): number;
		tell(): number;
		tello(): bigint;
		seek(offset: number, whence: number): number;
		eof(): boolean;
		fileno(): FileDescriptor;
		error(): number;
		clearerr(): void;
		read(buffer: ArrayBuffer, offset: number, length: number): number;
		write(buffer: ArrayBuffer, offset: number, length: number): number;
		getline(): string | null;
		readAsString(max_size?: number): string | null;
		getByte(): number;
		putByte(c: number): number;
	}
}
