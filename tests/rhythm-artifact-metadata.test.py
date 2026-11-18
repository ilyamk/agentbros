"""In-memory fake FD/loader tests of the exact closed metadata helper."""

from __future__ import annotations

import ctypes
import hashlib
import io
import json
import runpy
import stat
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

type Params = dict[str, Any]


helper = runpy.run_path(str(Path(__file__).resolve().parent.parent / "src/lib/audio/rhythm-artifact-metadata.py"))
main = helper["main"]
namespace = main.__globals__


class MetadataTests(unittest.TestCase):
    def run_consumer(  # noqa: PLR0913 -- Inputs are independent measured layers of the same operation. Retain the established positional worker/helper interface.
        self,
        *,
        flags: int = 0,
        request: Params | None = None,
        change: dict[str, int] | None = None,
        errno: int = 0,
        already: bool = False,
        state_override: dict[str, int] | None = None,
        content: bytes = b"owned-generated",
        role: str = "clock.json",
    ) -> tuple[Params, list[tuple[object, ...]]]:
        state = {"st_dev": 1, "st_ino": 2, "st_size": len(content), "st_mode": stat.S_IFREG | 0o600, "st_uid": 501, "st_gid": 20, "st_nlink": 1, "st_mtime_ns": 7, "st_ctime_ns": 7, "st_flags": flags}
        state.update(state_override or {})
        request = request or {"dev": 1, "ino": 2, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "role": role}
        calls = []

        class Call:
            argtypes: object = None
            restype: object = None

            def __call__(self, fd: int, bits: int) -> int:
                calls.append((fd, bits, self.argtypes, self.restype))
                if errno:
                    ctypes.set_errno(errno)
                    return -1
                state["st_flags"] = bits
                state["st_ctime_ns"] = 8
                if change:
                    state.update(change)
                return 0

        call = Call()

        def loader(library: str, **kwargs: bool) -> SimpleNamespace:
            self.assertEqual(library, "/usr/lib/libSystem.B.dylib")
            self.assertEqual(kwargs, {"use_errno": True})
            return SimpleNamespace(fchflags=call)

        def fstat(fd: int) -> SimpleNamespace:
            self.assertEqual(fd, 3)
            return SimpleNamespace(**state)

        def pread(fd: int, count: int, offset: int) -> bytes:
            self.assertEqual(fd, 3)
            return content[offset : offset + count]

        with (
            patch.object(namespace["sys"], "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))),
            patch.object(namespace["sys"], "platform", "darwin"),
            patch.object(namespace["os"], "fstat", fstat),
            patch.object(namespace["os"], "pread", pread),
            patch.object(namespace["os"], "getuid", lambda: 501),
            patch.object(namespace["os"], "fsync", lambda fd: self.assertEqual(fd, 3)),
            patch.object(namespace["ctypes"], "CDLL", loader),
        ):
            if already:
                with patch.object(namespace["ctypes"], "CDLL", side_effect=AssertionError("already tracked must not load syscall")):
                    result = main()
            else:
                result = main()
        return result, calls

    def test_fixed_fd_abi_exact_flag(self) -> None:
        result, calls = self.run_consumer()
        self.assertTrue(result["ok"])
        self.assertEqual(calls, [(3, 64, (ctypes.c_int, ctypes.c_uint32), ctypes.c_int)])

    def test_preserves_other_flags(self) -> None:
        result, calls = self.run_consumer(flags=1)
        self.assertEqual(calls[0][1], 65)
        self.assertEqual(result["after"]["st_flags"], 65)

    def test_already_tracked_has_no_call(self) -> None:
        _, calls = self.run_consumer(flags=65, already=True)
        self.assertEqual(calls, [])

    def test_optional_export_wrong_is_refused(self) -> None:
        with patch.object(namespace["stat"], "UF_TRACKED", 128, create=True), self.assertRaisesRegex(RuntimeError, "ABI unavailable"):
            self.run_consumer()

    def test_errno_preserved(self) -> None:
        with self.assertRaises(OSError) as caught:
            self.run_consumer(errno=1)
        self.assertEqual(caught.exception.errno, 1)

    def test_wrong_owner_type_mode_link_refuse(self) -> None:
        for invalid in [{"st_uid": 502}, {"st_mode": stat.S_IFIFO | 0o600}, {"st_mode": stat.S_IFREG | 0o644}, {"st_nlink": 2}]:
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, "ownership/type/mode/link"):
                self.run_consumer(state_override=invalid)

    def test_wrong_expected_birth_hash_or_extent_refuse(self) -> None:
        request = {"dev": 1, "ino": 2, "bytes": 15, "sha256": hashlib.sha256(b"owned-generated").hexdigest(), "role": "clock.json"}
        for key, value in [("dev", 8), ("ino", 9), ("bytes", 1), ("sha256", "0" * 64)]:
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, "identity/bytes"):
                self.run_consumer(request={**request, key: value})

    def test_postcondition_change_refuse(self) -> None:
        for invalid in [{"st_ino": 3}, {"st_mtime_ns": 99}, {"st_flags": 0}]:
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, "postcondition"):
                self.run_consumer(change=invalid)

    def test_unknown_selector_and_flag_overflow_refuse(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "closed request"):
            self.run_consumer(request={"path": "/foreign"})
        with self.assertRaisesRegex(RuntimeError, "uint32 ABI"):
            self.run_consumer(flags=1 << 32)

    def test_role_bounds_closed_refuse_before_fd_read(self) -> None:
        for role, maximum in namespace["ROLE_BOUNDS"].items():
            with self.subTest(role=role), self.assertRaisesRegex(RuntimeError, "extent bound"):
                self.run_consumer(request={"dev": 1, "ino": 2, "bytes": maximum + 1, "sha256": "0" * 64, "role": role})
        with self.assertRaisesRegex(RuntimeError, "extent bound"):
            self.run_consumer(request={"dev": 1, "ino": 2, "bytes": 21, "sha256": "0" * 64, "role": "unknown"})

    def test_ns_receipt_preserves_exact_integer_identity(self) -> None:
        result, _ = self.run_consumer(state_override={"st_mtime_ns": 1791792101929385527, "st_ctime_ns": 1791792101929385527})
        self.assertEqual(result["before"]["st_mtime_ns"], "1791792101929385527")
        self.assertEqual(result["after"]["st_mtime_ns"], "1791792101929385527")

    def test_exact_64_mib_original_role_is_supported_with_same_fd_two_hash_reads(self) -> None:
        content = bytes(64 * 1024 * 1024)
        result, calls = self.run_consumer(content=content, role="original.wav")
        self.assertEqual(result["after"]["st_size"], len(content))
        self.assertEqual(result["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(calls[0][1], 64)

    def test_errno_entrypoint_keeps_one_json_and_bounded_stderr(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict(namespace, main=lambda: (_ for _ in ()).throw(OSError(1, "owned generated fchflags refused"))),
            patch.object(namespace["sys"], "stdout", stdout),
            patch.object(namespace["sys"], "stderr", stderr),
        ):
            status = namespace["entrypoint"]()
        self.assertEqual(status, 1)
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertFalse(json.loads(stdout.getvalue())["ok"])
        self.assertIn("[Errno 1]", stderr.getvalue())
        self.assertLessEqual(len(stderr.getvalue()), 513)


if __name__ == "__main__":
    unittest.main()
