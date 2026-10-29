// Node.js 22+; no npm packages. Launches and stops the C++ server itself.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';

const executable = path.resolve(process.argv[2] ?? 'build/multiplayer_server');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deadline(promise, ms = 5000) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), ms);
    })]).finally(() => clearTimeout(timer));
}

class Peer {
    constructor(url) {
        this.messages = [];
        this.waiters = [];
        this.ws = new WebSocket(url);
        this.ws.addEventListener('error', () => {});
        this.closed = new Promise(resolve => this.ws.addEventListener('close', resolve, { once: true }));
        this.ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            const waiter = this.waiters.shift();
            if (waiter) waiter(message);
            else this.messages.push(message);
        });
    }
    async open() {
        await deadline(new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        }));
        return this;
    }
    send(data) { this.ws.send(JSON.stringify(data)); }
    receive() {
        if (this.messages.length) return Promise.resolve(this.messages.shift());
        return deadline(new Promise(resolve => this.waiters.push(resolve)));
    }
    async expectNone() {
        await delay(120);
        assert.equal(this.messages.length, 0, 'Unexpected message, echo, or duplicate disconnect');
    }
    async close() {
        if (this.ws.readyState < WebSocket.CLOSING) this.ws.close();
        await deadline(this.closed);
    }
}

async function freePort() {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

async function rawPeer(port) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    const response = deadline(new Promise(resolve => {
        let header = '';
        const onData = chunk => {
            header += chunk.toString('latin1');
            if (header.includes('\r\n\r\n')) {
                socket.off('data', onData);
                resolve(header);
            }
        };
        socket.on('data', onData);
    }));
    socket.write(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    assert.match(await response, /^HTTP\/1\.1 101/);
    return socket;
}

function maskedText(text) {
    const data = Buffer.from(text);
    assert.ok(data.length < 126);
    const mask = Buffer.from([3, 7, 11, 19]);
    const masked = Buffer.from(data.map((value, i) => value ^ mask[i % 4]));
    return Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, masked]);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const url = `ws://127.0.0.1:${port}`;
