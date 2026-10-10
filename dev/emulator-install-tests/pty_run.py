#!/usr/bin/env python3
"""Führt einen Befehl in einem Pseudo-Terminal aus (stdin und stdout sind dann ein TTY) und beantwortet Rückfragen.

  pty_run.py [--expect TEXT --send TEXT]... [--timeout SEKUNDEN] -- Befehl [Argumente…]

  --expect/--send  paarweise: sobald TEXT in der Ausgabe auftaucht, wird TEXT2 gesendet (Escapes wie \\n und \\x03 gelten)
Ausgabe: alles, was das Programm geschrieben hat. Exit-Code: der des Programms (128+Signal, wenn es abgebrochen wurde).
Nur für die Tests gedacht (nutzt nur die Python-Standardbibliothek).
"""
import codecs
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time


def main() -> int:
    args = sys.argv[1:]
    pairs, timeout = [], 60.0
    while args and args[0] != "--":
        if args[0] == "--expect" and len(args) >= 4 and args[2] == "--send":
            pairs.append([args[1], codecs.decode(args[3], "unicode_escape")])
            args = args[4:]
        elif args[0] == "--timeout":
            timeout = float(args[1])
            args = args[2:]
        else:
            print("pty_run.py: unbekanntes Argument " + args[0], file=sys.stderr)
            return 64
    cmd = args[1:]
    if not cmd:
        print("pty_run.py: Befehl fehlt", file=sys.stderr)
        return 64

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    out = b""
    seen = 0   # bis hierhin wurde die Ausgabe schon nach Erwartungen durchsucht
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            out += data
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            if pairs:
                text = out[seen:].decode("utf-8", "replace")
                if pairs[0][0] in text:
                    time.sleep(0.2)
                    os.write(fd, pairs[0][1].encode())
                    seen = len(out)
                    pairs.pop(0)
    else:
        os.kill(pid, 9)
        print("\npty_run.py: Zeitüberschreitung", file=sys.stderr)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
