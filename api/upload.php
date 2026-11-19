<?php
// Lưu một ảnh chụp gốc của job, trả về id và đường dẫn xem ảnh.
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_login();
session_write_close();
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail('Phương thức không hỗ trợ.', 'invalid_request', 405);
}
$imgs = uploaded_images('file', 1);
if (!$imgs) {
    fail('Không có ảnh.', 'image_rejected', 400);
}
$img = $imgs[0];
$id = bin2hex(random_bytes(16)) . '.' . SOJOB_IMAGE_TYPES[$img['mime']];
if (!move_uploaded_file($img['tmp'], uploads_dir() . '/' . $id)) {
    fail('Không lưu được ảnh trên máy chủ.', 'unavailable', 500);
}
json_out(['id' => $id, 'url' => 'api/file.php?id=' . $id, 'sizeBytes' => $img['size'], 'contentType' => $img['mime']]);
