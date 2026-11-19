<?php
// Trả ảnh đã lưu cho người đã đăng nhập.
declare(strict_types=1);
require __DIR__ . '/../lib.php';

if (!current_user()) {
    http_response_code(401);
    exit;
}
session_write_close();
$id = (string) ($_GET['id'] ?? '');
if (!preg_match('/^[a-f0-9]{32}\.(jpg|png|gif|webp)$/', $id, $m)) {
    http_response_code(404);
    exit;
}
$path = __DIR__ . '/../uploads/' . $id;
if (!is_file($path)) {
    http_response_code(404);
    exit;
}
$types = array_flip(SOJOB_IMAGE_TYPES);
header('Content-Type: ' . $types[$m[1]]);
header('Content-Length: ' . filesize($path));
header('Cache-Control: private, max-age=31536000, immutable');
header('X-Content-Type-Options: nosniff');
readfile($path);
