<?php
// Trang cài đặt một lần: nhập thông tin MySQL, API key Claude và tài khoản quản trị, rồi tạo config.php.
declare(strict_types=1);
require __DIR__ . '/lib.php';

$done = is_file(config_path());
$error = '';
$ok = false;
$v = fn(string $k, string $d = '') => htmlspecialchars((string) ($_POST[$k] ?? $d), ENT_QUOTES);

if (!$done && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $host = trim((string) ($_POST['db_host'] ?? 'localhost'));
    $name = trim((string) ($_POST['db_name'] ?? ''));
    $user = trim((string) ($_POST['db_user'] ?? ''));
    $pass = (string) ($_POST['db_pass'] ?? '');
    $key = trim((string) ($_POST['anthropic_key'] ?? ''));
    $admin = trim((string) ($_POST['admin_user'] ?? ''));
    $adminPass = (string) ($_POST['admin_pass'] ?? '');
    try {
        if ($name === '' || $user === '') {
            throw new RuntimeException('Điền tên database và user MySQL.');
        }
        if (!str_starts_with($key, 'sk-ant-')) {
            throw new RuntimeException('API key Claude phải bắt đầu bằng sk-ant-.');
        }
        if (!valid_username($admin)) {
            throw new RuntimeException('Tên quản trị 3–60 ký tự, chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang.');
        }
        if (strlen($adminPass) < 8) {
            throw new RuntimeException('Mật khẩu quản trị tối thiểu 8 ký tự.');
        }
        $dsn = "mysql:host=$host;dbname=$name;charset=utf8mb4";
        try {
            $p = new PDO($dsn, $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        } catch (PDOException $e) {
            throw new RuntimeException('Không kết nối được MySQL: kiểm tra host, tên database, user và mật khẩu.');
        }
        ensure_schema($p);
        $p->prepare('INSERT INTO sojob_users (username, pass_hash, is_admin, created_at) VALUES (?, ?, 1, ?) ON DUPLICATE KEY UPDATE pass_hash = VALUES(pass_hash), is_admin = 1')
            ->execute([$admin, password_hash($adminPass, PASSWORD_DEFAULT), (int) floor(microtime(true) * 1000)]);
        $config = "<?php\n// Tạo bởi install.php ngày " . date('Y-m-d H:i') . ". Không đưa file này lên GitHub.\nreturn " . var_export([
            'db_dsn' => $dsn,
            'db_user' => $user,
            'db_pass' => $pass,
            'anthropic_key' => $key,
        ], true) . ";\n";
        if (file_put_contents(config_path(), $config, LOCK_EX) === false) {
            throw new RuntimeException('Không ghi được config.php: thư mục không cho phép ghi.');
        }
        @chmod(config_path(), 0600);
        uploads_dir();
        $ok = true;
        $done = true;
    } catch (RuntimeException $e) {
        $error = $e->getMessage();
    }
}
?><!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cài đặt Sổ Job</title>
<style>
:root{--bg:#EEF1F4;--surface:#fff;--ink:#15212C;--muted:#5A6A79;--line:#D8DFE6;--accent:#C2541D;--bad:#B42318;--ok:#1E7A4C}
@media (prefers-color-scheme:dark){:root{--bg:#0E151B;--surface:#16202A;--ink:#E4ECF3;--muted:#91A2B2;--line:#283541;--accent:#E57A43;--bad:#F2766B;--ok:#52C48C;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px max(16px,env(safe-area-inset-left))}
main{max-width:560px;margin:0 auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:20px}p{margin:0;color:var(--muted)}fieldset{border:1px solid var(--line);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
legend{font-weight:600;padding:0 6px}label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px}
button{font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:10px 16px;cursor:pointer}
.err{color:var(--bad);font-weight:600}.ok{color:var(--ok);font-weight:600}a{color:var(--accent)}
</style></head><body><main>
<h1>Cài đặt Sổ Job Giao Nhận</h1>
<?php if ($ok): ?>
  <p class="ok">Cài đặt xong. Trang cài đặt đã tự khoá.</p>
  <p><a href="./">Mở Sổ Job và đăng nhập</a></p>
<?php elseif ($done): ?>
  <p>Đã cài đặt rồi. Muốn cài lại, xoá file <code>config.php</code> trên host trước.</p>
  <p><a href="./">Mở Sổ Job</a></p>
<?php else: ?>
  <p>Điền một lần. Thông tin được lưu vào <code>config.php</code> trên host, không gửi đi đâu khác.</p>
  <?php if ($error): ?><p class="err"><?= htmlspecialchars($error) ?></p><?php endif; ?>
  <form method="post" autocomplete="off">
    <fieldset><legend>MySQL (tạo trong hPanel → Databases)</legend>
      <label>Host<input name="db_host" value="<?= $v('db_host', 'localhost') ?>" required></label>
      <label>Tên database<input name="db_name" value="<?= $v('db_name') ?>" placeholder="u123456789_sojob" required></label>
      <label>User<input name="db_user" value="<?= $v('db_user') ?>" placeholder="u123456789_sojob" required></label>
      <label>Mật khẩu<input name="db_pass" type="password" required></label>
    </fieldset>
    <fieldset><legend>Claude API</legend>
      <label>API key (lấy ở console.anthropic.com → API keys)<input name="anthropic_key" type="password" placeholder="sk-ant-…" required></label>
    </fieldset>
    <fieldset><legend>Tài khoản quản trị</legend>
      <label>Tên đăng nhập<input name="admin_user" value="<?= $v('admin_user') ?>" required></label>
      <label>Mật khẩu (tối thiểu 8 ký tự)<input name="admin_pass" type="password" minlength="8" required></label>
    </fieldset>
    <button type="submit">Cài đặt</button>
  </form>
<?php endif; ?>
</main></body></html>
