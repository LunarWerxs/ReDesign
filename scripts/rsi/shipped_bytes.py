"""Bytes of product source shipped: committed size at HEAD of what `bun run dist` compiles into the release binary - the Bun server/CLI code under src/, the seed config JSON under src/config/, and the Vue web app under src/web/ (src/web/src + src/web/public) - without tests, dev scripts, type declarations, patches or build/tool config. Prints shipped_bytes=<n>."""
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
    # src/config/*.json are the models/prompts/pricing seeds imported by src/config/shared.ts and embedded in the binary.
    seed_json = parts[:2] == ["src", "config"] and low.endswith(".json")
    if not seed_json and (not low.endswith(SHIPPED) or low.endswith(SKIP_NAMES)):
        continue
    if "test" in parts or "tests" in parts or "patches" in parts or ".test." in low or ".spec." in low:
        continue
    # src/web/scripts holds dev-only checks (i18n-check.mjs, run by check:i18n), not part of the Vite build.
    if parts[:3] == ["src", "web", "scripts"]:
        continue
    if parts[-1].startswith("tsconfig") or parts[-1].startswith("vite.config") or parts[-1].startswith("vitest.config"):
        continue
    total += int(size)
print(f"shipped_bytes={total}")
