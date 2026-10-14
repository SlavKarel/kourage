<?php
declare(strict_types=1);

function pushBase64UrlEncode(string $value): string {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function pushBase64UrlDecode(string $value): string|false {
    $padding = strlen($value) % 4;
    if ($padding) $value .= str_repeat('=', 4 - $padding);
    return base64_decode(strtr($value, '-_', '+/'), true);
}

function pushHkdf(string $salt, string $input, string $info, int $length): string {
    $prk = hash_hmac('sha256', $input, $salt, true);
    $result = '';
    $previous = '';
    for ($counter = 1; strlen($result) < $length; $counter++) {
        $previous = hash_hmac('sha256', $previous.$info.chr($counter), $prk, true);
        $result .= $previous;
    }
    return substr($result, 0, $length);
}

function pushDerLength(int $length): string {
    if ($length < 128) return chr($length);
    $bytes = '';
    while ($length > 0) {
        $bytes = chr($length & 0xff).$bytes;
        $length >>= 8;
    }
    return chr(0x80 | strlen($bytes)).$bytes;
}

function pushReadDerLength(string $der, int &$offset): int {
    $first = ord($der[$offset++]);
    if (($first & 0x80) === 0) return $first;
    $count = $first & 0x7f;
    if ($count < 1 || $count > 4 || $offset + $count > strlen($der)) throw new RuntimeException('Некорректная ECDSA-подпись.');
    $length = 0;
    for ($index = 0; $index < $count; $index++) $length = ($length << 8) | ord($der[$offset++]);
    return $length;
}

function pushDerSignatureToJose(string $der): string {
    $offset = 0;
    if (($der[$offset++] ?? '') !== "\x30") throw new RuntimeException('Некорректная ECDSA-подпись.');
    pushReadDerLength($der, $offset);
    $parts = [];
    for ($part = 0; $part < 2; $part++) {
        if (($der[$offset++] ?? '') !== "\x02") throw new RuntimeException('Некорректная ECDSA-подпись.');
        $length = pushReadDerLength($der, $offset);
        $integer = substr($der, $offset, $length);
        $offset += $length;
        $integer = ltrim($integer, "\x00");
        if (strlen($integer) > 32) throw new RuntimeException('Некорректная ECDSA-подпись.');
        $parts[] = str_pad($integer, 32, "\x00", STR_PAD_LEFT);
    }
    return $parts[0].$parts[1];
}

function pushPublicKeyPem(string $point): string {
    if (strlen($point) !== 65 || $point[0] !== "\x04") throw new RuntimeException('Некорректный ключ подписки.');
    $prefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    return "-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($prefix.$point), 64, "\n")."-----END PUBLIC KEY-----\n";
}

function pushVapidKeys(string $privateDirectory): array {
    $path = $privateDirectory.'/web-push-vapid.json';
    $lock = fopen($privateDirectory.'/web-push-vapid.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('Не удалось подготовить ключ уведомлений.');
    try {
        if (is_file($path)) {
            $stored = json_decode((string)file_get_contents($path), true);
            if (is_array($stored) && isset($stored['private'], $stored['public'])) return $stored;
        }
        $key = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_EC, 'curve_name'=>'prime256v1']);
        if ($key === false || !openssl_pkey_export($key, $privatePem)) throw new RuntimeException('OpenSSL не создал ключ уведомлений.');
        $details = openssl_pkey_get_details($key);
        if (!is_array($details) || !isset($details['ec']['x'], $details['ec']['y'])) throw new RuntimeException('OpenSSL не вернул открытый ключ уведомлений.');
        $public = "\x04".$details['ec']['x'].$details['ec']['y'];
        $stored = ['private'=>$privatePem, 'public'=>pushBase64UrlEncode($public)];
        $temporary = $path.'.'.bin2hex(random_bytes(6)).'.tmp';
        if (file_put_contents($temporary, json_encode($stored, JSON_UNESCAPED_SLASHES), LOCK_EX) === false) throw new RuntimeException('Не удалось сохранить ключ уведомлений.');
        @chmod($temporary, 0600);
        if (!rename($temporary, $path)) { @unlink($temporary); throw new RuntimeException('Не удалось установить ключ уведомлений.'); }
        @chmod($path, 0600);
        return $stored;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function pushVapidAuthorization(string $endpoint, array $keys): string {
    $parts = parse_url($endpoint);
    if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])) throw new RuntimeException('Некорректная точка доставки уведомления.');
    $audience = 'https://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '');
    $header = pushBase64UrlEncode('{"typ":"JWT","alg":"ES256"}');
    $payload = pushBase64UrlEncode((string)json_encode(['aud'=>$audience, 'exp'=>time()+6*60*60, 'sub'=>'mailto:notifications@kourage.ru'], JSON_UNESCAPED_SLASHES));
    $input = $header.'.'.$payload;
    $privateKey = openssl_pkey_get_private($keys['private']);
    if ($privateKey === false || !openssl_sign($input, $signature, $privateKey, OPENSSL_ALGO_SHA256)) throw new RuntimeException('Не удалось подписать уведомление.');
    return 'vapid t='.$input.'.'.pushBase64UrlEncode(pushDerSignatureToJose($signature)).', k='.$keys['public'];
}

