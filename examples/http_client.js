#!/usr/bin/env qjs
///@ts-check
/// <reference path="../doc/globals.d.ts" />
/// <reference path="../doc/os.d.ts" />
/// <reference path="../doc/std.d.ts" />
import * as os from "os";
import * as std from "std";

/** @template T @param {os.Result<T>} result */
function must(result) {
    if (typeof result === "number" && result < 0) throw new Error(std.strerror(-result));
    return /** @type {T} */ (result)
}
//USAGE: client.js wttr.in/paris
const uriRegexp = /^(?<host>[A-Za-z0-9\-\.]+)(?<port>:[0-9]+)?(?<query>.*)$/;
const { host = "bellard.org", port = ":80", query = "/" } = scriptArgs[1]?.match(uriRegexp)?.groups || {};
console.log("sending GET on",{ host, port, query })
// resolve DNS off the main loop so the event loop stays responsive
const [addr] = must(await os.getaddrinfoAsync(host, { service: port.slice(1) }));
const sockfd = must(os.socket(addr.family, addr.socktype));
await os.connect(sockfd, addr);
const httpReq = Uint8Array.from(`GET ${query||'/'} HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: curl\r\n\r\n`, c => c.charCodeAt(0))
// send the whole request: os.send() may write fewer bytes, so advance the
// offset until everything is written
const reqBuf = httpReq.buffer;
for (let offset = 0; offset < reqBuf.byteLength;) {
    const sent = await os.send(sockfd, reqBuf, reqBuf.byteLength - offset, offset);
    if (sent <= 0) throw new Error("send failed");
    offset += sent;
}
// HTTP/1.0: the server closes the connection at end of response, so read
// until EOF (recv resolves 0). Errors reject and propagate automatically.
const chunk = new Uint8Array(4096);
const parts = [];
for (;;) {
    const recvd = await os.recv(sockfd, chunk.buffer);
    if (recvd === 0) break;
    parts.push(String.fromCharCode(...chunk.subarray(0, recvd)));
}
os.close(sockfd);
console.log(parts.join(''));
