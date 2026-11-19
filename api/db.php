<?php
// Kho tài liệu JSON: GET đọc cả bộ sưu tập, PUT ghi một tài liệu, DELETE xoá một tài liệu.
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_login();
session_write_close();

$col = (string) ($_GET['col'] ?? '');
if (!in_array($col, SOJOB_COLS, true)) {
    fail('Bộ sưu tập không hợp lệ.', 'invalid_argument', 400);
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $v = pdo()->prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m FROM sojob_docs WHERE col = ?');
    $v->execute([$col]);
    $r = $v->fetch();
    $ver = $r['n'] . '-' . $r['m'];
    if (($_GET['ver'] ?? '') === $ver) {
        json_out(['same' => true, 'ver' => $ver]);
    }
    $s = pdo()->prepare('SELECT id, data FROM sojob_docs WHERE col = ? ORDER BY id');
    $s->execute([$col]);
    $docs = [];
    foreach ($s as $row) {
        // Giải mã thành object (không phải mảng) để giữ nguyên {} và [] khi trả về.
        $docs[] = ['id' => $row['id'], 'data' => json_decode($row['data'])];
    }
    json_out(['ver' => $ver, 'docs' => $docs]);
}

$id = (string) ($_GET['id'] ?? '');
if (!preg_match('/^[A-Za-z0-9_\-.~:@+]{1,200}$/', $id) || $id === '.' || $id === '..') {
    fail('Mã tài liệu không hợp lệ.', 'invalid_argument', 400);
}

if ($method === 'PUT') {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > 262144) {
        fail('Tài liệu lớn hơn 256 KB.', 'invalid_argument', 413);
    }
    $data = json_decode($raw);
    if (!($data instanceof stdClass)) {
        fail('Nội dung phải là một JSON object.', 'invalid_argument', 400);
    }
    $count = (int) pdo()->query('SELECT COUNT(*) FROM sojob_docs')->fetchColumn();
    if ($count >= 25000) {
        fail('Kho dữ liệu đã đầy (25.000 tài liệu).', 'quota_exceeded', 507);
    }
    upsert_doc($col, $id, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    json_out(['ok' => true]);
}

if ($method === 'DELETE') {
    pdo()->prepare('DELETE FROM sojob_docs WHERE col = ? AND id = ?')->execute([$col, $id]);
    json_out(['ok' => true]);
}

fail('Phương thức không hỗ trợ.', 'invalid_argument', 405);
