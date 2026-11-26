/* Socket API tests: inet conversion, DNS (sync/async), socketpair, TCP/UDP
   loopback, MSG_* flags, multicast smoke, close-cancellation, argument
   validation and the error/edge cases of the async operations.
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
function errno(err) {
    return std.Error[err];
}
/* capture the rejection of a promise instead of throwing */
async function rejection(p) {
    try {
        await p;
        return null;
    } catch (e) {
        return e;
    }
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
    assert(os.inet_pton(os.AF_INET, "not-an-ip"), -errno("EINVAL"));
    assert(os.inet_pton(os.AF_INET, "1.2.3.4.5"), -errno("EINVAL"));
    assertThrows(TypeError, () => os.inet_pton(9999, "1.2.3.4"));
    assertThrows(RangeError, () => os.inet_ntop(os.AF_INET, new ArrayBuffer(3)));
}

function test_errno() {
    /* the socket errors are exported under their BSD names with the value the
       socket API reports; the generic ones keep their errno value */
    for (const name of ["EAGAIN", "EWOULDBLOCK", "EINPROGRESS", "ECONNREFUSED",
                        "ECONNRESET", "ETIMEDOUT", "EADDRINUSE", "ENOTCONN",
                        "ENOMEM", "EBADF", "ECANCELED"]) {
        assert(typeof std.Error[name], "number", name + " is not exported");
    }
    for (const name of ["EAI_NONAME", "EAI_SERVICE", "EAI_AGAIN"]) {
        assert(typeof os[name], "number", name + " is not exported");
        assert(os[name] > 0, true, name + " must be exported as a positive value");
    }
    if (os.platform === "win32") {
        /* on Windows the BSD names carry the Winsock values */
        assert(std.Error.ECONNREFUSED, std.Error.WSAECONNREFUSED);
        assert(std.Error.EWOULDBLOCK, std.Error.WSAEWOULDBLOCK);
    }
    assert(typeof os.AF_UNIX, "number");
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
    /* a null node with AI_PASSIVE yields the wildcard address (for bind()) */
    const passive = os.getaddrinfo(null, {
        service: "80", family: os.AF_INET, socktype: os.SOCK_STREAM, flags: os.AI_PASSIVE,
    });
    assert(Array.isArray(passive), true, "getaddrinfo(null) failed: " + passive);
    assert(passive[0].addr, "0.0.0.0");

    /* unknown service: EAI_SERVICE on POSIX, some stacks report EAI_NONAME */
    const bad = { service: "definitely-not-a-service-12345", socktype: os.SOCK_STREAM };
    const isServiceErr = (r) => r === -os.EAI_SERVICE || r === -os.EAI_NONAME;
    const r = os.getaddrinfo("127.0.0.1", bad);
    assert(isServiceErr(r), true, "expected -EAI_SERVICE/-EAI_NONAME, got " + r);
    const rej = await rejection(os.getaddrinfoAsync("127.0.0.1", bad));
    assert(isServiceErr(rej), true, "async expected -EAI_SERVICE/-EAI_NONAME, got " + rej);
    /* a non-object hint is ignored: no service, hence port 0 */
    const noHints = os.getaddrinfo("127.0.0.1", undefined);
    assert(Array.isArray(noHints), true, "getaddrinfo without hints failed: " + noHints);
    assert(noHints[0].addr, "127.0.0.1");
    assert(noHints[0].port, 0);
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
    /* the family is taken from the address text when omitted */
    const v6 = os.getnameinfo({ addr: "::1", port: 80 }, flags);
    assert(v6.host.toLowerCase(), "::1");
    assert((await os.getnameinfoAsync({ addr: "127.0.0.1", port: 80 }, flags)).host, "127.0.0.1");
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
        assert(sp.port, os.getsockname(client).port);
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

async function test_tcp_errors() {
    /* connecting to a closed loopback port rejects with ECONNREFUSED */
    const probe = os.socket(os.AF_INET, os.SOCK_STREAM);
    assert(probe >= 0, true, "socket failed: " + probe);
    assert(os.bind(probe, { family: os.AF_INET, addr: "127.0.0.1", port: 0 }), 0);
    assert(os.listen(probe, 1), 0);
    const port = os.getsockname(probe).port;
    os.close(probe);

    const c = os.socket(os.AF_INET, os.SOCK_STREAM);
    try {
        assert(await rejection(os.connect(c, { family: os.AF_INET, addr: "127.0.0.1", port })),
               -errno("ECONNREFUSED"));
    } finally {
        os.close(c);
    }

    /* writing after the peer closed must report an error (or succeed while
       the connection winds down) but never terminate the process */
    const l = os.socket(os.AF_INET, os.SOCK_STREAM);
    let s = -1, cl = -1;
    try {
        assert(os.bind(l, { family: os.AF_INET, addr: "127.0.0.1", port: 0 }), 0);
        assert(os.listen(l, 1), 0);
        const lp = os.getsockname(l).port;
        cl = os.socket(os.AF_INET, os.SOCK_STREAM);
        const acceptP = os.accept(l);
        assert(await os.connect(cl, { family: os.AF_INET, addr: "127.0.0.1", port: lp }), 0);
        [s] = await acceptP;
        os.close(s);
        s = -1;
        const chunk = new ArrayBuffer(1024);
        for (let i = 0; i < 50; i++) {
            /* succeed or fail depending on the stack's timing; surviving is
               what matters (a raised SIGPIPE would end the process here) */
            await rejection(os.send(cl, chunk, 1024));
            await os.sleepAsync(5);
        }
    } finally {
        if (s >= 0) os.close(s);
        if (cl >= 0) os.close(cl);
        os.close(l);
    }
}

async function test_ipv6() {
    /* the address family is taken from the socket when omitted */
    const l = os.socket(os.AF_INET6, os.SOCK_STREAM);
    if (l < 0) {
        console.log("SKIP: ipv6 (no AF_INET6 socket)");
        return;
    }
    let c = -1, s = -1;
    try {
        if (os.bind(l, { addr: "::1", port: 0 }) < 0 || os.listen(l, 1) < 0) {
            console.log("SKIP: ipv6 (::1 not available)");
            return;
        }
        const port = os.getsockname(l).port;
        const acceptP = os.accept(l);
        c = os.socket(os.AF_INET6, os.SOCK_STREAM);
        assert(c >= 0, true, "ipv6 client socket failed: " + c);
        assert(await os.connect(c, { addr: "::1", port }), 0);
        [s] = await acceptP;
        assert(s >= 0, true, "ipv6 accept failed: " + s);
        const peer = os.getpeername(c);
        assert(peer.family, os.AF_INET6);
        assert(peer.addr.toLowerCase(), "::1");
        assert(peer.port, port);
        assert(await os.send(c, strToBuf("6"), 1), 1);
        const b = new ArrayBuffer(1);
        assert(await os.recv(s, b, 1), 1);
    } finally {
        if (c >= 0) os.close(c);
        if (s >= 0) os.close(s);
        os.close(l);
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
        /* let the bytes land so the reads below do not have to wait */
        await os.sleepAsync(50);

        /* PEEK reads without consuming */
        const pb = new ArrayBuffer(10);
        assert(await os.recv(a, pb, 10, 0, os.MSG_PEEK), 10);
        assert(bufToStr(pb, 10), "0123456789");

        /* WAITALL still sees all 10 bytes (peek did not consume them), read
           don't need a loop until the requested count has arrived */
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
    assert(caught, -errno("ECANCELED"));
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
    assert(caught2, -errno("ECANCELED"));
}

async function test_bad_handle() {
    /* a handle that is negative or unknown to the runtime can never become
       ready: the promise fails right away instead of staying pending (which
       would keep the event loop alive) or being polled (which could wedge the
       whole event loop on Windows) */
    const buf = new ArrayBuffer(8);
    const addr = { addr: "127.0.0.1", port: 9 };
    for (const h of [-1, 0x40000000]) {
        for (const op of [
            () => os.accept(h),
            () => os.connect(h, addr),
            () => os.recv(h, buf),
            () => os.send(h, buf),
            () => os.recvfrom(h, buf),
            () => os.sendto(h, addr, buf),
        ]) {
            assert(await rejection(op()), -errno("EBADF"));
        }
    }
    /* a closed handle drops out of the runtime's registry */
    const pair = os.socketpair();
    assert(Array.isArray(pair), true, "socketpair failed: " + pair);
    os.close(pair[0]);
    assert(await rejection(os.recv(pair[0], buf)), -errno("EBADF"));
    assert(await rejection(os.connect(pair[0], addr)), -errno("EBADF"));
    os.close(pair[1]);
    assert(os.close(-1), -errno("EBADF"));
    assert(os.close(0x100000000), -errno("EBADF")); /* beyond the CRT fd range */
}

async function test_args() {
    const pair = os.socketpair();
    assert(Array.isArray(pair), true, "socketpair failed: " + pair);
    const [a, b] = pair;
    try {
        const buf = new ArrayBuffer(8);
        const addr = { addr: "127.0.0.1", port: 9 };

        /* buffers must be ArrayBuffer, not a TypedArray view */
        assertThrows(TypeError, () => os.recv(a, new Uint8Array(8), 8));

        /* offset and offset+length must lie inside the buffer */
        assertThrows(RangeError, () => os.send(a, buf, 9));
        assertThrows(RangeError, () => os.send(a, buf, 5, 4));
        assertThrows(RangeError, () => os.send(a, buf, undefined, 9));
        assertThrows(RangeError, () => os.recv(a, buf, 9));
        assertThrows(RangeError, () => os.recv(a, buf, 5, 4));
        assertThrows(RangeError, () => os.recv(a, buf, undefined, 9));
        assertThrows(RangeError, () => os.recvfrom(a, buf, 9));
        assertThrows(RangeError, () => os.sendto(a, addr, buf, 9));
        assertThrows(RangeError, () => os.sendto(a, addr, buf, undefined, 9));

        /* an empty recv is refused: 0 means end of stream */
        assertThrows(RangeError, () => os.recv(a, buf, 0));
        assertThrows(RangeError, () => os.recvfrom(a, buf, 0));
        assertThrows(RangeError, () => os.recv(a, new ArrayBuffer(0)));

        /* an empty send completes with 0 right away and sends nothing */
        assert(await os.send(b, buf, 0), 0);
        assert(await os.send(b, new ArrayBuffer(0)), 0);
        assert(await os.send(b, buf, undefined, 8), 0); /* offset at the end */
        assert(await os.sendto(b, addr, new ArrayBuffer(0)), 0);

        /* length defaults to the rest of the buffer from offset */
        const msg = strToBuf("abcdef");
        assert(await os.send(b, msg, msg.byteLength), 6);
        assert(await os.recv(a, buf, undefined, 6), 2);
        const u = new Uint8Array(buf);
        assert(u[6], "a".charCodeAt(0));
        assert(u[7], "b".charCodeAt(0));
        assert(await os.recv(a, buf, 4, 4), 4);
        assert(bufToStr(buf.slice(4), 4), "cdef");

        /* explicit undefined arguments mean "not given" */
        const other = os.socket(os.AF_INET, os.SOCK_STREAM, undefined);
        assert(other >= 0, true, "socket failed: " + other);
        assert(os.getsockopt(other, os.SO_TYPE, new ArrayBuffer(4), undefined), 4);
        os.close(other);
        const p2 = os.socketpair(undefined, undefined);
        assert(Array.isArray(p2), true, "socketpair(undefined) failed: " + p2);
        os.close(p2[0]);
        os.close(p2[1]);
    } finally {
        os.close(a);
        os.close(b);
    }
}

async function test_buffer_lifetime() {
    /* the buffer of a pending operation is re-validated when the socket is
       ready: a detached buffer or a shrunken range fails with -EINVAL */
    const pair = os.socketpair();
    assert(Array.isArray(pair), true, "socketpair failed: " + pair);
    const [a, b] = pair;
    try {
        const buf = new ArrayBuffer(16, { maxByteLength: 32 });
        if (typeof buf.resize === "function") {
            /* the range must still fit once the socket is ready */
            const p = os.recv(a, buf, 16);
            buf.resize(8);
            assert(await os.send(b, strToBuf("x"), 1), 1);
            assert(await rejection(p), -errno("EINVAL"));
            /* a range that still fits is not affected */
            buf.resize(16);
            const q = os.recv(a, buf, 8);
            buf.resize(12);
            assert(await os.send(b, strToBuf("y"), 1), 1);
            assert(await q, 1);
        }
        if (typeof buf.transfer === "function") {
            /* "y" is still queued, so the detached buffer is looked at right away */
            const detached = new ArrayBuffer(8);
            const p = os.recv(a, detached, 8);
            detached.transfer();
            assert(await rejection(p), -errno("EINVAL"));
        }
    } finally {
        os.close(a);
        os.close(b);
    }
}

async function main() {
    const tests = [
        ["inet", test_inet],
        ["errno", test_errno],
        ["gethostname", test_gethostname],
        ["getaddrinfo", test_getaddrinfo],
        ["getnameinfo", test_getnameinfo],
        ["socketpair", test_socketpair],
        ["tcp", test_tcp],
        ["tcp_errors", test_tcp_errors],
        ["ipv6", test_ipv6],
        ["udp", test_udp],
        ["msg_flags", test_msg_flags],
        ["multicast", test_multicast],
        ["close_cancel", test_close_cancel],
        ["bad_handle", test_bad_handle],
        ["args", test_args],
        ["buffer_lifetime", test_buffer_lifetime],
    ];
    for (const [name, fn] of tests) {
        console.log("RUN:", name);
        await fn();
    }
}

main().then(() => {
    os.clearTimeout(watchdog);
    /* all sockets closed and no pending ops: the loop drains and exits 0 */
}, (e) => {
    console.log("FAIL: test_socket.js:", e?.message);
    if (e && e.stack)
        console.log(e.stack);
    std.exit(1);
});
