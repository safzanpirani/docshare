#!/usr/bin/env python3
"""docshare upload — presign → PUT → finalize.

Usage:
  upload.py <file>

Env:
  DOCSHARE_ENDPOINT   override default https://docs.safzan.dev

Prints the download URL on stdout on success; an error on stderr and exits
non-zero on failure. Uses the system `curl` for HTTP (no third-party Python
deps, no urllib SSL-cert headaches on macOS, streams large files efficiently).
"""

from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import sys

DEFAULT_ENDPOINT = "https://docs.safzan.dev"


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def curl(*args: str, expect_body: bool = True) -> bytes:
    """Run curl and return stdout. -fsS = fail on HTTP error, silent, show errors."""
    proc = subprocess.run(
        ["curl", "-fsS", *args],
        capture_output=True,
        text=False,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace").strip()[:400]
        die(f"curl failed ({proc.returncode}): {err}", 2)
    return proc.stdout if expect_body else b""


def main(argv: list[str]) -> None:
    if len(argv) != 2 or argv[1] in ("-h", "--help"):
        die(f"usage: {os.path.basename(argv[0])} <file>", 64)
    path = argv[1]
    if not os.path.isfile(path):
        die(f"no such file: {path}", 66)
    if shutil.which("curl") is None:
        die("curl is required but not found on PATH", 69)

    endpoint = os.environ.get("DOCSHARE_ENDPOINT", DEFAULT_ENDPOINT).rstrip("/")
    name = os.path.basename(path)
    size = os.path.getsize(path)
    if size == 0:
        die("file is empty", 65)
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"

    # 1) presign
    presign_body = json.dumps({"filename": name, "size": size, "contentType": mime})
    presign_raw = curl(
        "-X", "POST",
        "-H", "content-type: application/json",
        "--data", presign_body,
        f"{endpoint}/api/doc/presign",
    )
    try:
        presign = json.loads(presign_raw)
    except json.JSONDecodeError:
        die(f"presign returned non-JSON: {presign_raw[:200]!r}", 2)
    for key in ("id", "putUrl", "downloadUrl"):
        if key not in presign:
            die(f"presign missing field {key!r}: {presign}", 2)

    # 2) PUT bytes directly to R2 — curl streams the file, no Python RAM use
    curl(
        "-X", "PUT",
        "-H", f"content-type: {mime}",
        "--data-binary", f"@{path}",
        presign["putUrl"],
        expect_body=False,
    )

    # 3) finalize — confirms the upload landed; enforces max size
    curl(
        "-X", "POST",
        "-H", "content-type: application/json",
        "--data", json.dumps({"id": presign["id"]}),
        f"{endpoint}/api/doc/finalize",
        expect_body=False,
    )

    print(presign["downloadUrl"])


if __name__ == "__main__":
    main(sys.argv)
