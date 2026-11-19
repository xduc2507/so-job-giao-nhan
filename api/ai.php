<?php
// Gửi ảnh chụp + lời nhắc tới Claude, trả về chữ Claude viết.
declare(strict_types=1);
require __DIR__ . '/../lib.php';
require __DIR__ . '/../vendor/autoload.php';

use Anthropic\Client;
use Anthropic\Core\Exceptions\APIConnectionException;
use Anthropic\Core\Exceptions\APIStatusException;
use Anthropic\Core\Exceptions\AuthenticationException;
use Anthropic\Core\Exceptions\BadRequestException;
use Anthropic\Core\Exceptions\OverloadedException;
use Anthropic\Core\Exceptions\PermissionDeniedException;
use Anthropic\Core\Exceptions\RateLimitException;

require_login();
session_write_close();
@set_time_limit(300);

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail('Phương thức không hỗ trợ.', 'invalid_request', 405);
}
$prompt = (string) ($_POST['prompt'] ?? '');
if (trim($prompt) === '' || strlen($prompt) > 262144) {
    fail('Lời nhắc trống hoặc quá dài.', 'invalid_request', 400);
}
if (!mb_check_encoding($prompt, 'UTF-8')) {
    fail('Nội dung gửi lên không đúng mã UTF-8.', 'invalid_request', 400);
}
$key = (string) (cfg()['anthropic_key'] ?? '');
if ($key === '') {
    fail('Chưa có API key Claude trong config.php.', 'sampling_disabled', 503);
}

$content = [];
foreach (uploaded_images('images', 5) as $img) {
    $content[] = [
        'type' => 'image',
        'source' => ['type' => 'base64', 'mediaType' => $img['mime'], 'data' => base64_encode((string) file_get_contents($img['tmp']))],
    ];
}
$content[] = ['type' => 'text', 'text' => $prompt];

$client = new Client(apiKey: $key);
try {
    $msg = $client->beta->messages->create(
        maxTokens: 16000,
        messages: [['role' => 'user', 'content' => $content]],
        model: 'claude-opus-5-5',
        outputConfig: ['effort' => 'medium'],
        // Nếu Claude từ chối vì chính sách, server tự thử lại trên mô hình dự phòng mặc định.
        fallbacks: 'default',
        betas: ['server-side-fallback-2026-07-01'],
        requestOptions: ['timeout' => 240.0],
    );
} catch (RateLimitException $e) {
    fail('Claude đang quá tải hoặc tài khoản API đã chạm giới hạn. Thử lại sau ít phút.', 'rate_limited', 429);
} catch (AuthenticationException | PermissionDeniedException $e) {
    fail('API key Claude không hợp lệ hoặc không có quyền. Kiểm tra lại config.php.', 'sampling_disabled', 502);
} catch (BadRequestException $e) {
    fail('Claude không nhận yêu cầu: ' . $e->getMessage(), 'invalid_request', 400);
} catch (OverloadedException $e) {
    fail('Claude đang quá tải. Thử lại sau ít phút.', 'rate_limited', 503);
} catch (APIStatusException $e) {
    fail('Lỗi từ Claude API (' . $e->getCode() . '). Thử lại.', 'upstream_error', 502);
} catch (APIConnectionException $e) {
    error_log('[sojob] Claude API connection: ' . $e->getMessage() . ' | ' . ($e->getPrevious()?->getMessage() ?? ''));
    fail('Không kết nối được tới Claude API (hết giờ hoặc mất mạng). Thử lại.', 'upstream_error', 504);
}

if ($msg->stopReason === 'refusal') {
    fail('Claude không xử lý được nội dung này.', 'refused', 422);
}
$text = '';
foreach ($msg->content as $block) {
    if ($block->type === 'text') {
        $text .= $block->text;
    }
}
if (trim($text) === '') {
    fail('Claude không trả về nội dung.', 'empty_completion', 502);
}
json_out(['text' => $text, 'truncated' => $msg->stopReason === 'max_tokens']);
