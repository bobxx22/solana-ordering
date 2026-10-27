#!/usr/bin/env python3
"""A local stand-in for a leader's TPU, for testing tpu_sender.py without mainnet (test/tpu.test.ts).

Listens on 127.0.0.1 with ALPN "solana-tpu", prints {"port": N} once ready, then one line per finished stream:
{"stream": id, "data": "<base64>"}. Exits when stdin closes.
"""
import asyncio
import base64
import datetime
import json
import sys

from aioquic.asyncio import serve
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import StreamDataReceived
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.x509.oid import NameOID


def identity():
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "loopback")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    return cert, key


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Tpu(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.buffers = {}

    def quic_event_received(self, event):
        if isinstance(event, StreamDataReceived):
            self.buffers[event.stream_id] = self.buffers.get(event.stream_id, b"") + event.data
            if event.end_stream:
                emit({"stream": event.stream_id, "data": base64.b64encode(self.buffers.pop(event.stream_id)).decode()})


async def main():
    config = QuicConfiguration(is_client=False, alpn_protocols=["solana-tpu"])
    config.certificate, config.private_key = identity()
    server = await serve("127.0.0.1", 0, configuration=config, create_protocol=Tpu)
    emit({"port": server._transport.get_extra_info("sockname")[1]})
    # a thread reads stdin: asyncio pipes are not portable to Windows
    await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)
    server.close()


if __name__ == "__main__":
    asyncio.run(main())
