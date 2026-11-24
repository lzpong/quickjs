/* Socket API tests: inet conversion, DNS (sync/async), socketpair, TCP/UDP
   loopback, MSG_* flags, multicast smoke, close-cancellation and arg parsing.
   Every test closes its own sockets; the suite drains the event loop and exits
   naturally on success. A watchdog forces a non-zero exit if anything stalls. */
import * as std from "std";
import * as os from "os";
import { assert, assertThrows, assertArrayEquals } from "./assert.js";

const watchdog = os.setTimeout(() => {
    console.log("FAIL: test_socket.js timed out");
    std.exit(1);
}, 30000);

/* ASCII helpers (no TextEncoder dependency) */
function strToBuf(s) {
    const ab = new ArrayBuffer(s.length);
    const u = new Uint8Array(ab);
    for (let i = 0; i < s.length; i++)
        u[i] = s.charCodeAt(i);
    return ab;
}
function bufToStr(ab, n) {
    const u = new Uint8Array(ab);
    let s = "";
    for (let i = 0; i < n; i++)
        s += String.fromCharCode(u[i]);
    return s;
}
function bytes(ab) {
    return Array.from(new Uint8Array(ab));
}

function test_inet() {
    /* IPv4 round-trip */
    const b4 = os.inet_pton(os.AF_INET, "127.0.0.1");
    assert(b4 instanceof ArrayBuffer);
    assert(b4.byteLength, 4);
    assert(os.inet_ntop(os.AF_INET, b4), "127.0.0.1");
    assertArrayEquals(bytes(b4), [127, 0, 0, 1]);
    /* IPv6 round-trip; re-parse the printed form to normalize compression/case */
    const b6 = os.inet_pton(os.AF_INET6, "2001:db8::1");
    assert(b6 instanceof ArrayBuffer);
    assert(b6.byteLength, 16);
    const s6 = os.inet_ntop(os.AF_INET6, b6);
    assert(typeof s6, "string");
    assertArrayEquals(bytes(b6), bytes(os.inet_pton(os.AF_INET6, s6)));
    assert(os.inet_ntop(os.AF_INET6, os.inet_pton(os.AF_INET6, "::1")), "::1");
    /* error paths */
    assert(os.inet_pton(os.AF_INET, "not-an-ip"), -std.Error.EINVAL);
    assert(os.inet_pton(os.AF_INET, "1.2.3.4.5"), -std.Error.EINVAL);
    assertThrows(TypeError, () => os.inet_pton(9999, "1.2.3.4"));
    assertThrows(RangeError, () => os.inet_ntop(os.AF_INET, new ArrayBuffer(3)));
}

function test_gethostname() {
    const h = os.gethostname();
    assert(typeof h, "string");
    assert(h.length > 0, true, "empty hostname");
}

async function test_getaddrinfo() {
    const hints = {
        service: "80",
        family: os.AF_INET,
        socktype: os.SOCK_STREAM,
        flags: os.AI_NUMERICHOST | os.AI_NUMERICSERV,
    };
    /* numeric host + numeric service: deterministic, no DNS lookup */
    const check = (ais) => {
        assert(Array.isArray(ais), true, "getaddrinfo result not an array");
        assert(ais.length >= 1, true, "empty getaddrinfo result");
        const a = ais[0];
        assert(a.addr, "127.0.0.1");
        assert(a.port, 80);
        assert(a.family, os.AF_INET);
        assert(a.socktype, os.SOCK_STREAM);
        assert(a.protocol === os.IPPROTO_TCP || a.protocol === 0, true,
               "unexpected protocol " + a.protocol);
        assert(a.canonname, null);
        assert(typeof a.flags, "number");
    };
    check(os.getaddrinfo("127.0.0.1", hints));
    check(await os.getaddrinfoAsync("127.0.0.1", hints));

    /* unknown service: EAI_SERVICE on POSIX, some stacks report EAI_NONAME */
    const bad = { service: "definitely-not-a-service-12345", socktype: os.SOCK_STREAM };
    const isServiceErr = (r) => r === -os.EAI_SERVICE || r === -os.EAI_NONAME;
    const r = os.getaddrinfo("127.0.0.1", bad);
    assert(isServiceErr(r), true, "expected -EAI_SERVICE/-EAI_NONAME, got " + r);
    let rej = null;
    try {
        await os.getaddrinfoAsync("127.0.0.1", bad);
    } catch (e) {
        rej = e;
    }
    assert(isServiceErr(rej), true, "async expected -EAI_SERVICE/-EAI_NONAME, got " + rej);
}