const server = spawn(executable, [], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', data => { logs += data; });
server.stderr.on('data', data => { logs += data; });
const peers = [];
const connect = async (suffix = '') => {
    const peer = new Peer(url + suffix);
    peers.push(peer);
    return peer.open();
};
let raw;
let passed = 0;
const pass = name => { console.log(`PASS: ${name}`); ++passed; };
try {
    await deadline(new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('exit', code => reject(new Error(`Server exited: ${code}\n${logs}`)));
        const check = async () => {
            try {
                if ((await fetch(base + '/health')).ok) return resolve();
            } catch {}
            setTimeout(check, 30).unref();
        };
        check();
    }), 10000);
    assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok' });
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/missing')).status, 404);
    pass('PORT binding and HTTP health endpoints');

    const a = await connect();
    const b = await connect();
    const c = await connect('/same-protocol');
    await Promise.all([a, b, c].map(peer => peer.expectNone()));
    pass('Three connections, arbitrary WebSocket path, no unsolicited messages');

    a.send({ action: 'join', name: 'لاعب', player_id: 'forged' });
    const first = await b.receive();
    assert.deepEqual(await c.receive(), first);
    assert.equal(typeof first.player_id, 'string');
    assert.match(first.player_id, /^\d+$/);
    assert.notEqual(first.player_id, 'forged');
    assert.deepEqual(first, { action: 'join', name: 'لاعب', player_id: first.player_id });
    await a.expectNone();
    pass('Broadcast excludes sender and replaces forged player_id');

    b.send({ action: 'move', x: 12.5, y: -7 });
    const movement = await a.receive();
    assert.deepEqual(await c.receive(), movement);
    assert.notEqual(movement.player_id, first.player_id);
    assert.equal(movement.x, 12.5);
    assert.equal(movement.y, -7);
    pass('Unique string IDs and movement coordinates');

    const binaryPayload = { action: 'cards', cards: [1, 2, 3], nested: { text: 'مرحبا 🌍', ok: true, value: null } };
    b.ws.send(Buffer.from(JSON.stringify(binaryPayload)));
    const cards = await a.receive();
    assert.deepEqual(cards, { ...binaryPayload, player_id: movement.player_id });
    assert.deepEqual(await c.receive(), cards);
    pass('UTF-8 binary JSON, Arabic, nested data and stable connection ID');

    for (const invalid of ['{broken', '[]', 'null', '42', '"text"']) a.ws.send(invalid);
    a.send({ action: 'still_alive' });
    const valid = { action: 'still_alive', player_id: first.player_id };
    assert.deepEqual(await b.receive(), valid);
    assert.deepEqual(await c.receive(), valid);
    await Promise.all([a, b, c].map(peer => peer.expectNone()));
    pass('Malformed JSON and non-object values are ignored; connection stays usable');

    for (let i = 0; i < 40; ++i) {
        a.send({ action: 'burst', n: i });
        b.send({ action: 'burst', n: i });
    }
    for (let i = 0; i < 40; ++i) {
        assert.deepEqual(await a.receive(), { action: 'burst', n: i, player_id: movement.player_id });
        assert.deepEqual(await b.receive(), { action: 'burst', n: i, player_id: first.player_id });
    }
    const received = [];
    for (let i = 0; i < 80; ++i) received.push(await c.receive());
    for (const id of [first.player_id, movement.player_id]) {
        assert.deepEqual(received.filter(message => message.player_id === id).map(message => message.n),
            Array.from({ length: 40 }, (_, i) => i));
    }
    pass('Concurrent senders: all 160 deliveries arrive in per-sender order');

    await b.close();
    const disconnected = { action: 'disconnect', player_id: movement.player_id };
    assert.deepEqual(await a.receive(), disconnected);
    assert.deepEqual(await c.receive(), disconnected);
    await Promise.all([a, c].map(peer => peer.expectNone()));
    pass('Clean close broadcasts exactly one disconnect');

    const d = await connect();
    d.send({ action: 'rejoin' });
    const rejoined = await a.receive();
    assert.deepEqual(await c.receive(), rejoined);
    assert.notEqual(rejoined.player_id, movement.player_id);
    assert.notEqual(rejoined.player_id, first.player_id);
    await d.close();
    assert.deepEqual(await a.receive(), { action: 'disconnect', player_id: rejoined.player_id });
    assert.deepEqual(await c.receive(), { action: 'disconnect', player_id: rejoined.player_id });
    pass('Reconnection receives a new ID');

    raw = await rawPeer(port);
    raw.write(maskedText('{"action":"raw"}'));
    const rawMessage = await a.receive();
    assert.deepEqual(await c.receive(), rawMessage);
    raw.destroy();
    const abrupt = { action: 'disconnect', player_id: rawMessage.player_id };
    assert.deepEqual(await a.receive(), abrupt);
    assert.deepEqual(await c.receive(), abrupt);
    await Promise.all([a, c].map(peer => peer.expectNone()));
    pass('Abrupt TCP loss broadcasts exactly one disconnect');

    // Inspect the close frame on the wire. Browser-style clients can report
    // 1006 if TCP teardown races with a large send still in progress.
    raw = await rawPeer(port);
    raw.write(maskedText('{"action":"limit_test"}'));
    const limited = await a.receive();
    assert.deepEqual(await c.receive(), limited);
    const closeFrame = deadline(new Promise(resolve => {
        let received = Buffer.alloc(0);
        const onData = data => {
            received = Buffer.concat([received, data]);
            if (received.length >= 4) {
                raw.off('data', onData);
                resolve(received);
            }
        };
        raw.on('data', onData);
    }));
    const oversizedHeader = Buffer.alloc(14);
    oversizedHeader[0] = 0x81; // Final text frame.
    oversizedHeader[1] = 0xff; // Masked, 64-bit payload length.
    oversizedHeader.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2);
    // Header alone must trigger rejection, before allocating/reading the body.
    raw.write(oversizedHeader);
    const frame = await closeFrame;
    assert.equal(frame[0], 0x88, 'Expected a WebSocket close frame');
    assert.equal(frame.readUInt16BE(2), 1009);
    raw.end();
    assert.deepEqual(await a.receive(), { action: 'disconnect', player_id: limited.player_id });
    assert.deepEqual(await c.receive(), { action: 'disconnect', player_id: limited.player_id });
    assert.equal((await fetch(base + '/health')).status, 200);
    pass('Oversized message closes only its sender; server stays healthy');

    for (const invalidPort of ['', '0', '65536', '-1', '8080oops', '999999999999999999999999']) {
        const result = spawnSync(executable, [], { env: { ...process.env, PORT: invalidPort }, timeout: 5000 });
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, `Accepted invalid PORT: ${invalidPort}`);
        assert.match(result.stderr.toString(), /Server error:/);
    }
    pass('Invalid PORT values fail fast');
    console.log(`\nAll ${passed} integration checks passed.`);
} catch (error) {
    console.error(logs);
    throw error;
} finally {
    raw?.destroy();
    await Promise.allSettled(peers.map(peer => peer.close()));
    const exited = once(server, 'exit');
    server.kill();
    await deadline(exited).catch(() => server.kill('SIGKILL'));
}
