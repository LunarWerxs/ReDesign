"""Bytes of product source shipped: committed size at HEAD of the server/CLI and web app files under src/ (no tests, no config). Prints shipped_bytes=<n>."""
import subprocess

SHIPPED = (".ts", ".mts", ".mjs", ".vue", ".css", ".html", ".svg", ".ico", ".woff2")
SKIP_NAMES = (".d.ts", ".d.mts")

listing = subprocess.run(["git", "ls-tree", "-r", "-l", "-z", "HEAD"], capture_output=True, check=True).stdout
total = 0
for entry in listing.split(b"\0"):
    if not entry:
        continue
    meta, path = entry.decode("utf-8", "replace").split("\t", 1)
    size = meta.split()[3]
    if size == "-":
        continue
    low = path.lower()
    parts = low.split("/")
    if parts[0] != "src" or any(p.startswith(".") for p in parts):
        continue
    if not low.endswith(SHIPPED) or low.endswith(SKIP_NAMES):
        continue
    if "test" in parts or "tests" in parts or "patches" in parts or ".test." in low or ".spec." in low:
        continue
    if parts[-1].startswith("tsconfig") or parts[-1].startswith("vite.config") or parts[-1].startswith("vitest.config"):
        continue
    total += int(size)
print(f"shipped_bytes={total}")
