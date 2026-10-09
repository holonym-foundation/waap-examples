/**
 * The RPC connection pool is ours, and an endpoint failure replaces it.
 *
 * Live run 2b's four `fetch failed` ticks hit both endpoints while a fresh process
 * reached them. Rotation built new clients over Node's one process-wide pool, so it
 * could not have helped if the pool was the problem. These tests run a real local
 * JSON-RPC server and watch the TCP sockets it sees. undici keeps idle sockets open
 * (4 s by default); a recycle must close them at once, and nothing else does.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import net from 'node:net'

const open = new Set<net.Socket>()
let failNext = 0
const server = http.createServer((req, res) => {
	let body = ''
	req.on('data', (c) => (body += c))
	req.on('end', () => {
		if (failNext > 0) {
			failNext--
			req.socket.destroy() // the client sees undici's opaque `fetch failed`
			return
		}
		const { id } = JSON.parse(body)
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '750' }))
	})
})
server.on('connection', (sock) => {
	open.add(sock)
	sock.on('close', () => open.delete(sock))
})
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Two concurrent reads leave at least two idle sockets in the pool. */
async function warmPool(): Promise<Set<net.Socket>> {
	await Promise.all([waap.sui.getReferenceGasPrice(), waap.sui.getReferenceGasPrice()])
	await wait(50)
	assert.ok(open.size >= 2, `pool holds ${open.size} sockets`)
	return new Set(open)
}
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
process.env.SUI_RPC = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
process.env.SUI_RPC_FALLBACKS = ''
const waap = await import('./waap.ts')
test.after(() => server.close())

test('idle pooled sockets stay open on their own, and a recycle closes them', async () => {
	const before = await warmPool()
	await wait(200)
	assert.ok([...before].every((x) => open.has(x)), 'sockets closed without a recycle')
	waap.recycleRpcConnections('test')
	await wait(200)
	assert.ok([...before].every((x) => !open.has(x)), 'a pre-recycle socket is still open')
	assert.equal(await waap.sui.getReferenceGasPrice(), 750n)
})

test('withRpc replaces the pool on an endpoint failure; the retry succeeds and no old socket survives', async () => {
	const before = await warmPool()
	failNext = 1
	const out = await waap.withRpc('gas_price', () => waap.sui.getReferenceGasPrice(), { backoffMs: [0, 0, 0] })
	assert.equal(out, 750n)
	await wait(200)
	assert.ok([...before].every((x) => !open.has(x)), 'an idle socket from before the failure is still pooled')
})

test('errorCause surfaces the nested cause undici hides behind "fetch failed"', () => {
	const inner = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET', name: 'SocketError' })
	const err = new TypeError('fetch failed', { cause: inner })
	assert.equal(waap.errorCause(err), 'UND_ERR_SOCKET SocketError other side closed')
	assert.equal(waap.errorCause(new Error('plain')), null)
})