async function test_getnameinfo() {
    const addr = { family: os.AF_INET, addr: "127.0.0.1", port: 80 };
    const flags = os.NI_NUMERICHOST | os.NI_NUMERICSERV;
    const ni = os.getnameinfo(addr, flags);
    assert(ni.host, "127.0.0.1");
    assert(ni.service, "80");
    const ni2 = await os.getnameinfoAsync(addr, flags);
    assert(ni2.host, "127.0.0.1");
    assert(ni2.service, "80");
}

async function test_socketpair() {
    const pair = os.socketpair();
    assert(Array.isArray(pair), true, "socketpair failed: " + pair);
    const [a, b] = pair;
    try {
        /* two pending recvs on the same socket; length=5 each so the stream
           is split across them instead of coalesced into one read */
        const b1 = new ArrayBuffer(5), b2 = new ArrayBuffer(5);
        const r1 = os.recv(a, b1, 5);
        const r2 = os.recv(a, b2, 5);
        const msg = strToBuf("helloworld");
        assert(await os.send(b, msg, 10), 10);
        assert(await r1, 5);
        assert(await r2, 5);
        assert(bufToStr(b1, 5), "hello");
        assert(bufToStr(b2, 5), "world");
        /* reverse direction */
        const back = strToBuf("ok");
        assert(await os.send(a, back, 2), 2);
        const bb = new ArrayBuffer(2);
        assert(bufToStr(bb, await os.recv(b, bb, 2)), "ok");
    } finally {
        os.close(a);
        os.close(b);
    }
}

async function test_tcp() {
    const listener = os.socket(os.AF_INET, os.SOCK_STREAM);
    assert(listener >= 0, true, "socket failed: " + listener);
    let client = -1, server = -1;
    try {
        assert(os.setsockopt(listener, os.SO_REUSEADDR, new Uint32Array([1]).buffer), 0);
        const typeBuf = new ArrayBuffer(4);
        assert(os.getsockopt(listener, os.SO_TYPE, typeBuf), 4);
        assert(new Uint32Array(typeBuf)[0], os.SOCK_STREAM);
        assert(os.bind(listener, { family: os.AF_INET, addr: "127.0.0.1", port: 0 }), 0);
        const sa = os.getsockname(listener);
        assert(sa.addr, "127.0.0.1");
        assert(sa.port > 0, true, "ephemeral port not assigned");
        assert(os.listen(listener, 4), 0);

        const acceptP = os.accept(listener);
        client = os.socket(os.AF_INET, os.SOCK_STREAM);
        assert(client >= 0, true, "client socket failed: " + client);
        assert(await os.connect(client, { family: os.AF_INET, addr: "127.0.0.1", port: sa.port }), 0);
        const [srv, peerAddr] = await acceptP;
        server = srv;
        assert(server >= 0, true, "accept failed: " + server);
        assert(peerAddr.addr, "127.0.0.1");
        assert(peerAddr.port > 0, true);

        /* names in both directions */
        const cp = os.getpeername(client);
        assert(cp.addr, "127.0.0.1");
        assert(cp.port, sa.port);
        const sp = os.getpeername(server);
        assert(sp.addr, "127.0.0.1");
        assert(sp.port, cp.port);
        assert(os.getsockname(server).port, sa.port);

        /* connect completed with no error */
        const errBuf = new ArrayBuffer(4);
        assert(os.getsockopt(client, os.SO_ERROR, errBuf), 4);
        assert(new Uint32Array(errBuf)[0], 0);

        /* request / response */
        const msg = strToBuf("ping-pong");
        assert(await os.send(client, msg, msg.byteLength), msg.byteLength);
        const rbuf = new ArrayBuffer(16);
        const n = await os.recv(server, rbuf, 16);
        assert(n, msg.byteLength);
        assert(bufToStr(rbuf, n), "ping-pong");
        const reply = strToBuf("pong");
        assert(await os.send(server, reply, reply.byteLength), reply.byteLength);
        const rbuf2 = new ArrayBuffer(16);
        assert(bufToStr(rbuf2, await os.recv(client, rbuf2, 16)), "pong");

        /* half-close: peer sees EOF (recv resolves 0) */
        assert(os.shutdown(client, os.SHUT_WR), 0);
        assert(await os.recv(server, new ArrayBuffer(8), 8), 0);
    } finally {
        if (client >= 0) os.close(client);
        if (server >= 0) os.close(server);
        os.close(listener);
    }
}

