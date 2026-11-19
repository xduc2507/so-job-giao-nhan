<?php
// GET: ai đang đăng nhập. POST {action:"login",username,password} hoặc {action:"logout"}.
declare(strict_types=1);
require __DIR__ . '/../lib.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    $u = current_user();
    json_out(['user' => $u ? ['username' => $u['username'], 'admin' => !empty($u['admin'])] : null]);
}
require_app_header();
$b = body_json();
$action = (string) ($b['action'] ?? '');

if ($action === 'logout') {
    start_session();
    $_SESSION = [];
    session_destroy();
    json_out(['ok' => true]);
}

if ($action === 'login') {
    $user = trim((string) ($b['username'] ?? ''));
    $pass = (string) ($b['password'] ?? '');
    $s = pdo()->prepare('SELECT username, pass_hash, is_admin FROM sojob_users WHERE username = ?');
    $s->execute([$user]);
    $row = $s->fetch();
    if (!$row || !password_verify($pass, $row['pass_hash'])) {
        usleep(800000); // làm chậm việc đoán mật khẩu
        fail('Sai tên đăng nhập hoặc mật khẩu.', 'bad_credentials', 401);
    }
    start_session();
    session_regenerate_id(true);
    $_SESSION['user'] = ['username' => $row['username'], 'admin' => (bool) $row['is_admin']];
    json_out(['user' => ['username' => $row['username'], 'admin' => (bool) $row['is_admin']]]);
}

fail('Thao tác không hợp lệ.', 'invalid_request', 400);
