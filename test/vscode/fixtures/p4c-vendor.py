#!/usr/bin/env python3
"""Replay the vendor compiler's diagnostic for a typo in a closed include."""
from pathlib import Path
import sys

unit = Path(sys.argv[-1])
if unit.name != "vendor-main.p4":
    sys.exit("The configured entrypoint was not passed to the compiler")
source = unit.parent / "src" / "switch.p4"
line = source.read_text(encoding="utf-8").splitlines()[56]
print("FRONTEND layer processing started...", flush=True)
if (unit.parent.parent / "vendor-backend-failure").exists():
    print("BACKEND layer processing started...", flush=True)
    sys.exit("Cannot load backend resources")
if line.endswith(".aply"):
    print(f"{source}(57):syntax error, unexpected IDENTIFIER, expecting APPLY", file=sys.stderr)
    print(line, file=sys.stderr)
    print(" " * line.index("aply") + "^^^^", file=sys.stderr)
    print("[--Werror=overlimit] error: 1 errors encountered, aborting compilation", file=sys.stderr)
    sys.exit("Compilation failed!")
(unit.parent.parent / "vendor-compile-ok").touch()
