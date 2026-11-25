#!/bin/sh
# Đẩy bản app sang link phụ https://xduc2507.github.io/sojob/ (repo xduc2507/sojob, không tên miền)
# để mở được ở công ty khi tường lửa chặn opsdad.net. Chạy sau build-pages.php, từ thư mục gốc repo.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; M="$ROOT/mirror"
if [ ! -d "$M/.git" ]; then git clone -q https://github.com/xduc2507/sojob.git "$M"; git -C "$M" config user.name "$(git -C "$ROOT" config user.name)"; git -C "$M" config user.email "$(git -C "$ROOT" config user.email)"; fi
cp "$ROOT"/docs/*.html "$ROOT"/docs/*.js "$ROOT"/docs/*.png "$ROOT"/docs/*.jpg "$ROOT"/docs/*.webmanifest "$M"/
rm -f "$M"/_t.html "$M"/_mock.js "$M"/CNAME; touch "$M/.nojekyll"
cd "$M"; git add -A
if git diff --cached --quiet; then echo "link phụ: không có gì mới"; exit 0; fi
git commit -q -m "Cập nhật bản $(grep -o 'APP_VER="20[^"]*"' index.html | head -1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q && echo "link phụ: đã đẩy $(git log --oneline -1)"
