#!/usr/bin/env bash
# 打包成 release zip：解压即可放进 desktop-plugins/
# 依赖 python3（zip 命令在 Windows/git-bash 上通常没有）
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="hermes-sliding-reasoning"
VERSION=$(grep -E '^version:' plugin.yaml | sed 's/^version: *"\(.*\)"/\1/')
OUT="dist/${NAME}-${VERSION}.zip"

mkdir -p dist
rm -f "$OUT"

python - "$OUT" <<'PY'
import sys, zipfile, os
out = sys.argv[1]
files = ['plugin.yaml', 'desktop/plugin.js', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE']
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        if os.path.exists(f):
            z.write(f, f)   # 根目录形式，解压后即是插件目录内容
print(f'OK  {out}')
with zipfile.ZipFile(out) as z:
    for i in z.infolist():
        print(f'  {i.filename:28s} {i.file_size:>8,} B')
    print(f'  {"total":28s} {sum(i.file_size for i in z.infolist()):>8,} B')
PY

echo
echo "install to:"
echo "  ~/.hermes/desktop-plugins/${NAME}/"
echo "  Windows: %LOCALAPPDATA%\\hermes\\desktop-plugins\\${NAME}\\"
