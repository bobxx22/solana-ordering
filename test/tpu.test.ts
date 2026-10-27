// The direct path end to end over loopback: TpuSender drives py/tpu_sender.py, which connects to a local QUIC server
// with the TPU's ALPN (py/loopback_server.py), sends each transaction on its own stream and reports the peer's
// acknowledgements. Skipped where Python has no aioquic (the CI test job and the Docker image have it).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { pythonPath, TpuSender } from '../src/tpu.ts'

const hasAioquic = spawnSync(pythonPath(), ['-c', 'import aioquic'], { stdio: 'ignore' }).status === 0

test('QUIC send and acknowledgement over loopback', { skip: !hasAioquic && 'Python with aioquic not found' }, async () => {
  const server = spawn(pythonPath(), ['py/loopback_server.py'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines: any[] = []
  const waiters: (() => void)[] = []
  createInterface({ input: server.stdout }).on('line', (l) => {
    lines.push(JSON.parse(l))
    waiters.splice(0).forEach((w) => w())
  })
  const until = async (ok: () => boolean) => {
    const deadline = Date.now() + 15_000
    while (!ok()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the loopback server')
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 200).unref()
      })
    }
  }
  const sender = new TpuSender()
  try {
    await until(() => lines.length > 0)
    const addr = `127.0.0.1:${lines[0].port}`
    assert.ok(await sender.ready())
    const c = await sender.connect(addr)
    assert.ok(c.ok, c.error)
    const txs = [Buffer.alloc(300, 1), Buffer.alloc(1232, 2), Buffer.alloc(50, 3)].map((b) => b.toString('base64'))
    const r = await sender.send(addr, txs, 0)
    assert.ok(r.ok, r.error)
    assert.equal(r.sentNs?.length, 3)
    assert.ok(r.ackNs?.every((a) => a !== null), 'every stream acknowledged')
    assert.equal(r.state, 'CONNECTED')
    await until(() => lines.length >= 4)
    const streams = lines.slice(1).sort((a, b) => a.stream - b.stream)
    // one unidirectional client stream per transaction, in send order, carrying exactly its bytes
    assert.deepEqual(
      streams.map((s) => s.data),
      txs,
    )
    assert.ok(streams.every((s) => s.stream % 4 === 2))
  } finally {
    sender.stop()
    server.stdin.end()
  }
})
