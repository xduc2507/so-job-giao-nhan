<?php
// Thư viện dùng chung cho backend Sổ Job (PHP 8.1+).
declare(strict_types=1);

const SOJOB_COLS = ['jobs', 'meta', 'partners', 'todos'];
const SOJOB_IMAGE_TYPES = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
const SOJOB_MAX_IMAGE = 10 * 1024 * 1024;

// Không in lỗi PHP ra trình duyệt (tránh lộ đường dẫn, thông tin máy chủ); ghi vào log của host.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
set_exception_handler(function (Throwable $e): void {
    error_log('[sojob] ' . $e);
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(['error' => 'Lỗi máy chủ. Xem error log trên host để biết chi tiết.', 'code' => 'unavailable'], JSON_UNESCAPED_UNICODE);
});

function json_out(mixed $data, int $code = 200): never
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, string $code, int $status): never
{
    json_out(['error' => $message, 'code' => $code], $status);
}

function config_path(): string
{
    return __DIR__ . '/config.php';
}

function cfg(): array
{
    static $c = null;
    if ($c === null) {
        if (!is_file(config_path())) {
            fail('Chưa cài đặt. Mở install.php để cài.', 'not_installed', 503);
        }
        $c = require config_path();
    }
    return $c;
}

function pdo(): PDO
{
    static $p = null;
    if ($p === null) {
        $c = cfg();
        $p = new PDO($c['db_dsn'], $c['db_user'] ?? null, $c['db_pass'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $p;
}

function is_sqlite(PDO $p): bool
{
    return $p->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
}

function ensure_schema(PDO $p): void
{
    if (is_sqlite($p)) {
        $p->exec('CREATE TABLE IF NOT EXISTS sojob_docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (col, id))');
        $p->exec('CREATE TABLE IF NOT EXISTS sojob_users (username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)');
        return;
    }
    $p->exec('CREATE TABLE IF NOT EXISTS sojob_docs (col VARCHAR(40) NOT NULL, id VARCHAR(200) NOT NULL, data LONGTEXT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (col, id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    $p->exec('CREATE TABLE IF NOT EXISTS sojob_users (username VARCHAR(60) NOT NULL PRIMARY KEY, pass_hash VARCHAR(255) NOT NULL, is_admin TINYINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
}

function upsert_doc(string $col, string $id, string $json): void
{
    $p = pdo();
    $now = (int) floor(microtime(true) * 1000);
    $sql = is_sqlite($p)
        ? 'INSERT INTO sojob_docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
        : 'INSERT INTO sojob_docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)';
    $p->prepare($sql)->execute([$col, $id, $json, $now]);
}

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $life = 60 * 60 * 24 * 30;
    ini_set('session.gc_maxlifetime', (string) $life);
    session_name('sojob');
    session_set_cookie_params([
        'lifetime' => $life,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    ]);
    session_start();
}

/** Chặn yêu cầu ghi gửi từ trang khác (CSRF): mọi yêu cầu không phải GET phải có header riêng của app. */
function require_app_header(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'sojob') {
        fail('Yêu cầu không hợp lệ.', 'bad_request', 400);
    }
}

function current_user(): ?array
{
    start_session();
    return $_SESSION['user'] ?? null;
}

function require_login(): array
{
    require_app_header();
    $u = current_user();
    if (!$u) {
        fail('Cần đăng nhập.', 'unauthenticated', 401);
    }
    return $u;
}

function require_admin(): array
{
    $u = require_login();
    if (empty($u['admin'])) {
        fail('Chỉ quản trị viên được làm việc này.', 'forbidden', 403);
    }
    return $u;
}

function body_json(): array
{
    $d = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($d) ? $d : [];
}

function valid_username(string $u): bool
{
    return (bool) preg_match('/^[A-Za-z0-9_.\-]{3,60}$/', $u);
}

/** Đọc danh sách file ảnh từ $_FILES[$field] (một file hoặc mảng), kiểm tra loại và dung lượng. */
function uploaded_images(string $field, int $max): array
{
    $f = $_FILES[$field] ?? null;
    if (!$f) {
        return [];
    }
    $names = is_array($f['tmp_name']) ? $f['tmp_name'] : [$f['tmp_name']];
    $errors = is_array($f['error']) ? $f['error'] : [$f['error']];
    $sizes = is_array($f['size']) ? $f['size'] : [$f['size']];
    if (count($names) > $max) {
        fail("Tối đa $max ảnh mỗi lần.", 'image_rejected', 400);
    }
    $out = [];
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    foreach ($names as $i => $tmp) {
        if (($errors[$i] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($tmp)) {
            fail('Không nhận được ảnh. Ảnh có thể quá lớn so với giới hạn của host.', 'image_rejected', 400);
        }
        if (($sizes[$i] ?? 0) > SOJOB_MAX_IMAGE) {
            fail('Ảnh lớn hơn 10 MB.', 'image_rejected', 400);
        }
        $mime = (string) $finfo->file($tmp);
        if (!isset(SOJOB_IMAGE_TYPES[$mime])) {
            fail('Chỉ nhận ảnh JPG, PNG, GIF hoặc WebP.', 'image_rejected', 400);
        }
        $out[] = ['tmp' => $tmp, 'mime' => $mime, 'size' => (int) $sizes[$i]];
    }
    return $out;
}

function uploads_dir(): string
{
    $d = __DIR__ . '/uploads';
    if (!is_dir($d)) {
        mkdir($d, 0755, true);
    }
    if (!is_file("$d/.htaccess")) {
        file_put_contents("$d/.htaccess", "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
    }
    return $d;
}
