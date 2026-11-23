<?php
// Dựng bản tĩnh cho GitHub Pages vào thư mục docs/:  php build-pages.php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$root = __DIR__;
$out = $root . '/docs';
if (!is_dir($out)) mkdir($out, 0755, true);

$html = (string) file_get_contents($root . '/so-job.html');
$ver = substr(sha1_file($root . '/static-shim.js'), 0, 10);
$shim = '<script src="static-shim.js?v=' . $ver . '"></script>' . "\n";
// Kho online (Firebase): chỉ chèn khi có firebase-config.js (cấu hình web của Firebase là thông tin công khai)
if (is_file($root . '/firebase-config.js')) {
    copy($root . '/firebase-config.js', $out . '/firebase-config.js');
    $shim = '<script src="firebase-config.js?v=' . substr(sha1_file($root . '/firebase-config.js'), 0, 10) . '"></script>' . "\n" . $shim;
}
$pos = strpos($html, '<script>');
if ($pos === false) { fwrite(STDERR, "Không thấy <script> trong so-job.html\n"); exit(1); }
$html = substr($html, 0, $pos) . $shim . substr($html, $pos);

$page = '<!doctype html><html lang="vi"><head><meta charset="utf-8">'
    . '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    . '<meta name="referrer" content="same-origin">'
    . '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
    . 'body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
    . '</head><body>' . $html . '</body></html>';

file_put_contents($out . '/index.html', $page);
copy($root . '/static-shim.js', $out . '/static-shim.js');
file_put_contents($out . '/.nojekyll', '');
// Tên miền riêng cho GitHub Pages: luôn giữ docs/CNAME (dựng lại không được làm mất)
file_put_contents($out . '/CNAME', "opsdad.net
");
echo "Đã dựng docs/index.html (shim v=$ver)\n";
