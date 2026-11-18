"""Closed prototype: initialize only parent-owned generated FD3, before first pin."""
import ctypes
import _ctypes
import hashlib
import json
import os
import stat
import sys


def snapshot(s):
    return {k: str(getattr(s, k)) if k.endswith('_ns') else getattr(s, k) for k in ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns', 'st_flags')}


def digest(fd, size):
    h = hashlib.sha256()
    at = 0
    while at < size:
        chunk = os.pread(fd, min(65536, size - at), at)
        if not chunk:
            raise RuntimeError('generated FD truncated')
        h.update(chunk)
        at += len(chunk)
    if os.pread(fd, 1, size):
        raise RuntimeError('generated FD grew')
    return h.hexdigest()


UF_TRACKED = 64
SYSTEM_IMAGE = "/usr/lib/libSystem.B.dylib"
ROLE_BOUNDS = {"original.wav": 67108864, "original.flac": 67108864, "clock.json": 4194304, "pcm.f32": 19200000, "initial-config.json": 8388608, "initial-registry.json": 4194304, "commit.json": 65536, "evidence-staged.json": 2097152}


def fixed_syscall():
    library = ctypes.CDLL(SYSTEM_IMAGE, use_errno=True)
    call = library.fchflags
    call.argtypes = (ctypes.c_int, ctypes.c_uint32)
    call.restype = ctypes.c_int
    return call


def main():
    raw = sys.stdin.buffer.read(2049)
    if len(raw) > 2048:
        raise RuntimeError('bounded request exceeded')
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {'dev', 'ino', 'bytes', 'sha256', 'role'}:
        raise RuntimeError('closed request required')
    if type(request['role']) is not str or request['role'] not in ROLE_BOUNDS or any(type(request[k]) is not int or request[k] < 0 for k in ('dev', 'ino', 'bytes')) or request['bytes'] > ROLE_BOUNDS[request['role']]:
        raise RuntimeError('generated FD extent bound')
    if not isinstance(request['sha256'], str) or len(request['sha256']) != 64 or any(c not in '0123456789abcdef' for c in request['sha256']):
        raise RuntimeError('SHA declaration required')
    if sys.platform != 'darwin' or getattr(stat, 'UF_TRACKED', UF_TRACKED) != UF_TRACKED:
        raise RuntimeError('trusted Darwin UF_TRACKED ABI unavailable')
    before = os.fstat(3)
    if not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o600 or before.st_uid != os.getuid() or before.st_nlink != 1:
        raise RuntimeError('generated FD ownership/type/mode/link refused')
    if (before.st_dev, before.st_ino, before.st_size) != (request['dev'], request['ino'], request['bytes']) or digest(3, before.st_size) != request['sha256']:
        raise RuntimeError('generated FD identity/bytes refused')
    if snapshot(os.fstat(3)) != snapshot(before):
        raise RuntimeError('generated FD changed before initialization')
    if type(before.st_flags) is not int or before.st_flags < 0 or before.st_flags > 0xffffffff:
        raise RuntimeError('generated FD flags uint32 ABI refused')
    if not before.st_flags & UF_TRACKED:
        call = fixed_syscall()
        ctypes.set_errno(0)
        if call(3, before.st_flags | UF_TRACKED) != 0:
            raise OSError(ctypes.get_errno(), 'owned generated fchflags refused')
    os.fsync(3)
    after = os.fstat(3)
    unchanged = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_mtime_ns')
    if any(getattr(after, key) != getattr(before, key) for key in unchanged) or after.st_flags != before.st_flags | UF_TRACKED or digest(3, after.st_size) != request['sha256'] or snapshot(os.fstat(3)) != snapshot(after):
        raise RuntimeError('controlled generated metadata postcondition failed')
    return {'ok': True, 'before': snapshot(before), 'after': snapshot(after), 'sha256': request['sha256'], 'semanticClaim': 'owned-generated-metadata-only', 'runtime': {'executable': sys.executable, 'ctypes': ctypes.__file__, '_ctypes': getattr(_ctypes, '__file__', 'builtin'), 'systemImage': SYSTEM_IMAGE, 'symbol': 'fchflags', 'ABI': 'int(int,uint32_t)', 'flag': UF_TRACKED}}


def entrypoint():
    try:
        result = main()
    except BaseException as error:
        try:
            detail = str(error)[:512]
        except BaseException:
            detail = '[unprintable metadata failure]'
        result = {'ok': False, 'error': detail}
    print(json.dumps(result, separators=(',', ':')))
    if not result['ok']:
        sys.stderr.write(result['error'] + '\n')
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(entrypoint())