async function test_udp() {
    const s1 = os.socket(os.AF_INET, os.SOCK_DGRAM);
    const s2 = os.socket(os.AF_INET, os.SOCK_DGRAM);
    assert(s1 >= 0 && s2 >= 0, true, "udp socket failed");
    try {
        assert(os.bind(s1, { family: os.AF_INET, addr: "127.0.0.1", port: 0 }), 0);
        assert(os.bind(s2, { family: os.AF_INET, addr: "127.0.0.1", port: 0 }), 0);
        const a1 = os.getsockname(s1), a2 = os.getsockname(s2);
        /* two pending recvfrom on the same socket; loopback preserves order */
        const b1 = new ArrayBuffer(16), b2 = new ArrayBuffer(16);
        const p1 = os.recvfrom(s1, b1, 16);
        const p2 = os.recvfrom(s1, b2, 16);
        const d1 = strToBuf("datagram-1"), d2 = strToBuf("datagram-2");
        assert(await os.sendto(s2, a1, d1, d1.byteLength), d1.byteLength);
        assert(await os.sendto(s2, a1, d2, d2.byteLength), d2.byteLength);
        const [n1, from1] = await p1;
        const [n2, from2] = await p2;
        assert(bufToStr(b1, n1), "datagram-1");
        assert(bufToStr(b2, n2), "datagram-2");
        assert(from1.addr, "127.0.0.1");
        assert(from1.port, a2.port);
        assert(from2.addr, "127.0.0.1");
        assert(from2.port, a2.port);
    } finally {
        os.close(s1);
        os.close(s2);
    }
}

async function test_msg_flags() {
    const pair = os.socketpair();
    assert(Array.isArray(pair), true, "socketpair failed: " + pair);
    const [a, b] = pair;
    try {
        const msg = strToBuf("0123456789");
        assert(await os.send(b, msg, 10), 10);
        /* let the bytes land so MSG_WAITALL completes without blocking */
        await os.sleepAsync(50);
        /* PEEK reads without consuming */
        const pb = new ArrayBuffer(10);
        assert(await os.recv(a, pb, 10, 0, os.MSG_PEEK), 10);
        assert(bufToStr(pb, 10), "0123456789");
        /* WAITALL still sees all 10 bytes (peek did not consume them) */
        const wb = new ArrayBuffer(10);
        assert(await os.recv(a, wb, 10, 0, os.MSG_WAITALL), 10);
        assert(bufToStr(wb, 10), "0123456789");
    } finally {
        os.close(a);
        os.close(b);
    }
}

