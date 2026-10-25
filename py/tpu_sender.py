#!/usr/bin/env python3
"""Sends signed Solana transactions straight to a leader's TPU over QUIC, the path RPC nodes themselves use.

Driven by the Node experiment through JSON lines: one request per line on stdin, one reply per line on stdout.
  {"id": 1, "op": "connect", "addr": "1.2.3.4:8009"}
      -> {"id": 1, "ok": true, "handshakeMs": 41.2}
  {"id": 2, "op": "send", "addr": "1.2.3.4:8009", "txs": ["<base64>", ...], "gapMs": 0}
      -> {"id": 2, "ok": true, "sentNs": [...], "ackNs": [...], "blocked": [...], "state": "CONNECTED"}
         sentNs: wall-clock ns when each transaction was handed to the socket;
         ackNs:  when the leader's QUIC stack acknowledged all of it (null: not within the timeout), which is the
                 only proof of delivery we can have;
         blocked: the stream had to wait for stream credit from the peer (it left later than sentNs)
  {"id": 3, "op": "close", "addr": "1.2.3.4:8009"}
  {"id": 4, "op": "ping"}
Each transaction travels on its own unidirectional stream, as Agave's and Firedancer's QUIC servers expect.
The client certificate is a throwaway self-signed Ed25519 one, so the leader treats us as an unstaked peer.
Nothing here ever sees a private key of a wallet: the transactions arrive already signed.
"""
import asyncio
import base64
import datetime
import json
import ssl
import sys
import time

from aioquic.asyncio import connect
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.x509.oid import NameOID

ALPN = "solana-tpu"
ACK_TIMEOUT_S = 1.5


def throwaway_identity():
    key = ed25519.Ed25519PrivateKey.generate()
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Solana node")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .sign(key, None)
    )
    return cert, key


class Sender:
    def __init__(self):
        self.cert, self.key = throwaway_identity()
        self.conns = {}  # addr -> (context manager, protocol)

    def config(self):
        c = QuicConfiguration(is_client=True, alpn_protocols=[ALPN], idle_timeout=10.0)
        c.verify_mode = ssl.CERT_NONE
        c.certificate = self.cert
        c.private_key = self.key
        return c

    async def connect(self, addr):
        await self.close(addr)
        host, port = addr.rsplit(":", 1)
        t0 = time.perf_counter()
        cm = connect(host, int(port), configuration=self.config(), wait_connected=True)
        proto = await asyncio.wait_for(cm.__aenter__(), timeout=5.0)
        self.conns[addr] = (cm, proto)
        return {"handshakeMs": round((time.perf_counter() - t0) * 1000, 2)}

    async def send(self, addr, txs, gap_ms):
        reconnected = None
        if addr in self.conns:
            # the peer may have closed an idle (or unwanted) connection since the handshake: record why and redo it
            stale = self.conns[addr][1]._quic
            if stale._state.name != "CONNECTED":
                ev = getattr(stale, "_close_event", None)
                reconnected = f"{stale._state.name}: {getattr(ev, 'error_code', None)} {getattr(ev, 'reason_phrase', '')}".strip()
        if addr not in self.conns or reconnected:
            await self.connect(addr)
        _, proto = self.conns[addr]
        quic = proto._quic
        sent, streams = [], []
        for i, tx in enumerate(txs):
            if i and gap_ms > 0:
                await asyncio.sleep(gap_ms / 1000)
            sid = quic.get_next_available_stream_id(is_unidirectional=True)
            quic.send_stream_data(sid, base64.b64decode(tx), end_stream=True)
            streams.append(quic._streams.get(sid))
            proto.transmit()
            sent.append(str(time.time_ns()))
        blocked = [bool(st is not None and st.is_blocked) for st in streams]
        state = quic._state.name
        # a stream sent with FIN is finished once the peer has acknowledged all of its data
        acked = [None] * len(streams)
        deadline = time.perf_counter() + ACK_TIMEOUT_S
        while time.perf_counter() < deadline and any(a is None for a in acked):
            for i, st in enumerate(streams):
                if acked[i] is None and st is not None and st.sender.is_finished:
                    acked[i] = str(time.time_ns())
            await asyncio.sleep(0.002)
        return {"sentNs": sent, "ackNs": acked, "blocked": blocked, "state": state, "reconnected": reconnected}

    async def close(self, addr):
        entry = self.conns.pop(addr, None)
        if entry:
            cm, _ = entry
            try:
                await asyncio.wait_for(cm.__aexit__(None, None, None), timeout=2.0)
            except Exception:
                pass
        return {}


async def main():
    sender = Sender()
    loop = asyncio.get_running_loop()

    def reply(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    async def handle(req):
        rid = req.get("id")
        try:
            op = req["op"]
            if op == "connect":
                out = await sender.connect(req["addr"])
            elif op == "send":
                out = await sender.send(req["addr"], req["txs"], float(req.get("gapMs", 0)))
            elif op == "close":
                out = await sender.close(req["addr"])
            elif op == "ping":
                out = {}
            else:
                raise ValueError(f"unknown op {op}")
            reply({"id": rid, "ok": True, **out})
        except Exception as e:  # report and keep serving
            reply({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})

    while True:
        # a thread reads stdin: asyncio pipes are not portable to Windows
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        if line.strip():
            asyncio.ensure_future(handle(json.loads(line)))
    for addr in list(sender.conns):
        await sender.close(addr)


if __name__ == "__main__":
    asyncio.run(main())
