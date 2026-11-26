#!/usr/bin/env qjs
///@ts-check
/// <reference path="../doc/globals.d.ts" />
/// <reference path="../doc/os.d.ts" />
/// <reference path="../doc/std.d.ts" />
import * as os from "os";
import * as std from "std";// for std.strerror

const MIMES = new Map([
    ['html', 'text/html'],
    ['txt', 'text/plain'],
    ['css', 'text/css'],
    ['c', 'text/plain'],
    ['h', 'text/plain'],
    ['json', 'application/json'],
    ['mjs', 'application/javascript'],
    ['js', 'application/javascript'],
    ['', 'application/octet-stream'],
]);
/** @template T @param {os.Result<T>} result */
function must(result) {
    if (typeof result === "number" && result < 0) throw new Error(std.strerror(-result));
    return /** @type {T} */ (result)
}
/** Escape HTML special chars to avoid XSS in directory listings. @param {string} s */
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** Send a whole buffer, advancing the offset across partial sends.
 * @param {os.SocketHandle} fd @param {ArrayBuffer} buffer */
async function sendAll(fd, buffer) {
    let offset = 0;
    while (offset < buffer.byteLength) {
        const sent = await os.send(fd, buffer, buffer.byteLength - offset, offset);
        if (sent <= 0) throw new Error("send failed");
        offset += sent;
    }
}
/** Read lines from a socket with a large buffer (not one byte per recv).
 * Overlong lines are refused so that a client cannot grow the buffer at will.
 * @param {os.SocketHandle} fd */
async function* recvLines(fd) {
    const chunk = new Uint8Array(4096);
    const MAX_LINE = 16 * 1024;
    let buf = '';
    for (;;) {
        const n = await os.recv(fd, chunk.buffer);
        if (n === 0) break; // EOF
        buf += String.fromCharCode(...chunk.subarray(0, n));
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            yield buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
        }
        if (buf.length > MAX_LINE) throw new Error("header line too long");
    }
    if (buf) yield buf.replace(/\r$/, '');
}
/** Send response headers, adding Content-Length and Connection: close.
 * @param {os.SocketHandle} fd @param {string} status @param {string[]} headers @param {number} length */
async function sendHead(fd, status, headers, length) {
    const head = Uint8Array.from(
        [`HTTP/1.1 ${status}`, ...headers, `Content-Length: ${length}`, 'Connection: close', '', ''].join('\r\n'),
        c => c.charCodeAt(0));
    await sendAll(fd, head.buffer);
}
/** Send a complete response with a string body.
 * @param {os.SocketHandle} fd @param {string} status @param {string[]} headers @param {string} body */
async function sendResponse(fd, status, headers, body) {
    const bodyBuf = Uint8Array.from(body, c => c.charCodeAt(0));
    await sendHead(fd, status, headers, bodyBuf.byteLength);
    await sendAll(fd, bodyBuf.buffer);
}
//USAGE: qjs http_server.js [PORT=8080 [HOST=localhost]]
const [port = "8080", host = "localhost"] = scriptArgs.slice(1);
const [ai] = must(os.getaddrinfo(host, { service: port, socktype: os.SOCK_STREAM }));
const sock_srv = must(os.socket(ai.family, ai.socktype));
must(os.setsockopt(sock_srv, os.SO_REUSEADDR, new Uint32Array([1]).buffer));
must(os.bind(sock_srv, ai));
must(os.listen(sock_srv));
// closing the listening socket cancels the pending accept() (rejects it) and
// stops the loop below, also while a connection is being served
let closing = false;
os.signal(os.SIGINT, () => { closing = true; os.close(sock_srv); });
console.log(`Listening on http://${host}:${port} (${ai.addr}:${ai.port}) ...`);
if (os.exec) {
    const url = `http://${host}:${port}`;
    if (os.platform === 'win32') // 'start' is a cmd.exe builtin, not an executable
        os.exec(['cmd', '/c', 'start', '', url], { block: false });
    else {
        const openCmd = { linux: 'xdg-open', darwin: 'open' }[os.platform];
        if (openCmd) os.exec([openCmd, url], { block: false });
    }
}
// only serve files below the current directory; the trailing separator makes
// the prefix test work when the current directory is the filesystem root
const sep = os.platform === 'win32' ? '\\' : '/';
const baseDir = os.realpath('.')[0];
const basePrefix = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
for (;;) {
    let sock_cli;
    try {
        [sock_cli] = await os.accept(sock_srv);
    } catch (e) {
        if (closing)
            break;
        // transient failure (e.g. out of file descriptors): retry shortly
        console.log('accept failed:', std.strerror(-e));
        await os.sleepAsync(100);
        continue;
    }
    try {
        const lines = recvLines(sock_cli);
        const [method, path = '', http_ver] = ((await lines.next()).value || '').split(' ');
        let safe_path = '.' + path.replaceAll(/\.+/g, '.'); // collapse dots to block ".."
        console.log(method, safe_path, http_ver);

        const headers = new Map();
        for await (const line of lines) {
            const header = line.trimEnd();
            if (!header) break;
            const sepIdx = header.indexOf(': ');
            headers.set(header.slice(0, sepIdx), header.slice(sepIdx + 2));
        }

        let [obj, err] = os.stat(safe_path);
        if (obj?.mode & os.S_IFDIR && safe_path.endsWith('/') && os.stat(safe_path + 'index.html')[0]) {
            safe_path += 'index.html';
            [obj, err] = os.stat(safe_path);
        }
        // resolve symlinks and refuse to serve anything outside the base dir
        const [real, rerr] = os.realpath(safe_path);
        const outside = rerr || !(real === baseDir || real.startsWith(basePrefix));
        if (err) {
            await sendResponse(sock_cli, '404 Not Found', ['Content-Type: text/plain'], `${safe_path}\nerrno:${err}`);
        } else if (outside) {
            await sendResponse(sock_cli, '403 Forbidden', ['Content-Type: text/plain'], 'forbidden');
        } else if (obj?.mode & os.S_IFDIR) {
            if (!safe_path.endsWith('/'))
                await sendResponse(sock_cli, '301 Moved Permanently', [`Location: ${safe_path}/`], '');
            else {
                const entries = os.readdir(safe_path)[0]?.filter(e => e[0] != '.')
                    .map(e => `<li><a href="${escapeHtml(e)}">${escapeHtml(e)}</a></li>`).join('') || '';
                await sendResponse(sock_cli, '200 OK', ['Content-Type: text/html'], `<ul>${entries}</ul>`);
            }
        } else {
            const mime = MIMES.get(safe_path.split('.').at(-1) || '') || MIMES.get('');
            await sendHead(sock_cli, '200 OK', [`Content-Type: ${mime}`], obj.size);
            const fd = must(os.open(safe_path));
            const fbuf = new Uint8Array(4096);
            for (let got = 0; (got = os.read(fd, fbuf.buffer, 0, fbuf.byteLength)) > 0;) {
                await sendAll(sock_cli, fbuf.buffer.slice(0, got));
            }
            os.close(fd);
        }
    } catch (e) {
        // ignore client errors / disconnects
    }
    os.close(sock_cli);
}