async function test_multicast() {
    let sock = os.socket(os.AF_INET, os.SOCK_DGRAM);
    if (sock < 0) {
        console.log("SKIP: multicast (no UDP socket)");
        return;
    }
    try {
        if (os.bind(sock, { family: os.AF_INET, addr: "0.0.0.0", port: 0 }) < 0) {
            console.log("SKIP: multicast (bind failed)");
            return;
        }
        const group = os.inet_pton(os.AF_INET, "239.255.0.1");
        const iface = os.inet_pton(os.AF_INET, "127.0.0.1");
        /* struct ip_mreq: 4-byte group address + 4-byte interface address */
        const mreq = new ArrayBuffer(8);
        new Uint8Array(mreq).set(new Uint8Array(group), 0);
        new Uint8Array(mreq).set(new Uint8Array(iface), 4);
        if (os.setsockopt(sock, os.IP_ADD_MEMBERSHIP, mreq, os.IPPROTO_IP) < 0) {
            console.log("SKIP: multicast (join failed)");
            return;
        }
        os.setsockopt(sock, os.IP_MULTICAST_LOOP, new Uint32Array([1]).buffer, os.IPPROTO_IP);
        os.setsockopt(sock, os.IP_MULTICAST_IF, iface, os.IPPROTO_IP);
        const local = os.getsockname(sock);
        const dest = { family: os.AF_INET, addr: "239.255.0.1", port: local.port };
        const msg = strToBuf("multicast-hello");
        const rbuf = new ArrayBuffer(32);
        const rp = os.recvfrom(sock, rbuf, 32);
        await os.sendto(sock, dest, msg, msg.byteLength);
        /* best-effort: skip (not fail) if loopback delivery does not arrive */
        let timer;
        const timeout = new Promise(res => { timer = os.setTimeout(() => res("timeout"), 2000); });
        const res = await Promise.race([rp, timeout]);
        os.clearTimeout(timer);
        if (res === "timeout") {
            rp.catch(() => {});
            os.close(sock); /* cancel the pending recvfrom */
            sock = -1;
            console.log("SKIP: multicast (no loopback delivery)");
            return;
        }
        const [n, from] = res;
        assert(bufToStr(rbuf, n), "multicast-hello");
        assert(from.port, local.port);
        assert(typeof from.addr, "string");
        assert(from.addr.length > 0, true);
        os.setsockopt(sock, os.IP_DROP_MEMBERSHIP, mreq, os.IPPROTO_IP);
    } finally {
        if (sock >= 0) os.close(sock);
    }
}

async function test_close_cancel() {
    /* closing a socket rejects its pending recv with -ECANCELED */
    const pair = os.socketpair();
    assert(Array.isArray(pair), true, "socketpair failed: " + pair);
    const [a, b] = pair;
    let caught = null;
    const done = os.recv(a, new ArrayBuffer(8), 8).catch(e => { caught = e; });
    os.close(a);
    await done;
    assert(caught, -std.Error.ECANCELED);
    os.close(b);

    /* same for a pending accept on a listening socket */
    const l = os.socket(os.AF_INET, os.SOCK_STREAM);
    assert(l >= 0, true, "socket failed: " + l);
    assert(os.bind(l, { family: os.AF_INET, addr: "127.0.0.1", port: 0 }), 0);
    assert(os.listen(l, 1), 0);
    let caught2 = null;
    const done2 = os.accept(l).catch(e => { caught2 = e; });
    os.close(l);
    await done2;
    assert(caught2, -std.Error.ECANCELED);
}

async function test_args() {
    const pair = os.socketpair();
    assert(Array.isArray(pair), true, "socketpair failed: " + pair);
    const [a, b] = pair;
    try {
        /* length == 0 is a synchronous RangeError on all four ops */
        assertThrows(RangeError, () => os.recv(a, new ArrayBuffer(8), 0));
        assertThrows(RangeError, () => os.send(a, new ArrayBuffer(8), 0));
        assertThrows(RangeError, () => os.recvfrom(a, new ArrayBuffer(8), 0));
        assertThrows(RangeError, () => os.sendto(a, { addr: "127.0.0.1", port: 1 }, new ArrayBuffer(8), 0));
        /* buffers must be ArrayBuffer, not a TypedArray view */
        assertThrows(TypeError, () => os.recv(a, new Uint8Array(8), 8));

        /* length clamps to the buffer size; offset+length clamp to the tail */
        const msg = strToBuf("abcdef");
        assert(await os.send(b, msg, 100), 6);
        const rb = new ArrayBuffer(8);
        assert(await os.recv(a, rb, 100, 6), 2);
        const u = new Uint8Array(rb);
        assert(u[6], "a".charCodeAt(0));
        assert(u[7], "b".charCodeAt(0));
    } finally {
        os.close(a);
        os.close(b);
    }
}

async function main() {
    test_inet();
    test_gethostname();
    await test_getaddrinfo();
    await test_getnameinfo();
    await test_socketpair();
    await test_tcp();
    await test_udp();
    await test_msg_flags();
    await test_multicast();
    await test_close_cancel();
    await test_args();
}

main().then(() => {
    os.clearTimeout(watchdog);
    /* all sockets closed and no pending ops: the loop drains and exits 0 */
}, (e) => {
    console.log("FAIL: test_socket.js:", e && e.stack ? e.stack : e);
    std.exit(1);
});