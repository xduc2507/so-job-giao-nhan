<?php
// Trang chính: dùng nguyên giao diện so-job.html, chèn shim.js để nối với backend PHP.
declare(strict_types=1);

if (!is_file(__DIR__ . '/config.php')) {
    header('Location: install.php');
    exit;
}
$html = (string) file_get_contents(__DIR__ . '/so-job.html');
$shim = '<script src="shim.js?v=' . filemtime(__DIR__ . '/shim.js') . '"></script>' . "\n";
$pos = strpos($html, '<script>');
if ($pos !== false) {
    $html = substr($html, 0, $pos) . $shim . substr($html, $pos);
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
echo '<!doctype html><html lang="vi"><head><meta charset="utf-8">'
    . '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    . '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
    . 'body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
    . '</head><body>' . $html . '</body></html>';
