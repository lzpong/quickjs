/**
 * Global helpers installed by qjs (js_std_add_helpers).
 */
declare var scriptArgs: string[];
declare var console: {
	log(...args: any[]): void;
};
declare function print(...args: any[]): void;
declare var performance: {
	/** Monotonic time in milliseconds. */
	now(): number;
};
declare function __loadScript(filename: string): void;