function pushEncryptedBody(array $subscription, string $payload): string {
    $clientPublic = pushBase64UrlDecode((string)$subscription['p256dh']);
    $clientAuth = pushBase64UrlDecode((string)$subscription['auth']);
    if ($clientPublic === false || strlen($clientPublic) !== 65 || $clientAuth === false || strlen($clientAuth) < 16) throw new RuntimeException('Некорректные ключи подписки.');
    $serverKey = openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_EC, 'curve_name'=>'prime256v1']);
    $clientKey = openssl_pkey_get_public(pushPublicKeyPem($clientPublic));
    if ($serverKey === false || $clientKey === false) throw new RuntimeException('Не удалось прочитать ключи подписки.');
    $details = openssl_pkey_get_details($serverKey);
    if (!is_array($details) || !isset($details['ec']['x'], $details['ec']['y'])) throw new RuntimeException('Не удалось создать ключ шифрования.');
    $serverPublic = "\x04".$details['ec']['x'].$details['ec']['y'];
    $shared = openssl_pkey_derive($clientKey, $serverKey, 32);
    if ($shared === false) throw new RuntimeException('Не удалось согласовать ключ шифрования.');
    $inputKey = pushHkdf($clientAuth, $shared, "WebPush: info\x00".$clientPublic.$serverPublic, 32);
    $salt = random_bytes(16);
    $contentKey = pushHkdf($salt, $inputKey, "Content-Encoding: aes128gcm\x00", 16);
    $nonce = pushHkdf($salt, $inputKey, "Content-Encoding: nonce\x00", 12);
    $ciphertext = openssl_encrypt($payload."\x02", 'aes-128-gcm', $contentKey, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    if ($ciphertext === false) throw new RuntimeException('Не удалось зашифровать уведомление.');
    return $salt.pack('N', 4096).chr(strlen($serverPublic)).$serverPublic.$ciphertext.$tag;
}

function pushSendOne(string $privateDirectory, array $subscription, array $message): int {
    if (!function_exists('curl_init')) throw new RuntimeException('На сервере недоступен модуль cURL.');
    $endpoint = (string)$subscription['endpoint'];
    $keys = pushVapidKeys($privateDirectory);
    $payload = json_encode($message, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (!is_string($payload) || strlen($payload) > 3000) throw new RuntimeException('Уведомление слишком большое.');
    $body = pushEncryptedBody($subscription, $payload);
    $curl = curl_init($endpoint);
    if ($curl === false) throw new RuntimeException('Не удалось открыть канал уведомлений.');
    curl_setopt_array($curl, [
        CURLOPT_POST=>true,
        CURLOPT_POSTFIELDS=>$body,
        CURLOPT_HTTPHEADER=>[
            'Authorization: '.pushVapidAuthorization($endpoint, $keys),
            'Crypto-Key: p256ecdsa='.$keys['public'],
            'Content-Encoding: aes128gcm',
            'Content-Type: application/octet-stream',
            'Content-Length: '.strlen($body),
            'TTL: 86400',
            'Urgency: normal'
        ],
        CURLOPT_RETURNTRANSFER=>true,
        CURLOPT_CONNECTTIMEOUT=>3,
        CURLOPT_TIMEOUT=>7,
        CURLOPT_HEADER=>false
    ]);
    curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);
    if ($status < 200 || $status >= 300) {
        if ($status !== 404 && $status !== 410) throw new RuntimeException('Сервис уведомлений ответил '.$status.($error !== '' ? ': '.$error : ''));
    }
    return $status;
}

function pushNotifyUser(PDO $db, string $privateDirectory, int $userId, string $title, string $body, string $url, string $tag): void {
    try {
        $subscriptions = run($db, 'SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=? ORDER BY updated_at DESC LIMIT 8', [$userId])->fetchAll();
        foreach ($subscriptions as $subscription) {
            try {
                $status = pushSendOne($privateDirectory, $subscription, ['title'=>$title, 'body'=>$body, 'url'=>$url, 'tag'=>$tag]);
                if ($status === 404 || $status === 410) run($db, 'DELETE FROM push_subscriptions WHERE id=?', [$subscription['id']]);
            } catch (Throwable $error) {
                error_log('Kourage push delivery failed: '.$error->getMessage());
            }
        }
    } catch (Throwable $error) {
        error_log('Kourage push lookup failed: '.$error->getMessage());
    }
}
