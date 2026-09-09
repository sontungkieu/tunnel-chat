from __future__ import annotations

import hashlib
import unittest

import transfer_protocol


class TransferProtocolTests(unittest.TestCase):
    def test_chunk_metadata_accepts_only_expected_range_and_hash(self) -> None:
        body = b"b" * (2 * 1024 * 1024)
        meta = transfer_protocol.validate_chunk_metadata(
            size=10 * 1024 * 1024, chunk_size=8 * 1024 * 1024,
            total_chunks=2, chunk_index=1, body_size=len(body),
            content_range="bytes 8388608-10485759/10485760",
            sha256=hashlib.sha256(body).hexdigest(),
        )
        self.assertEqual((meta.start, meta.end), (8 * 1024 * 1024, 10 * 1024 * 1024))

    def test_missing_ranges_are_compact_and_round_trip(self) -> None:
        encoded = transfer_protocol.encode_missing_ranges([0, 1, 2, 5, 7, 8])
        self.assertEqual(encoded, "0-2,5,7-8")
        self.assertEqual(transfer_protocol.decode_missing_ranges(encoded), [0, 1, 2, 5, 7, 8])

    def test_invalid_hash_range_and_chunk_index_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            transfer_protocol.validate_chunk_metadata(
                size=10, chunk_size=8, total_chunks=2, chunk_index=2,
                body_size=2, content_range="bytes 8-9/10", sha256="0" * 64,
            )


if __name__ == "__main__":
    unittest.main()
