<?php
// Quản lý người dùng (chỉ quản trị viên). GET: danh sách. POST {username,password,admin}: thêm / đổi mật khẩu. DELETE ?u=: xoá.
declare(strict_types=1);
require __DIR__ . '/../lib.php';

$me = require_admin();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $rows = pdo()->query('SELECT username, is_admin, created_at FROM sojob_users ORDER BY username')->fetchAll();
    json_out(['users' => array_map(fn($r) => ['username' => $r['username'], 'admin' => (bool) $r['is_admin'], 'createdAt' => (int) $r['created_at']], $rows)]);
}

if ($method === 'POST') {
    $b = body_json();
    $u = trim((string) ($b['username'] ?? ''));
    $p = (string) ($b['password'] ?? '');
    if (!valid_username($u)) {
        fail('Tên đăng nhập 3–60 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang.', 'invalid_argument', 400);
    }
    if (strlen($p) < 8) {
        fail('Mật khẩu tối thiểu 8 ký tự.', 'invalid_argument', 400);
    }
    $admin = !empty($b['admin']) ? 1 : 0;
    $hash = password_hash($p, PASSWORD_DEFAULT);
    $pdo = pdo();
    $exists = $pdo->prepare('SELECT 1 FROM sojob_users WHERE username = ?');
    $exists->execute([$u]);
    if ($exists->fetchColumn()) {
        $pdo->prepare('UPDATE sojob_users SET pass_hash = ?, is_admin = ? WHERE username = ?')->execute([$hash, $admin, $u]);
    } else {
        $pdo->prepare('INSERT INTO sojob_users (username, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
            ->execute([$u, $hash, $admin, (int) floor(microtime(true) * 1000)]);
    }
    json_out(['ok' => true]);
}

if ($method === 'DELETE') {
    $u = (string) ($_GET['u'] ?? '');
    if ($u === $me['username']) {
        fail('Không tự xoá tài khoản đang dùng.', 'invalid_argument', 400);
    }
    pdo()->prepare('DELETE FROM sojob_users WHERE username = ?')->execute([$u]);
    json_out(['ok' => true]);
}

fail('Phương thức không hỗ trợ.', 'invalid_request', 405);
