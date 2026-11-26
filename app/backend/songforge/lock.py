"""Single-instance guard.

Only one SongForge backend may own the runtime directory at a time; two workers
sharing one SQLite queue would double-run jobs.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from types import TracebackType

__all__ = ["InstanceLock", "InstanceLockError"]

# Windows constants for OpenProcess / GetExitCodeProcess.
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_ERROR_ACCESS_DENIED = 5
_STILL_ACTIVE = 259


class InstanceLockError(RuntimeError):
    """Raised when another SongForge backend already holds the lock."""


def _pid_alive_windows(pid: int) -> bool:
    """Ask the kernel directly whether a pid is still running.

    os.kill(pid, 0) is NOT a liveness probe on Windows: signal 0 is
    CTRL_C_EVENT, so the call takes the console-event branch and returns
    success for a dead pid - leaving every crashed run's lock file to be
    deleted by hand. Worse, when the pid happens to be recycled it delivers a
    real Ctrl+C to that process group.
    """
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)

    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        # Access denied means the process exists but belongs to someone else;
        # anything else (typically ERROR_INVALID_PARAMETER) means it is gone.
        return ctypes.get_last_error() == _ERROR_ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True  # cannot tell; assume alive rather than steal the lock
        return code.value == _STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            return _pid_alive_windows(pid)
        except Exception:
            return True  # never steal a lock on the strength of a failed probe
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by another user
    except OSError:
        return False
    return True


class InstanceLock:
    """Exclusive-create lock file containing the owning PID.

    A lock left behind by a dead process is reclaimed automatically so a crash
    does not require manual cleanup.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._open_exclusive()
            return
        except FileExistsError:
            pass

        holder = self._read_pid()
        # A live holder includes this process: a second lock on the same path is
        # exactly the double-worker case the lock exists to prevent.
        if holder is not None and _pid_alive(holder):
            who = "this process" if holder == os.getpid() else f"pid {holder}"
            raise InstanceLockError(
                f"another SongForge backend already holds the lock ({who}); "
                f"stop it or delete {self.path}"
            ) from None

        # No live holder, so the lock is stale from a crashed run. Reclaiming it
        # can still fail if the file is held open, which also means it is in use.
        try:
            self.path.unlink(missing_ok=True)
        except PermissionError as exc:
            raise InstanceLockError(
                f"the lock file {self.path} is open by another process; "
                "stop the running SongForge backend and try again"
            ) from exc
        self._open_exclusive()

    def _open_exclusive(self) -> None:
        fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
        os.write(fd, str(os.getpid()).encode("ascii"))
        self._fd = fd

    def _read_pid(self) -> int | None:
        try:
            return int(self.path.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            return None

    def release(self) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
        if self._read_pid() == os.getpid():
            self.path.unlink(missing_ok=True)

    def __enter__(self) -> "InstanceLock":
        self.acquire()
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None,
                 tb: TracebackType | None) -> None:
        self.release()
