from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class ChunkMetadata:
    upload_id: int
    chunk_index: int
    start: int
    end: int
    total_size: int
    sha256: str


def expected_chunk_bounds(size: int, chunk_size: int, index: int) -> tuple[int, int]:
    if size < 0 or chunk_size <= 0 or index < 0:
        raise ValueError("invalid chunk bounds")
    start = index * chunk_size
    end = min(size, start + chunk_size)
    if start >= size and not (size == 0 and index == 0):
        raise ValueError("chunk index outside file")
    return start, end


def validate_chunk_metadata(*, size: int, chunk_size: int, total_chunks: int,
                            chunk_index: int, body_size: int,
                            content_range: str, sha256: str) -> ChunkMetadata:
    if total_chunks <= 0 or chunk_index < 0 or chunk_index >= total_chunks:
        raise ValueError("invalid chunk size or total chunk count")
    start, end = expected_chunk_bounds(size, chunk_size, chunk_index)
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range.strip())
    if not match or tuple(map(int, match.groups())) != (start, end - 1, size):
        raise ValueError("invalid content range")
    if body_size != end - start:
        raise ValueError("invalid chunk size or total chunk count")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256.lower()):
        raise ValueError("invalid SHA-256")
    return ChunkMetadata(0, chunk_index, start, end, size, sha256.lower())


def encode_missing_ranges(indices: Iterable[int]) -> str:
    values = sorted(set(int(index) for index in indices))
    if any(value < 0 for value in values):
        raise ValueError("invalid missing range")
    ranges: list[str] = []
    start = previous = None
    for value in values + [None]:
        if value is not None and start is None:
            start = previous = value
        elif value is not None and value == previous + 1:
            previous = value
        elif start is not None:
            ranges.append(str(start) if start == previous else f"{start}-{previous}")
            start = previous = None
            if value is not None:
                start = previous = value
    return ",".join(ranges)


def decode_missing_ranges(value: str) -> list[int]:
    result: list[int] = []
    for item in filter(None, value.split(",")):
        bounds = item.split("-")
        try:
            if len(bounds) == 1:
                result.append(int(bounds[0]))
            elif len(bounds) == 2:
                start, end = map(int, bounds)
                if start < 0 or end < start:
                    raise ValueError
                result.extend(range(start, end + 1))
            else:
                raise ValueError
        except ValueError as exc:
            raise ValueError("invalid missing range") from exc
    return result


def chunk_path(staging_dir: Path, index: int) -> Path:
    if index < 0:
        raise ValueError("invalid chunk index")
    return staging_dir / f"{index}.part"


def sha256_bytes(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()
