<?php
declare(strict_types=1);
// PHP 8.1+; PDO SQLite. Keep ../private OUTSIDE the public directory.
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
$secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
$rememberCookie = 'kourage_remember';
$rememberLifetime = 180 * 24 * 60 * 60;
session_name('kourage_session');
session_set_cookie_params(['lifetime'=>0,'path'=>'/','secure'=>$secure,'httponly'=>true,'samesite'=>'Lax']);
ini_set('session.use_strict_mode', '1');
session_start();

function reply(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(string $message, int $status = 400): never { reply(['error'=>$message], $status); }
function textValue(array $data, string $key, int $max, bool $required = false): string {
    $value = $data[$key] ?? '';
    if (!is_string($value)) fail('Некорректное поле: '.$key);
    $value = trim($value);
    if (($required && $value === '') || strlen($value) > $max) fail('Проверьте заполнение поля: '.$key);
    return $value;
}
function passwordValue(array $data, string $key = 'password'): string {
    $value = $data[$key] ?? null;
    if (!is_string($value) || strlen($value) < 6 || strlen($value) > 72) fail('Пароль должен содержать от 6 до 72 байт (для латиницы — символов).');
    return $value;
}
function run(PDO $db, string $sql, array $params = []): PDOStatement {
    $stmt = $db->prepare($sql); $stmt->execute($params); return $stmt;
}
function publicUser(array $user): array {
    return array_intersect_key($user, array_flip(['id','name','login','role','active','created_at']));
}
function requireAdmin(array $user): void { if ($user['role'] !== 'admin') fail('Доступ только для преподавателя.',403); }
function validLink(string $url): string {
    if ($url !== '' && (!filter_var($url, FILTER_VALIDATE_URL) || !in_array(strtolower((string)parse_url($url,PHP_URL_SCHEME)), ['http','https'],true))) fail('Укажите ссылку, начинающуюся с https:// или http://.');
    return $url;
}
function validDate(string $date): string {
    if ($date === '') return '';
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    if (!$d || $d->format('Y-m-d') !== $date) fail('Некорректная дата.');
    return $date;
}
function idValue(array $data, string $key): int {
    $id = filter_var($data[$key] ?? null,FILTER_VALIDATE_INT);
    if ($id === false || $id < 1) fail('Некорректный идентификатор.');
    return $id;
}
function normalizedAnswer(string $value): string {
    $value = trim((string)preg_replace('/\s+/u',' ',$value));
    return function_exists('mb_strtolower') ? mb_strtolower($value,'UTF-8') : strtolower($value);
}
function clearRemember(PDO $db, string $cookieName, bool $secure): void {
    $value = $_COOKIE[$cookieName] ?? '';
    if (is_string($value) && preg_match('/^([a-f0-9]{32})\.([a-f0-9]{64})$/D',$value,$parts)) {
        run($db,'DELETE FROM remember_tokens WHERE selector=?',[$parts[1]]);
    }
    setcookie($cookieName,'',['expires'=>time()-3600,'path'=>'/','secure'=>$secure,'httponly'=>true,'samesite'=>'Lax']);
    unset($_COOKIE[$cookieName]);
}
function issueRemember(PDO $db, array $user, string $cookieName, int $lifetime, bool $secure): void {
    $selector = bin2hex(random_bytes(16));
    $validator = bin2hex(random_bytes(32));
    $expires = time() + $lifetime;
    run($db,'INSERT INTO remember_tokens(selector,user_id,token_hash,auth_version,expires_at) VALUES(?,?,?,?,?)',[
        $selector,$user['id'],hash('sha256',$validator),(int)$user['auth_version'],$expires
    ]);
    setcookie($cookieName,$selector.'.'.$validator,['expires'=>$expires,'path'=>'/','secure'=>$secure,'httponly'=>true,'samesite'=>'Lax']);
}
function restoreRemember(PDO $db, string $cookieName, bool $secure): array|false {
    $value = $_COOKIE[$cookieName] ?? '';
    if (!is_string($value) || !preg_match('/^([a-f0-9]{32})\.([a-f0-9]{64})$/D',$value,$parts)) {
        if ($value !== '') clearRemember($db,$cookieName,$secure);
        return false;
    }
    $row = run($db,'SELECT r.token_hash,r.auth_version AS remembered_version,r.expires_at,u.* FROM remember_tokens r JOIN users u ON u.id=r.user_id WHERE r.selector=?',[$parts[1]])->fetch();
    if (!$row || (int)$row['expires_at'] < time() || !(int)$row['active'] || $row['deleted_at'] !== null || (int)$row['remembered_version'] !== (int)$row['auth_version'] || !hash_equals($row['token_hash'],hash('sha256',$parts[2]))) {
        clearRemember($db,$cookieName,$secure);
        return false;
    }
    run($db,'UPDATE remember_tokens SET last_used_at=? WHERE selector=?',[time(),$parts[1]]);
    session_regenerate_id(true);
    $_SESSION['uid'] = $row['id'];
    $_SESSION['auth_version'] = (int)$row['auth_version'];
    $_SESSION['last_seen'] = time();
    $_SESSION['csrf'] = bin2hex(random_bytes(24));
    return $row;
}

try {
    $private = dirname(__DIR__).'/private';
    if (!is_dir($private) || !is_writable($private)) fail('Не найдена доступная для записи папка private. Проверьте установку по инструкции.',503);
    $db = new PDO('sqlite:'.$private.'/kourage.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    $db->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    $db->exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','student')), active INTEGER NOT NULL DEFAULT 1, auth_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, subject TEXT NOT NULL, description TEXT NOT NULL, resource_url TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','submitted','revision','done')), solution TEXT NOT NULL DEFAULT '', solution_url TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', score INTEGER, max_score INTEGER NOT NULL DEFAULT 10, submitted_at TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_tasks_student_updated ON tasks(student_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), uploader_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('material','solution')), name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id,deleted);
    CREATE TABLE IF NOT EXISTS classwork_files (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), uploader_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, relative_path TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_classwork_student ON classwork_files(student_id,deleted,relative_path);
    CREATE TABLE IF NOT EXISTS editor_presence (student_id INTEGER NOT NULL REFERENCES users(id), user_id INTEGER NOT NULL REFERENCES users(id), file_id INTEGER, cursor_start INTEGER NOT NULL DEFAULT 0, cursor_end INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL, PRIMARY KEY(student_id,user_id));
    CREATE INDEX IF NOT EXISTS idx_editor_presence_seen ON editor_presence(student_id,last_seen);
    CREATE TABLE IF NOT EXISTS remember_tokens (selector TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, auth_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
    CREATE INDEX IF NOT EXISTS idx_remember_user ON remember_tokens(user_id);
    CREATE TABLE IF NOT EXISTS question_bank (id INTEGER PRIMARY KEY, teacher_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, subject TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', exam_number INTEGER CHECK(exam_number BETWEEN 1 AND 27), difficulty TEXT NOT NULL DEFAULT 'medium' CHECK(difficulty IN ('easy','medium','hard')), prompt TEXT NOT NULL, correct_answer TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '', default_score INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), deleted_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_question_bank_teacher ON question_bank(teacher_id,deleted_at,updated_at DESC);
    CREATE TABLE IF NOT EXISTS question_bank_files (id INTEGER PRIMARY KEY, bank_item_id INTEGER NOT NULL REFERENCES question_bank(id), uploader_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream', deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_question_bank_files_item ON question_bank_files(bank_item_id,deleted,id);
    CREATE TABLE IF NOT EXISTS homeworks (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), created_by INTEGER NOT NULL REFERENCES users(id), group_id TEXT, title TEXT NOT NULL, subject TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','submitted','revision','done')), feedback TEXT NOT NULL DEFAULT '', score INTEGER, max_score INTEGER NOT NULL DEFAULT 1, submitted_at TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), deleted_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_homeworks_student ON homeworks(student_id,deleted_at,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_homeworks_group ON homeworks(group_id);
    CREATE TABLE IF NOT EXISTS homework_questions (id INTEGER PRIMARY KEY, homework_id INTEGER NOT NULL REFERENCES homeworks(id), bank_item_id INTEGER REFERENCES question_bank(id), position INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, correct_answer TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '', max_score INTEGER NOT NULL DEFAULT 1, answer_text TEXT NOT NULL DEFAULT '', code_text TEXT NOT NULL DEFAULT '', teacher_feedback TEXT NOT NULL DEFAULT '', awarded_score INTEGER, auto_correct INTEGER, UNIQUE(homework_id,position));
    CREATE INDEX IF NOT EXISTS idx_homework_questions_homework ON homework_questions(homework_id,position);
    CREATE TABLE IF NOT EXISTS homework_files (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES homework_questions(id), uploader_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_homework_files_question ON homework_files(question_id,deleted);
    CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);");
    $userColumns = array_column($db->query('PRAGMA table_info(users)')->fetchAll(),'name');
    if (!in_array('deleted_at',$userColumns,true)) $db->exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
    $taskColumns = array_column($db->query('PRAGMA table_info(tasks)')->fetchAll(),'name');
    if (!in_array('deleted_at',$taskColumns,true)) $db->exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT');
    if (!in_array('group_id',$taskColumns,true)) $db->exec('ALTER TABLE tasks ADD COLUMN group_id TEXT');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)');
    $attachmentColumns=array_column($db->query('PRAGMA table_info(attachments)')->fetchAll(),'name');
    if(!in_array('relative_path',$attachmentColumns,true))$db->exec('ALTER TABLE attachments ADD COLUMN relative_path TEXT');
    $db->exec("UPDATE attachments SET relative_path=name WHERE relative_path IS NULL OR relative_path=''");
    $bankColumns=array_column($db->query('PRAGMA table_info(question_bank)')->fetchAll(),'name');
    if(!in_array('exam_number',$bankColumns,true))$db->exec('ALTER TABLE question_bank ADD COLUMN exam_number INTEGER');
    $classworkColumns=array_column($db->query('PRAGMA table_info(classwork_files)')->fetchAll(),'name');
    if(!in_array('revision',$classworkColumns,true))$db->exec('ALTER TABLE classwork_files ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if(!in_array('updated_at',$classworkColumns,true))$db->exec("ALTER TABLE classwork_files ADD COLUMN updated_at TEXT");
    $db->exec("UPDATE classwork_files SET updated_at=created_at WHERE updated_at IS NULL OR updated_at=''");
    if (is_file($private.'/kourage.sqlite')) @chmod($private.'/kourage.sqlite',0600);
    run($db,'DELETE FROM remember_tokens WHERE expires_at < ?',[time()]);
    $_SESSION['csrf'] ??= bin2hex(random_bytes(24));
    $action = $_GET['action'] ?? 'bootstrap';
    $method = $_SERVER['REQUEST_METHOD'];
    $data = [];
    if ($method === 'POST') {
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > (in_array($action,['upload','classwork_upload','homework_file_upload','bank_file_upload'],true) ? 11*1024*1024 : 200000)) fail('Слишком большой запрос.',413);
        if (!hash_equals($_SESSION['csrf'],$_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) fail('Обновите страницу и повторите действие.',403);
        if (in_array($action,['upload','classwork_upload','homework_file_upload','bank_file_upload'],true)) { $data = $_POST; } else {
        $raw = file_get_contents('php://input',false,null,0,200001);
        if (strlen($raw) > 200000) fail('Слишком большой запрос.',413);
        $data = json_decode($raw,true);
        if (!is_array($data)) fail('Некорректный запрос.');
        }
    } elseif ($method !== 'GET') fail('Метод не поддерживается.',405);
    $installed = (int)$db->query("SELECT COUNT(*) FROM users WHERE role='admin'")->fetchColumn() > 0;
    $user = isset($_SESSION['uid']) ? run($db,'SELECT * FROM users WHERE id=?',[$_SESSION['uid']])->fetch() : false;
    if ($user && (!(int)$user['active'] || (int)$user['auth_version'] !== (int)($_SESSION['auth_version'] ?? -1) || time() - (int)($_SESSION['last_seen'] ?? 0) > 43200)) {
        unset($_SESSION['uid'],$_SESSION['auth_version']); $user = false;
    }
    if (!$user) $user = restoreRemember($db,$rememberCookie,$secure);
    if ($user) $_SESSION['last_seen'] = time();
    if ($action === 'bootstrap' && $method === 'GET') reply(['installed'=>$installed,'user'=>$user ? publicUser($user) : null,'csrf'=>$_SESSION['csrf']]);
    if ($method !== 'POST' && !in_array($action,['state','download','preview','classwork_state','classwork_download','classwork_preview','editor_state','editor_file','bank_state','bank_file_download','bank_file_view','homework_detail','homework_file_download'],true)) fail('Используйте POST.',405);
    if ($action === 'login' || $action === 'setup') {
        $remember = $data['remember'] ?? false;
        if (!is_bool($remember)) fail('Некорректная настройка запоминания входа.');
        $ipKey = hash('sha256',$action.':'.($_SERVER['REMOTE_ADDR'] ?? 'local'));
        $attempt = run($db,'SELECT * FROM attempts WHERE key=?',[$ipKey])->fetch();
        if ($attempt && $attempt['until'] > time() && $attempt['count'] >= 10) fail('Слишком много попыток. Повторите через 15 минут.',429);
        run($db,'DELETE FROM attempts WHERE until < ?', [time()]);
        run($db,'INSERT INTO attempts(key,count,until) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',[$ipKey,time()+900]);
        $login = strtolower(textValue($data,'login',64,true));
        if (!preg_match('/^[a-z0-9._-]{3,64}$/D',$login)) fail('Логин: 3–64 латинских буквы, цифры, точки, дефисы или подчёркивания.');
        if ($action === 'setup') {
            if ($installed) fail('Первичная настройка уже выполнена.',409);
            $keyPath = $private.'/setup-key.txt';
            $key = is_file($keyPath) ? trim((string)file_get_contents($keyPath)) : '';
            if (strlen($key) < 24 || !hash_equals($key,textValue($data,'setup_key',200,true))) fail('Неверный ключ установки.',403);
            $name = textValue($data,'name',160,true);
            $hash = password_hash(passwordValue($data),PASSWORD_DEFAULT);
            $db->exec('BEGIN IMMEDIATE');
            if ($db->query("SELECT COUNT(*) FROM users WHERE role='admin'")->fetchColumn() > 0) { $db->exec('ROLLBACK'); fail('Настройка уже завершена.',409); }
            run($db,"INSERT INTO users(name,login,password_hash,role) VALUES(?,?,?,'admin')",[$name,$login,$hash]);
            $db->exec('COMMIT');
            @unlink($keyPath);
        }
        $user = run($db,'SELECT * FROM users WHERE login=?',[$login])->fetch();
        $password = $data['password'] ?? '';
        $ok = is_string($password) && strlen($password) <= 72 && password_verify($password,$user['password_hash'] ?? '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.');
        if (!$user || !$ok || !$user['active']) fail('Неверный логин или пароль.',401);
        run($db,'DELETE FROM attempts WHERE key=?',[$ipKey]);
        session_regenerate_id(true);
        $_SESSION['uid'] = $user['id']; $_SESSION['auth_version'] = $user['auth_version']; $_SESSION['last_seen'] = time();
        $_SESSION['csrf'] = bin2hex(random_bytes(24));
        clearRemember($db,$rememberCookie,$secure);
        if ($remember) issueRemember($db,$user,$rememberCookie,$rememberLifetime,$secure);
        reply(['user'=>publicUser($user),'csrf'=>$_SESSION['csrf']]);
    }
    if (!$user) fail('Войдите в свой кабинет.',401);
    if (in_array($action,['upload','download','preview','remove_attachment'],true)) {
        $attachment = null;
        if ($action !== 'upload') {
            $attachment = run($db,'SELECT * FROM attachments WHERE id=? AND deleted=0',[idValue(in_array($action,['download','preview'],true) ? $_GET : $data,'id')])->fetch();
            if (!$attachment) fail('Файл не найден.',404);
        }
        $taskId = $attachment ? (int)$attachment['task_id'] : idValue($data,'task_id');
        $task = $user['role'] === 'admin' ? run($db,'SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL',[$taskId])->fetch() : run($db,'SELECT * FROM tasks WHERE id=? AND student_id=? AND deleted_at IS NULL',[$taskId,$user['id']])->fetch();
        if (!$task) fail('Файл или задание не найдено.',404);
        $directory = $private.'/uploads';
        if ($action === 'download') {
            $path = $directory.'/'.$attachment['storage_name'];
            if (!is_file($path)) fail('Файл отсутствует на сервере. Обратитесь к преподавателю.',404);
            header('Content-Type: application/octet-stream');
            header("Content-Disposition: attachment; filename=download; filename*=UTF-8''".rawurlencode($attachment['name']));
            header('Content-Length: '.filesize($path));
            header('Content-Security-Policy: sandbox');
            session_write_close(); readfile($path); exit;
        }
        if($action==='preview'){
            $path=$directory.'/'.$attachment['storage_name'];$ext=strtolower(pathinfo($attachment['name'],PATHINFO_EXTENSION));
            $previewable=['txt','csv','md','py','js','ts','jsx','tsx','html','css','json','xml','yaml','yml','sql','java','c','cpp','h','hpp','cs','go','rs','php','sh','ini','toml'];
            if(!in_array($ext,$previewable,true))fail('Этот формат можно скачать, но нельзя открыть в просмотрщике.',415);
            if(!is_file($path))fail('Файл отсутствует на сервере. Обратитесь к преподавателю.',404);
            $size=filesize($path);if($size===false||$size>2*1024*1024)fail('Для просмотра файл должен быть не больше 2 МБ.',413);
            $content=file_get_contents($path);if($content===false||!preg_match('//u',$content))fail('Файл не является текстовым.',415);
            reply(['id'=>(int)$attachment['id'],'name'=>$attachment['name'],'path'=>$attachment['relative_path']?:$attachment['name'],'extension'=>$ext,'size'=>$size,'content'=>$content]);
        }
        $kind = $attachment ? $attachment['kind'] : textValue($data,'kind',20,true);
        if (!in_array($kind,['material','solution'],true)) fail('Некорректный тип файла.');
        if ($kind === 'material') requireAdmin($user);
        else if ($user['role'] !== 'student' || !in_array($task['status'],['assigned','revision'],true)) fail('Изменять файлы решения можно до отправки или при доработке.',403);
        if ($action === 'remove_attachment') {
            $changed = $kind === 'solution'
                ? run($db,"UPDATE attachments SET deleted=1 WHERE id=? AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND status IN ('assigned','revision'))",[$attachment['id'],$taskId])
                : run($db,'UPDATE attachments SET deleted=1 WHERE id=?',[$attachment['id']]);
            if (!$changed->rowCount()) fail('Работа уже отправлена. Обновите страницу.',409);
            reply(['ok'=>true]);
        }
        $file = $_FILES['file'] ?? null;
        if (!$file || !is_array($file) || is_array($file['error'] ?? null)) fail('Выберите файл. Если файл выбран, проверьте лимиты загрузки PHP на хостинге.',413);
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) fail('Файл не загружен. Проверьте размер файла и лимиты upload_max_filesize и post_max_size на хостинге.',413);
        $name = basename(str_replace('\\','/',(string)$file['name']));
        if ($name === '' || strlen($name)>240 || preg_match('/[\x00-\x1F\x7F]/',$name) || !preg_match('//u',$name)) fail('Слишком длинное или некорректное имя файла.');
        $ext = strtolower(pathinfo($name,PATHINFO_EXTENSION));
        $allowed=['xlsx','xls','csv','txt','md','py','js','ts','jsx','tsx','html','css','json','xml','yaml','yml','sql','java','c','cpp','h','hpp','cs','go','rs','php','sh','ini','toml'];
        if (!in_array($ext,$allowed,true)) fail('Этот тип файла не поддерживается.');
        $relative=textValue($data,'path',500);if($relative==='')$relative=$name;$relative=str_replace('\\','/',$relative);
        if(str_starts_with($relative,'/')||str_contains($relative,'//')||basename($relative)!==$name)fail('Некорректный путь файла.');
        foreach(explode('/',$relative) as $segment)if($segment===''||$segment==='.'||$segment==='..')fail('Некорректный путь файла.');
        $size = filesize($file['tmp_name']);
        if ($size === false || $size > 10*1024*1024) fail('Максимальный размер файла — 10 МБ.',413);
        if (!is_dir($directory) && !mkdir($directory,0700,true)) fail('Не удалось создать папку для файлов.',503);
        $storage = bin2hex(random_bytes(24)).'.bin'; $path = $directory.'/'.$storage;
        $db->exec('BEGIN IMMEDIATE');
        try {
            // Publishing the same path again updates that file instead of creating duplicates.
            if ($kind === 'material') run($db,'UPDATE attachments SET deleted=1 WHERE task_id=? AND kind=? AND relative_path=? AND deleted=0',[$taskId,$kind,$relative]);
            if ((int)run($db,'SELECT COUNT(*) FROM attachments WHERE task_id=? AND kind=? AND deleted=0',[$taskId,$kind])->fetchColumn() >= 20) {
                $db->exec('ROLLBACK'); fail('Не более 20 файлов одного типа на задание. Уберите лишние вложения.');
            }
            // Recheck after locking: a review can arrive while the upload is in progress.
            $current = run($db,'SELECT status FROM tasks WHERE id=?',[$taskId])->fetchColumn();
            if ($kind === 'solution' && !in_array($current,['assigned','revision'],true)) { $db->exec('ROLLBACK'); fail('Работа уже отправлена. Обновите страницу.',409); }
            if (!move_uploaded_file($file['tmp_name'],$path)) throw new RuntimeException('Cannot move uploaded file');
            chmod($path,0600);
            run($db,'INSERT INTO attachments(task_id,uploader_id,kind,name,storage_name,size,relative_path) VALUES(?,?,?,?,?,?,?)',[$taskId,$user['id'],$kind,$name,$storage,$size,$relative]);
            $id=(int)$db->lastInsertId(); $db->exec('COMMIT');
        } catch (Throwable $error) { $db->exec('ROLLBACK'); if (is_file($path)) unlink($path); throw $error; }
        reply(['id'=>$id,'name'=>$name,'path'=>$relative,'size'=>$size],201);
    }
    if (str_starts_with($action,'editor_')) {
        $editable=['','txt','csv','md','py','js','ts','jsx','tsx','html','css','json','xml','yaml','yml','sql','java','c','cpp','h','hpp','cs','go','rs','php','sh','ini','toml'];
        $editorSource=$method==='GET'?$_GET:$data;
        $studentId=$user['role']==='admin'?(isset($editorSource['student_id'])?idValue($editorSource,'student_id'):0):(int)$user['id'];
        if($user['role']==='admin'&&$studentId===0&&$action==='editor_state')$studentId=(int)($db->query("SELECT id FROM users WHERE role='student' AND active=1 AND deleted_at IS NULL ORDER BY name LIMIT 1")->fetchColumn()?:0);
        if($studentId&&!run($db,"SELECT id FROM users WHERE id=? AND role='student' AND active=1 AND deleted_at IS NULL",[$studentId])->fetch())fail('Активный ученик не найден.',404);
        $directory=$private.'/classwork_uploads';
        if($action==='editor_state'){
            $students=$user['role']==='admin'?$db->query("SELECT id,name,login,active FROM users WHERE role='student' AND deleted_at IS NULL ORDER BY active DESC,name")->fetchAll():[];
            $files=$studentId?run($db,'SELECT id,student_id,name,relative_path,size,revision,updated_at,created_at FROM classwork_files WHERE student_id=? AND deleted=0 ORDER BY relative_path',[$studentId])->fetchAll():[];
            run($db,'DELETE FROM editor_presence WHERE last_seen < ?',[time()-45]);
            $presence=$studentId?run($db,"SELECT p.user_id,p.file_id,p.cursor_start,p.cursor_end,p.last_seen,u.name,u.role FROM editor_presence p JOIN users u ON u.id=p.user_id WHERE p.student_id=? AND p.last_seen>=? ORDER BY u.role,u.name",[$studentId,time()-45])->fetchAll():[];
            reply(['user'=>publicUser($user),'students'=>$students,'student_id'=>$studentId,'files'=>$files,'presence'=>$presence,'csrf'=>$_SESSION['csrf']]);
        }
        if(!$studentId)fail('Сначала выберите ученика.',400);
        if($action==='editor_file'){
            $record=run($db,'SELECT * FROM classwork_files WHERE id=? AND student_id=? AND deleted=0',[idValue($_GET,'id'),$studentId])->fetch();
            if(!$record)fail('Файл не найден.',404);$ext=strtolower(pathinfo($record['name'],PATHINFO_EXTENSION));if(!in_array($ext,$editable,true))fail('Этот файл нельзя редактировать в браузере.',415);
            $path=$directory.'/'.$record['storage_name'];if(!is_file($path))fail('Файл отсутствует на сервере.',404);$size=filesize($path);if($size===false||$size>200000)fail('В редакторе можно открыть текстовый файл не больше 200 КБ.',413);$content=file_get_contents($path);if($content===false||!preg_match('//u',$content))fail('Файл не является текстовым.',415);
            reply(['id'=>(int)$record['id'],'student_id'=>(int)$record['student_id'],'name'=>$record['name'],'path'=>$record['relative_path'],'content'=>$content,'revision'=>(int)$record['revision'],'updated_at'=>$record['updated_at']]);
        }
        if($action==='editor_presence'){
            $fileId=isset($data['file_id'])&&$data['file_id']!==null?(int)$data['file_id']:null;if($fileId!==null&&$fileId<1)fail('Некорректный файл.');
            if($fileId&&!run($db,'SELECT id FROM classwork_files WHERE id=? AND student_id=? AND deleted=0',[$fileId,$studentId])->fetch())fail('Файл не найден.',404);
            $cursorStart=max(0,min(200000,(int)($data['cursor_start']??0)));$cursorEnd=max($cursorStart,min(200000,(int)($data['cursor_end']??$cursorStart)));
            run($db,'INSERT INTO editor_presence(student_id,user_id,file_id,cursor_start,cursor_end,last_seen) VALUES(?,?,?,?,?,?) ON CONFLICT(student_id,user_id) DO UPDATE SET file_id=excluded.file_id,cursor_start=excluded.cursor_start,cursor_end=excluded.cursor_end,last_seen=excluded.last_seen',[$studentId,$user['id'],$fileId,$cursorStart,$cursorEnd,time()]);
            run($db,'DELETE FROM editor_presence WHERE last_seen < ?',[time()-45]);
            $presence=run($db,"SELECT p.user_id,p.file_id,p.cursor_start,p.cursor_end,p.last_seen,u.name,u.role FROM editor_presence p JOIN users u ON u.id=p.user_id WHERE p.student_id=? AND p.last_seen>=? ORDER BY u.role,u.name",[$studentId,time()-45])->fetchAll();
            reply(['presence'=>$presence]);
        }
        if($action==='editor_create'){
            $relative=textValue($data,'path',500,true);$relative=str_replace('\\','/',$relative);if(str_starts_with($relative,'/')||str_contains($relative,'//'))fail('Некорректный путь файла.');foreach(explode('/',$relative) as $segment)if($segment===''||$segment==='.'||$segment==='..'||preg_match('/[\x00-\x1F\x7F]/',$segment))fail('Некорректный путь файла.');
            $name=basename($relative);$ext=strtolower(pathinfo($name,PATHINFO_EXTENSION));if(!in_array($ext,$editable,true))fail('Создай текстовый файл, например main.py или notes.txt.');
            if(run($db,'SELECT id FROM classwork_files WHERE student_id=? AND relative_path=? AND deleted=0',[$studentId,$relative])->fetch())fail('Файл с таким именем уже существует.',409);
            if((int)run($db,'SELECT COUNT(*) FROM classwork_files WHERE student_id=? AND deleted=0',[$studentId])->fetchColumn()>=200)fail('В папке ученика может быть не больше 200 файлов.');
            if(!is_dir($directory)&&!mkdir($directory,0700,true))fail('Не удалось создать папку для файлов.',503);$storage=bin2hex(random_bytes(24)).'.bin';$path=$directory.'/'.$storage;if(file_put_contents($path,'',LOCK_EX)===false)fail('Не удалось создать файл.',503);chmod($path,0600);
            try{run($db,"INSERT INTO classwork_files(student_id,uploader_id,name,relative_path,storage_name,size,revision,updated_at) VALUES(?,?,?,?,?,0,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))",[$studentId,$user['id'],$name,$relative,$storage]);$id=(int)$db->lastInsertId();}catch(Throwable $error){@unlink($path);throw $error;}
            reply(['id'=>$id,'name'=>$name,'path'=>$relative,'size'=>0,'revision'=>1],201);
        }
        if($action==='editor_save'){
            $id=idValue($data,'id');$content=$data['content']??null;if(!is_string($content)||strlen($content)>200000||!preg_match('//u',$content))fail('Код должен быть текстом не больше 200 КБ.');$expected=filter_var($data['revision']??null,FILTER_VALIDATE_INT);if($expected===false||$expected<1)fail('Некорректная версия файла.');
            $db->exec('BEGIN IMMEDIATE');try{$record=run($db,'SELECT * FROM classwork_files WHERE id=? AND student_id=? AND deleted=0',[$id,$studentId])->fetch();if(!$record){$db->exec('ROLLBACK');fail('Файл не найден.',404);}if((int)$record['revision']!==(int)$expected){$path=$directory.'/'.$record['storage_name'];$current=is_file($path)?file_get_contents($path):false;$db->exec('ROLLBACK');if($current===false)fail('Файл отсутствует на сервере.',404);reply(['error'=>'Файл уже изменён другим участником.','content'=>$current,'revision'=>(int)$record['revision'],'updated_at'=>$record['updated_at']],409);}
                $ext=strtolower(pathinfo($record['name'],PATHINFO_EXTENSION));if(!in_array($ext,$editable,true)){$db->exec('ROLLBACK');fail('Этот файл нельзя редактировать в браузере.',415);}if(!is_dir($directory)){$db->exec('ROLLBACK');fail('Папка файлов недоступна.',503);}$path=$directory.'/'.$record['storage_name'];$temp=tempnam($directory,'edit-');if($temp===false||file_put_contents($temp,$content,LOCK_EX)===false){if($temp)@unlink($temp);$db->exec('ROLLBACK');fail('Не удалось сохранить файл.',503);}chmod($temp,0600);if(!rename($temp,$path)){@unlink($temp);$db->exec('ROLLBACK');fail('Не удалось заменить файл.',503);}run($db,"UPDATE classwork_files SET uploader_id=?,size=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",[$user['id'],strlen($content),$id]);$revision=(int)$expected+1;$db->exec('COMMIT');
            }catch(Throwable $error){if($db->inTransaction())$db->exec('ROLLBACK');throw $error;}
            reply(['ok'=>true,'revision'=>$revision,'size'=>strlen($content),'updated_at'=>gmdate('Y-m-d\TH:i:s\Z')]);
        }
        fail('Неизвестное действие.',404);
    }
    if (str_starts_with($action,'classwork_')) {
        $previewable=['','txt','csv','md','py','js','ts','jsx','tsx','html','css','json','xml','yaml','yml','sql','java','c','cpp','h','hpp','cs','go','rs','php','sh','ini','toml'];
        $allowed=array_merge($previewable,['xlsx','xls']);
        if($action==='classwork_state'){
            if($user['role']==='admin'){
                $students=$db->query("SELECT id,name,login,active FROM users WHERE role='student' AND deleted_at IS NULL ORDER BY active DESC,name")->fetchAll();
                $studentId=isset($_GET['student_id'])&&$_GET['student_id']!==''?idValue($_GET,'student_id'):(int)($students[0]['id']??0);
                if($studentId&&!run($db,"SELECT id FROM users WHERE id=? AND role='student' AND deleted_at IS NULL",[$studentId])->fetch())fail('Ученик не найден.',404);
            }else{$students=[];$studentId=(int)$user['id'];}
            $files=$studentId?run($db,'SELECT id,student_id,name,relative_path,size,revision,updated_at,created_at FROM classwork_files WHERE student_id=? AND deleted=0 ORDER BY relative_path',[$studentId])->fetchAll():[];
            reply(['user'=>publicUser($user),'students'=>$students,'student_id'=>$studentId,'files'=>$files]);
        }
        $fileRecord=null;
        if(in_array($action,['classwork_download','classwork_preview','classwork_remove'],true)){
            $source=in_array($action,['classwork_download','classwork_preview'],true)?$_GET:$data;
            $fileRecord=run($db,'SELECT * FROM classwork_files WHERE id=? AND deleted=0',[idValue($source,'id')])->fetch();
            if(!$fileRecord||($user['role']!=='admin'&&(int)$fileRecord['student_id']!==(int)$user['id']))fail('Файл не найден.',404);
        }
        $directory=$private.'/classwork_uploads';
        if($action==='classwork_download'){
            $path=$directory.'/'.$fileRecord['storage_name'];if(!is_file($path))fail('Файл отсутствует на сервере.',404);
            header('Content-Type: application/octet-stream');header("Content-Disposition: attachment; filename=download; filename*=UTF-8''".rawurlencode($fileRecord['name']));header('Content-Length: '.filesize($path));header('Content-Security-Policy: sandbox');session_write_close();readfile($path);exit;
        }
        if($action==='classwork_preview'){
            $ext=strtolower(pathinfo($fileRecord['name'],PATHINFO_EXTENSION));if(!in_array($ext,$previewable,true))fail('Этот формат можно скачать, но нельзя открыть в просмотрщике.',415);
            $path=$directory.'/'.$fileRecord['storage_name'];if(!is_file($path))fail('Файл отсутствует на сервере.',404);$size=filesize($path);if($size===false||$size>2*1024*1024)fail('Для просмотра файл должен быть не больше 2 МБ.',413);$content=file_get_contents($path);if($content===false||!preg_match('//u',$content))fail('Файл не является текстовым.',415);
            reply(['id'=>(int)$fileRecord['id'],'name'=>$fileRecord['name'],'path'=>$fileRecord['relative_path'],'extension'=>$ext,'size'=>$size,'content'=>$content]);
        }
        requireAdmin($user);
        if($action==='classwork_remove'){run($db,'UPDATE classwork_files SET deleted=1 WHERE id=?',[$fileRecord['id']]);reply(['ok'=>true]);}
        $studentId=idValue($data,'student_id');
        if(!run($db,"SELECT id FROM users WHERE id=? AND role='student' AND active=1 AND deleted_at IS NULL",[$studentId])->fetch())fail('Активный ученик не найден.',404);
        if($action==='classwork_sync'){
            $paths=$data['paths']??null;if(!is_array($paths)||count($paths)>200)fail('Некорректный список файлов.');$clean=[];
            foreach($paths as $relative){if(!is_string($relative)||strlen($relative)>500)fail('Некорректный путь файла.');$relative=str_replace('\\','/',$relative);if($relative===''||str_starts_with($relative,'/')||str_contains($relative,'//'))fail('Некорректный путь файла.');foreach(explode('/',$relative) as $segment)if($segment===''||$segment==='.'||$segment==='..')fail('Некорректный путь файла.');$clean[]=$relative;}
            if($clean){$marks=implode(',',array_fill(0,count($clean),'?'));run($db,"UPDATE classwork_files SET deleted=1 WHERE student_id=? AND deleted=0 AND relative_path NOT IN ($marks)",array_merge([$studentId],$clean));}else run($db,'UPDATE classwork_files SET deleted=1 WHERE student_id=? AND deleted=0',[$studentId]);
            reply(['ok'=>true,'count'=>count($clean)]);
        }
        if($action==='classwork_upload'){
            $file=$_FILES['file']??null;if(!$file||!is_array($file)||is_array($file['error']??null)||($file['error']??UPLOAD_ERR_NO_FILE)!==UPLOAD_ERR_OK)fail('Файл не загружен. Проверьте размер файла.',413);
            $name=basename(str_replace('\\','/',(string)$file['name']));if($name===''||strlen($name)>240||preg_match('/[\x00-\x1F\x7F]/',$name)||!preg_match('//u',$name))fail('Некорректное имя файла.');$ext=strtolower(pathinfo($name,PATHINFO_EXTENSION));if(!in_array($ext,$allowed,true))fail('Этот тип файла не поддерживается.');
            $relative=textValue($data,'path',500,true);$relative=str_replace('\\','/',$relative);if(str_starts_with($relative,'/')||str_contains($relative,'//')||basename($relative)!==$name)fail('Некорректный путь файла.');foreach(explode('/',$relative) as $segment)if($segment===''||$segment==='.'||$segment==='..')fail('Некорректный путь файла.');
            $size=filesize($file['tmp_name']);if($size===false||$size>10*1024*1024)fail('Максимальный размер файла — 10 МБ.',413);if(!is_dir($directory)&&!mkdir($directory,0700,true))fail('Не удалось создать папку для файлов.',503);$storage=bin2hex(random_bytes(24)).'.bin';$path=$directory.'/'.$storage;
            $db->exec('BEGIN IMMEDIATE');try{run($db,'UPDATE classwork_files SET deleted=1 WHERE student_id=? AND relative_path=? AND deleted=0',[$studentId,$relative]);if((int)run($db,'SELECT COUNT(*) FROM classwork_files WHERE student_id=? AND deleted=0',[$studentId])->fetchColumn()>=200){$db->exec('ROLLBACK');fail('В папке ученика может быть не больше 200 файлов.');}if(!move_uploaded_file($file['tmp_name'],$path))throw new RuntimeException('Cannot move uploaded file');chmod($path,0600);run($db,'INSERT INTO classwork_files(student_id,uploader_id,name,relative_path,storage_name,size) VALUES(?,?,?,?,?,?)',[$studentId,$user['id'],$name,$relative,$storage,$size]);$id=(int)$db->lastInsertId();$db->exec('COMMIT');}catch(Throwable $error){$db->exec('ROLLBACK');if(is_file($path))unlink($path);throw $error;}
            reply(['id'=>$id,'name'=>$name,'path'=>$relative,'size'=>$size],201);
        }
        fail('Неизвестное действие.',404);
    }
    if ($action === 'bank_state') {
        if ($user['role'] === 'admin') {
            $items = run($db,'SELECT id,title,subject,topic,exam_number,difficulty,prompt,correct_answer,explanation,default_score,created_at,updated_at FROM question_bank WHERE teacher_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC',[$user['id']])->fetchAll();
        } else {
            $items = $db->query("SELECT q.id,q.title,q.subject,q.topic,q.exam_number,q.difficulty,q.prompt,q.correct_answer,q.explanation,q.default_score,q.created_at,q.updated_at,u.name AS teacher_name FROM question_bank q JOIN users u ON u.id=q.teacher_id WHERE q.deleted_at IS NULL AND u.active=1 AND u.deleted_at IS NULL ORDER BY q.updated_at DESC,q.id DESC")->fetchAll();
        }
        $itemIds=array_map(static fn($item)=>(int)$item['id'],$items);$byItem=[];
        if($itemIds){$marks=implode(',',array_fill(0,count($itemIds),'?'));$files=run($db,"SELECT id,bank_item_id,name,size,mime,created_at FROM question_bank_files WHERE deleted=0 AND bank_item_id IN ($marks) ORDER BY id",$itemIds)->fetchAll();foreach($files as $file)$byItem[$file['bank_item_id']][]=$file;}
        foreach($items as &$item)$item['files']=$byItem[$item['id']]??[];unset($item);
        reply(['user'=>publicUser($user),'items'=>$items,'csrf'=>$_SESSION['csrf']]);
    }
    if (in_array($action,['bank_file_upload','bank_file_delete','bank_file_download','bank_file_view'],true)) {
        $source=in_array($action,['bank_file_download','bank_file_view'],true)?$_GET:$data;
        if(in_array($action,['bank_file_download','bank_file_view'],true)){
            $fileId=idValue($source,'id');$record=run($db,'SELECT f.*,q.teacher_id,q.deleted_at AS bank_deleted,u.active AS teacher_active,u.deleted_at AS teacher_deleted FROM question_bank_files f JOIN question_bank q ON q.id=f.bank_item_id JOIN users u ON u.id=q.teacher_id WHERE f.id=? AND f.deleted=0',[$fileId])->fetch();
            if(!$record)fail('Файл не найден.',404);
            if($user['role']==='admin'){$visible=(int)$record['teacher_id']===(int)$user['id'];}else{$visible=($record['bank_deleted']===null&&(int)$record['teacher_active']&&$record['teacher_deleted']===null)||(bool)run($db,'SELECT 1 FROM homework_questions q JOIN homeworks h ON h.id=q.homework_id WHERE q.bank_item_id=? AND h.student_id=? AND h.deleted_at IS NULL LIMIT 1',[$record['bank_item_id'],$user['id']])->fetchColumn();}
            if(!$visible)fail('Файл не найден.',404);
            $path=$private.'/bank_uploads/'.$record['storage_name'];if(!is_file($path))fail('Файл отсутствует на сервере.',404);
            if($action==='bank_file_view'){
                $imageTypes=['image/png','image/jpeg','image/gif','image/webp'];if(!in_array($record['mime'],$imageTypes,true))fail('Этот файл нельзя показать как изображение.',415);
                header('Content-Type: '.$record['mime']);header('Content-Disposition: inline');
            }else{header('Content-Type: application/octet-stream');header("Content-Disposition: attachment; filename=download; filename*=UTF-8''".rawurlencode($record['name']));}
            header('Content-Length: '.filesize($path));header('Content-Security-Policy: sandbox');session_write_close();readfile($path);exit;
        }
        requireAdmin($user);$itemId=idValue($data,'bank_item_id');$item=run($db,'SELECT id FROM question_bank WHERE id=? AND teacher_id=? AND deleted_at IS NULL',[$itemId,$user['id']])->fetch();if(!$item)fail('Задание банка не найдено.',404);
        if($action==='bank_file_delete'){$fileId=idValue($data,'id');$changed=run($db,'UPDATE question_bank_files SET deleted=1 WHERE id=? AND bank_item_id=? AND deleted=0',[$fileId,$itemId]);if(!$changed->rowCount())fail('Файл не найден.',404);reply(['ok'=>true]);}
        $file=$_FILES['file']??null;if(!$file||!is_array($file)||is_array($file['error']??null)||($file['error']??UPLOAD_ERR_NO_FILE)!==UPLOAD_ERR_OK)fail('Файл не загружен.',413);
        $name=basename(str_replace('\\','/',(string)$file['name']));if($name===''||strlen($name)>240||preg_match('/[\x00-\x1F\x7F]/',$name)||!preg_match('//u',$name))fail('Некорректное имя файла.');
        $ext=strtolower(pathinfo($name,PATHINFO_EXTENSION));$types=['png'=>'image/png','jpg'=>'image/jpeg','jpeg'=>'image/jpeg','gif'=>'image/gif','webp'=>'image/webp','txt'=>'text/plain','md'=>'text/markdown','py'=>'text/x-python','csv'=>'text/csv','xlsx'=>'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','xls'=>'application/vnd.ms-excel'];if(!isset($types[$ext]))fail('Можно загрузить изображение, TXT, MD, CSV, Python или Excel.');
        $size=filesize($file['tmp_name']);if($size===false||$size>10*1024*1024)fail('Максимальный размер файла — 10 МБ.',413);if((int)run($db,'SELECT COUNT(*) FROM question_bank_files WHERE bank_item_id=? AND deleted=0',[$itemId])->fetchColumn()>=8)fail('К заданию можно прикрепить не больше 8 файлов.');
        $directory=$private.'/bank_uploads';if(!is_dir($directory)&&!mkdir($directory,0700,true))fail('Не удалось создать папку для файлов.',503);$storage=bin2hex(random_bytes(24)).'.bin';$path=$directory.'/'.$storage;if(!move_uploaded_file($file['tmp_name'],$path))fail('Не удалось сохранить файл.',500);chmod($path,0600);run($db,'INSERT INTO question_bank_files(bank_item_id,uploader_id,name,storage_name,size,mime) VALUES(?,?,?,?,?,?)',[$itemId,$user['id'],$name,$storage,$size,$types[$ext]]);reply(['id'=>(int)$db->lastInsertId(),'name'=>$name,'size'=>$size,'mime'=>$types[$ext]],201);
    }
    if ($action === 'bank_save') {
        requireAdmin($user);
        $title=textValue($data,'title',250,true);$subject=textValue($data,'subject',100,true);$topic=textValue($data,'topic',100);
        $examNumber=filter_var($data['exam_number']??null,FILTER_VALIDATE_INT);if($examNumber===false||$examNumber<1||$examNumber>27)fail('Выберите номер задания от 1 до 27.');
        $difficulty=textValue($data,'difficulty',20,true);if(!in_array($difficulty,['easy','medium','hard'],true))fail('Некорректная сложность.');
        $prompt=textValue($data,'prompt',30000,true);$answer=textValue($data,'correct_answer',5000,true);$explanation=textValue($data,'explanation',15000);
        $score=filter_var($data['default_score']??null,FILTER_VALIDATE_INT);if($score===false||$score<1||$score>1000)fail('Балл должен быть от 1 до 1000.');
        if(!empty($data['id'])){
            $id=idValue($data,'id');
            $changed=run($db,"UPDATE question_bank SET title=?,subject=?,topic=?,exam_number=?,difficulty=?,prompt=?,correct_answer=?,explanation=?,default_score=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND teacher_id=? AND deleted_at IS NULL",[$title,$subject,$topic,$examNumber,$difficulty,$prompt,$answer,$explanation,$score,$id,$user['id']]);
            if(!$changed->rowCount())fail('Задание банка не найдено.',404);
        }else{
            run($db,'INSERT INTO question_bank(teacher_id,title,subject,topic,exam_number,difficulty,prompt,correct_answer,explanation,default_score) VALUES(?,?,?,?,?,?,?,?,?,?)',[$user['id'],$title,$subject,$topic,$examNumber,$difficulty,$prompt,$answer,$explanation,$score]);
            $id=(int)$db->lastInsertId();
        }
        reply(['id'=>$id]);
    }
    if ($action === 'bank_delete') {
        requireAdmin($user);$id=idValue($data,'id');
        $changed=run($db,"UPDATE question_bank SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND teacher_id=? AND deleted_at IS NULL",[$id,$user['id']]);
        if(!$changed->rowCount())fail('Задание банка не найдено.',404);reply(['ok'=>true]);
    }
    if ($action === 'homework_create') {
        requireAdmin($user);
        $title=textValue($data,'title',250,true);$subject=textValue($data,'subject',100,true);$description=textValue($data,'description',10000);$due=validDate(textValue($data,'due_date',10));
        $rawStudents=$data['student_ids']??null;if(!is_array($rawStudents)||!$rawStudents||count($rawStudents)>200)fail('Выберите от 1 до 200 учеников.');
        $studentIds=[];foreach($rawStudents as $raw){$id=filter_var($raw,FILTER_VALIDATE_INT);if($id===false||$id<1)fail('Некорректный ученик.');$studentIds[]=(int)$id;}$studentIds=array_values(array_unique($studentIds));
        $marks=implode(',',array_fill(0,count($studentIds),'?'));$found=run($db,"SELECT id FROM users WHERE id IN ($marks) AND role='student' AND active=1 AND deleted_at IS NULL",$studentIds)->fetchAll();if(count($found)!==count($studentIds))fail('Один из учеников не найден или его доступ приостановлен.',404);
        $rawQuestions=$data['questions']??null;if(!is_array($rawQuestions)||!$rawQuestions||count($rawQuestions)>30)fail('В домашней работе должно быть от 1 до 30 заданий.');
        $questions=[];$total=0;
        foreach($rawQuestions as $index=>$raw){
            if(!is_array($raw))fail('Некорректное задание.');
            $bankId=isset($raw['bank_item_id'])&&$raw['bank_item_id']!==''?filter_var($raw['bank_item_id'],FILTER_VALIDATE_INT):null;
            if($bankId){$item=run($db,'SELECT * FROM question_bank WHERE id=? AND teacher_id=? AND deleted_at IS NULL',[(int)$bankId,$user['id']])->fetch();if(!$item)fail('Одно из заданий банка больше недоступно.',404);$q=['bank_item_id'=>(int)$item['id'],'title'=>$item['title'],'prompt'=>$item['prompt'],'correct_answer'=>$item['correct_answer'],'explanation'=>$item['explanation'],'max_score'=>(int)$item['default_score']];}
            else{$q=['bank_item_id'=>null,'title'=>textValue($raw,'title',250,true),'prompt'=>textValue($raw,'prompt',30000,true),'correct_answer'=>textValue($raw,'correct_answer',5000,true),'explanation'=>textValue($raw,'explanation',15000)];$q['max_score']=filter_var($raw['max_score']??null,FILTER_VALIDATE_INT);if($q['max_score']===false||$q['max_score']<1||$q['max_score']>1000)fail('Проверьте баллы у заданий.');}
            $q['position']=$index+1;$total+=(int)$q['max_score'];$questions[]=$q;
        }
        if($total>10000)fail('Суммарный балл слишком большой.');
        $groupId=count($studentIds)>1?bin2hex(random_bytes(12)):null;$ids=[];$db->exec('BEGIN IMMEDIATE');
        try{foreach($studentIds as $studentId){run($db,'INSERT INTO homeworks(student_id,created_by,group_id,title,subject,description,due_date,max_score) VALUES(?,?,?,?,?,?,?,?)',[$studentId,$user['id'],$groupId,$title,$subject,$description,$due,$total]);$homeworkId=(int)$db->lastInsertId();$ids[]=$homeworkId;foreach($questions as $q)run($db,'INSERT INTO homework_questions(homework_id,bank_item_id,position,title,prompt,correct_answer,explanation,max_score) VALUES(?,?,?,?,?,?,?,?)',[$homeworkId,$q['bank_item_id'],$q['position'],$q['title'],$q['prompt'],$q['correct_answer'],$q['explanation'],$q['max_score']]);}$db->exec('COMMIT');}catch(Throwable $error){$db->exec('ROLLBACK');throw $error;}
        reply(['id'=>$ids[0],'ids'=>$ids,'count'=>count($ids),'group_id'=>$groupId],201);
    }
    if ($action === 'homework_detail') {
        $id=idValue($_GET,'id');
        $homework=$user['role']==='admin'?run($db,'SELECT h.*,u.name AS student_name FROM homeworks h JOIN users u ON u.id=h.student_id WHERE h.id=? AND h.deleted_at IS NULL',[$id])->fetch():run($db,'SELECT h.*,u.name AS student_name FROM homeworks h JOIN users u ON u.id=h.student_id WHERE h.id=? AND h.student_id=? AND h.deleted_at IS NULL',[$id,$user['id']])->fetch();
        if(!$homework)fail('Домашняя работа не найдена.',404);
        $questions=run($db,'SELECT * FROM homework_questions WHERE homework_id=? ORDER BY position',[$id])->fetchAll();
        $files=run($db,'SELECT f.id,f.question_id,f.name,f.size,f.created_at FROM homework_files f JOIN homework_questions q ON q.id=f.question_id WHERE q.homework_id=? AND f.deleted=0 ORDER BY f.id',[$id])->fetchAll();$byQuestion=[];foreach($files as $file)$byQuestion[$file['question_id']][]=$file;
        $bankIds=array_values(array_unique(array_filter(array_map(static fn($question)=>isset($question['bank_item_id'])?(int)$question['bank_item_id']:0,$questions))));$materialsByBank=[];
        if($bankIds){$marks=implode(',',array_fill(0,count($bankIds),'?'));$materials=run($db,"SELECT id,bank_item_id,name,size,mime FROM question_bank_files WHERE deleted=0 AND bank_item_id IN ($marks) ORDER BY id",$bankIds)->fetchAll();foreach($materials as $material)$materialsByBank[$material['bank_item_id']][]=$material;}
        foreach($questions as &$question){$question['files']=$byQuestion[$question['id']]??[];$question['materials']=$materialsByBank[$question['bank_item_id']]??[];if($user['role']!=='admin'&&$homework['status']!=='done'){unset($question['correct_answer'],$question['explanation']);}}unset($question);
        reply(['user'=>publicUser($user),'homework'=>$homework,'questions'=>$questions,'csrf'=>$_SESSION['csrf']]);
    }
    if ($action === 'homework_save_progress') {
        if($user['role']!=='student')fail('Ответы сохраняет ученик.',403);$id=idValue($data,'id');
        $homework=run($db,"SELECT * FROM homeworks WHERE id=? AND student_id=? AND deleted_at IS NULL",[$id,$user['id']])->fetch();if(!$homework)fail('Домашняя работа не найдена.',404);if(!in_array($homework['status'],['assigned','revision'],true))fail('Работа уже отправлена.',409);
        $answers=$data['answers']??null;if(!is_array($answers)||count($answers)>30)fail('Некорректные ответы.');$db->exec('BEGIN IMMEDIATE');
        try{foreach($answers as $answer){if(!is_array($answer))fail('Некорректный ответ.');$questionId=filter_var($answer['id']??null,FILTER_VALIDATE_INT);if($questionId===false)fail('Некорректное задание.');$text=textValue($answer,'answer_text',10000);$code=textValue($answer,'code_text',30000);$changed=run($db,'UPDATE homework_questions SET answer_text=?,code_text=?,auto_correct=NULL WHERE id=? AND homework_id=?',[$text,$code,$questionId,$id]);if(!$changed->rowCount())fail('Задание не найдено.',404);}run($db,"UPDATE homeworks SET updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",[$id]);$db->exec('COMMIT');}catch(Throwable $error){$db->exec('ROLLBACK');throw $error;}reply(['ok'=>true]);
    }
    if ($action === 'homework_submit') {
        if($user['role']!=='student')fail('Работу отправляет ученик.',403);$id=idValue($data,'id');$homework=run($db,'SELECT * FROM homeworks WHERE id=? AND student_id=? AND deleted_at IS NULL',[$id,$user['id']])->fetch();if(!$homework)fail('Домашняя работа не найдена.',404);if(!in_array($homework['status'],['assigned','revision'],true))fail('Работа уже отправлена.',409);
        $questions=run($db,'SELECT * FROM homework_questions WHERE homework_id=?',[$id])->fetchAll();$responded=0;$db->exec('BEGIN IMMEDIATE');try{foreach($questions as $q){$hasFile=(int)run($db,'SELECT COUNT(*) FROM homework_files WHERE question_id=? AND deleted=0',[$q['id']])->fetchColumn()>0;if(trim($q['answer_text'])!==''||trim($q['code_text'])!==''||$hasFile)$responded++;$auto=trim($q['answer_text'])===''?null:(normalizedAnswer($q['answer_text'])===normalizedAnswer($q['correct_answer'])?1:0);run($db,'UPDATE homework_questions SET auto_correct=? WHERE id=?',[$auto,$q['id']]);}if(!$responded){$db->exec('ROLLBACK');fail('Добавьте хотя бы один ответ, код или файл.');}run($db,"UPDATE homeworks SET status='submitted',submitted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),completed_at=NULL,score=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",[$id]);$db->exec('COMMIT');}catch(Throwable $error){if($db->inTransaction())$db->exec('ROLLBACK');throw $error;}reply(['ok'=>true,'answered'=>$responded,'total'=>count($questions)]);
    }
    if ($action === 'homework_review') {
        requireAdmin($user);$id=idValue($data,'id');$homework=run($db,'SELECT * FROM homeworks WHERE id=? AND deleted_at IS NULL',[$id])->fetch();if(!$homework)fail('Домашняя работа не найдена.',404);$status=textValue($data,'status',20,true);if(!in_array($status,['done','revision'],true))fail('Некорректный результат проверки.');$feedback=textValue($data,'feedback',20000);if($status==='revision'&&$feedback==='')fail('Напишите, что нужно исправить.');$reviews=$data['questions']??[];if(!is_array($reviews)||count($reviews)>30)fail('Некорректные результаты.');
        $db->exec('BEGIN IMMEDIATE');try{foreach($reviews as $review){if(!is_array($review))fail('Некорректный результат.');$questionId=filter_var($review['id']??null,FILTER_VALIDATE_INT);$question=run($db,'SELECT max_score FROM homework_questions WHERE id=? AND homework_id=?',[$questionId,$id])->fetch();if(!$question)fail('Задание не найдено.',404);$score=$review['awarded_score']??null;if($score==='')$score=null;if($score!==null&&(filter_var($score,FILTER_VALIDATE_INT)===false||(int)$score<0||(int)$score>(int)$question['max_score']))fail('Проверьте выставленные баллы.');$comment=textValue($review,'teacher_feedback',10000);run($db,'UPDATE homework_questions SET awarded_score=?,teacher_feedback=? WHERE id=?',[$status==='revision'?null:$score,$comment,$questionId]);}$total=$status==='done'?(int)run($db,'SELECT COALESCE(SUM(awarded_score),0) FROM homework_questions WHERE homework_id=?',[$id])->fetchColumn():null;run($db,"UPDATE homeworks SET status=?,feedback=?,score=?,completed_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",[$status,$feedback,$total,$status==='done'?gmdate('Y-m-d\\TH:i:s\\Z'):null,$id]);$db->exec('COMMIT');}catch(Throwable $error){$db->exec('ROLLBACK');throw $error;}reply(['ok'=>true]);
    }
    if ($action === 'homework_delete') {
        requireAdmin($user);$id=idValue($data,'id');$homework=run($db,'SELECT group_id FROM homeworks WHERE id=? AND deleted_at IS NULL',[$id])->fetch();if(!$homework)fail('Домашняя работа не найдена.',404);$group=($data['scope']??'')==='group'&&!empty($homework['group_id']);$changed=$group?run($db,"UPDATE homeworks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE group_id=? AND deleted_at IS NULL",[$homework['group_id']]):run($db,"UPDATE homeworks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND deleted_at IS NULL",[$id]);reply(['ok'=>true,'count'=>$changed->rowCount()]);
    }
    if (in_array($action,['homework_file_upload','homework_file_remove','homework_file_download'],true)) {
        $source=$action==='homework_file_download'?$_GET:$data;$questionId=idValue($source,'question_id');$question=run($db,'SELECT q.*,h.student_id,h.status,h.deleted_at FROM homework_questions q JOIN homeworks h ON h.id=q.homework_id WHERE q.id=?',[$questionId])->fetch();if(!$question||$question['deleted_at']!==null||($user['role']!=='admin'&&(int)$question['student_id']!==(int)$user['id']))fail('Файл не найден.',404);$directory=$private.'/homework_uploads';
        if($action==='homework_file_download'){$fileId=idValue($_GET,'id');$file=run($db,'SELECT * FROM homework_files WHERE id=? AND question_id=? AND deleted=0',[$fileId,$questionId])->fetch();if(!$file)fail('Файл не найден.',404);$path=$directory.'/'.$file['storage_name'];if(!is_file($path))fail('Файл отсутствует на сервере.',404);header('Content-Type: application/octet-stream');header("Content-Disposition: attachment; filename=download; filename*=UTF-8''".rawurlencode($file['name']));header('Content-Length: '.filesize($path));header('Content-Security-Policy: sandbox');session_write_close();readfile($path);exit;}
        if($user['role']!=='student'||!in_array($question['status'],['assigned','revision'],true))fail('Файлы можно менять до отправки работы.',403);
        if($action==='homework_file_remove'){$fileId=idValue($data,'id');$changed=run($db,'UPDATE homework_files SET deleted=1 WHERE id=? AND question_id=? AND deleted=0',[$fileId,$questionId]);if(!$changed->rowCount())fail('Файл не найден.',404);reply(['ok'=>true]);}
        $file=$_FILES['file']??null;if(!$file||!is_array($file)||is_array($file['error']??null)||($file['error']??UPLOAD_ERR_NO_FILE)!==UPLOAD_ERR_OK)fail('Файл не загружен.',413);$name=basename(str_replace('\\','/',(string)$file['name']));if($name===''||strlen($name)>240||preg_match('/[\x00-\x1F\x7F]/',$name)||!preg_match('//u',$name))fail('Некорректное имя файла.');$ext=strtolower(pathinfo($name,PATHINFO_EXTENSION));$allowed=['xlsx','xls','csv','txt','md','py','js','ts','jsx','tsx','html','css','json','xml','yaml','yml','sql','java','c','cpp','h','hpp','cs','go','rs','php','sh','ini','toml'];if(!in_array($ext,$allowed,true))fail('Этот тип файла не поддерживается.');$size=filesize($file['tmp_name']);if($size===false||$size>10*1024*1024)fail('Максимальный размер файла — 10 МБ.',413);if((int)run($db,'SELECT COUNT(*) FROM homework_files WHERE question_id=? AND deleted=0',[$questionId])->fetchColumn()>=5)fail('К одному заданию можно прикрепить не больше 5 файлов.');if(!is_dir($directory)&&!mkdir($directory,0700,true))fail('Не удалось создать папку для файлов.',503);$storage=bin2hex(random_bytes(24)).'.bin';$path=$directory.'/'.$storage;if(!move_uploaded_file($file['tmp_name'],$path))fail('Не удалось сохранить файл.',500);chmod($path,0600);run($db,'INSERT INTO homework_files(question_id,uploader_id,name,storage_name,size) VALUES(?,?,?,?,?)',[$questionId,$user['id'],$name,$storage,$size]);reply(['id'=>(int)$db->lastInsertId(),'name'=>$name,'size'=>$size],201);
    }
    if ($action === 'logout') {
        clearRemember($db,$rememberCookie,$secure);
        $_SESSION=[]; session_destroy(); setcookie(session_name(),'', ['expires'=>time()-3600,'path'=>'/','secure'=>$secure,'httponly'=>true,'samesite'=>'Lax']); reply(['ok'=>true]);
    }
    if ($action === 'state') {
        if ($user['role'] === 'admin') {
            $students = $db->query("SELECT id,name,login,role,active,created_at FROM users WHERE role='student' AND deleted_at IS NULL ORDER BY active DESC,name")->fetchAll();
            $tasks = $db->query('SELECT tasks.*,users.name AS student_name FROM tasks JOIN users ON tasks.student_id=users.id WHERE tasks.deleted_at IS NULL AND users.deleted_at IS NULL ORDER BY tasks.updated_at DESC,tasks.id DESC')->fetchAll();
            $homeworks = $db->query("SELECT h.*,u.name AS student_name,(SELECT COUNT(*) FROM homework_questions q WHERE q.homework_id=h.id) AS question_count,(SELECT COUNT(*) FROM homework_questions q WHERE q.homework_id=h.id AND (trim(q.answer_text)<>'' OR trim(q.code_text)<>'' OR EXISTS(SELECT 1 FROM homework_files f WHERE f.question_id=q.id AND f.deleted=0))) AS answered_count FROM homeworks h JOIN users u ON h.student_id=u.id WHERE h.deleted_at IS NULL AND u.deleted_at IS NULL ORDER BY h.updated_at DESC,h.id DESC")->fetchAll();
        } else {
            $students = []; $tasks = run($db,'SELECT tasks.*,? AS student_name FROM tasks WHERE student_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC',[$user['name'],$user['id']])->fetchAll();
            $homeworks = run($db,"SELECT h.*,? AS student_name,(SELECT COUNT(*) FROM homework_questions q WHERE q.homework_id=h.id) AS question_count,(SELECT COUNT(*) FROM homework_questions q WHERE q.homework_id=h.id AND (trim(q.answer_text)<>'' OR trim(q.code_text)<>'' OR EXISTS(SELECT 1 FROM homework_files f WHERE f.question_id=q.id AND f.deleted=0))) AS answered_count FROM homeworks h WHERE h.student_id=? AND h.deleted_at IS NULL ORDER BY h.updated_at DESC,h.id DESC",[$user['name'],$user['id']])->fetchAll();
        }
        $files = $user['role'] === 'admin'
            ? $db->query('SELECT id,task_id,kind,name,relative_path,size,created_at FROM attachments WHERE deleted=0 ORDER BY id')->fetchAll()
            : run($db,'SELECT a.id,a.task_id,a.kind,a.name,a.relative_path,a.size,a.created_at FROM attachments a JOIN tasks t ON t.id=a.task_id WHERE a.deleted=0 AND t.deleted_at IS NULL AND t.student_id=? ORDER BY a.id',[$user['id']])->fetchAll();
        $byTask=[]; foreach ($files as $file) $byTask[$file['task_id']][]=$file;
        foreach ($tasks as &$item) $item['attachments']=$byTask[$item['id']] ?? [];
        unset($item);
        reply(['user'=>publicUser($user),'students'=>$students,'tasks'=>$tasks,'homeworks'=>$homeworks]);
    }
    if ($action === 'change_password') {
        $old = textValue($data,'old_password',72,true);
        if (!password_verify($old,$user['password_hash'])) fail('Текущий пароль неверный.');
        $new = passwordValue($data);
        run($db,'UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?',[password_hash($new,PASSWORD_DEFAULT),$user['id']]);
        run($db,'DELETE FROM remember_tokens WHERE user_id=?',[$user['id']]);
        setcookie($rememberCookie,'',['expires'=>time()-3600,'path'=>'/','secure'=>$secure,'httponly'=>true,'samesite'=>'Lax']);
        $_SESSION['auth_version']++; session_regenerate_id(true); reply(['ok'=>true]);
    }
    if ($action === 'create_student') {
        requireAdmin($user);
        $name = textValue($data,'name',160,true); $login = strtolower(textValue($data,'login',64,true));
        if (!preg_match('/^[a-z0-9._-]{3,64}$/D',$login)) fail('Логин: 3–64 латинских буквы, цифры, точки, дефисы или подчёркивания.');
        if (run($db,'SELECT id FROM users WHERE login=?',[$login])->fetch()) fail('Этот логин уже занят.');
        $password = bin2hex(random_bytes(8));
        run($db,"INSERT INTO users(name,login,password_hash,role) VALUES(?,?,?,'student')",[$name,$login,password_hash($password,PASSWORD_DEFAULT)]);
        reply(['id'=>(int)$db->lastInsertId(),'name'=>$name,'login'=>$login,'password'=>$password],201);
    }
    if ($action === 'student_access' || $action === 'reset_password') {
        requireAdmin($user); $id = idValue($data,'id');
        $student = run($db,"SELECT * FROM users WHERE id=? AND role='student' AND deleted_at IS NULL",[$id])->fetch();
        if (!$student) fail('Ученик не найден.',404);
        if ($action === 'student_access') {
            if (!is_bool($data['active'] ?? null)) fail('Некорректный статус доступа.');
            run($db,'UPDATE users SET active=?,auth_version=auth_version+1 WHERE id=?',[(int)$data['active'],$id]); reply(['ok'=>true]);
        }
        $password = bin2hex(random_bytes(8));
        run($db,'UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?',[password_hash($password,PASSWORD_DEFAULT),$id]);
        reply(['login'=>$student['login'],'name'=>$student['name'],'password'=>$password]);
    }
    if ($action === 'delete_student') {
        requireAdmin($user); $id = idValue($data,'id');
        $student = run($db,"SELECT id FROM users WHERE id=? AND role='student' AND deleted_at IS NULL",[$id])->fetch();
        if (!$student) fail('Ученик не найден.',404);
        $db->exec('BEGIN IMMEDIATE');
        try {
            run($db,"UPDATE users SET active=0,auth_version=auth_version+1,deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND deleted_at IS NULL",[$id]);
            run($db,"UPDATE tasks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE student_id=? AND deleted_at IS NULL",[$id]);
            run($db,"UPDATE homeworks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE student_id=? AND deleted_at IS NULL",[$id]);
            $db->exec('COMMIT');
        } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
        reply(['ok'=>true]);
    }
    if ($action === 'update_recipients') {
        requireAdmin($user); $id=idValue($data,'id');
        $source=run($db,'SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL',[$id])->fetch();
        if (!$source) fail('Задание не найдено.',404);
        $rawIds=$data['student_ids'] ?? [];
        if (!is_array($rawIds)||!$rawIds||count($rawIds)>200) fail('Выберите от 1 до 200 учеников.');
        $studentIds=[]; foreach($rawIds as $rawId){$studentId=filter_var($rawId,FILTER_VALIDATE_INT);if($studentId===false||$studentId<1)fail('Некорректный ученик.');$studentIds[]=(int)$studentId;}
        $studentIds=array_values(array_unique($studentIds));
        $current=!empty($source['group_id'])
            ? run($db,'SELECT * FROM tasks WHERE group_id=? AND deleted_at IS NULL',[$source['group_id']])->fetchAll()
            : [$source];
        $currentByStudent=[]; foreach($current as $task)$currentByStudent[(int)$task['student_id']]=$task;
        $marks=implode(',',array_fill(0,count($studentIds),'?'));
        $selectedStudents=run($db,"SELECT id,active FROM users WHERE id IN ($marks) AND role='student' AND deleted_at IS NULL",$studentIds)->fetchAll();
        if(count($selectedStudents)!==count($studentIds))fail('Один из учеников не найден.',404);
        foreach($selectedStudents as $student)if(!(int)$student['active']&&!isset($currentByStudent[(int)$student['id']]))fail('Сначала возобновите доступ выбранному ученику.');
        $groupId=count($studentIds)>1?($source['group_id']?:bin2hex(random_bytes(12))):null;
        $materials=run($db,"SELECT * FROM attachments WHERE task_id=? AND kind='material' AND deleted=0 ORDER BY id",[$source['id']])->fetchAll();
        $createdFiles=[];$resultIds=[];
        $db->exec('BEGIN IMMEDIATE');
        try{
            foreach($currentByStudent as $studentId=>$task){
                if(in_array($studentId,$studentIds,true)){
                    run($db,'UPDATE tasks SET group_id=?,updated_at=strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE id=?',[$groupId,$task['id']]);
                    $resultIds[$studentId]=(int)$task['id'];
                }else run($db,"UPDATE tasks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",[$task['id']]);
            }
            foreach($studentIds as $studentId){
                if(isset($resultIds[$studentId]))continue;
                run($db,'INSERT INTO tasks(student_id,title,subject,description,resource_url,due_date,max_score,group_id) VALUES(?,?,?,?,?,?,?,?)',[$studentId,$source['title'],$source['subject'],$source['description'],$source['resource_url'],$source['due_date'],$source['max_score'],$groupId]);
                $newId=(int)$db->lastInsertId();$resultIds[$studentId]=$newId;
                foreach($materials as $material){
                    $from=$private.'/uploads/'.$material['storage_name'];
                    if(!is_file($from))throw new RuntimeException('Missing source attachment');
                    $storage=bin2hex(random_bytes(24)).'.bin';$to=$private.'/uploads/'.$storage;
                    if(!copy($from,$to))throw new RuntimeException('Cannot copy attachment');
                    chmod($to,0600);$createdFiles[]=$to;
                    run($db,'INSERT INTO attachments(task_id,uploader_id,kind,name,storage_name,size,relative_path) VALUES(?,?,?,?,?,?,?)',[$newId,$user['id'],'material',$material['name'],$storage,$material['size'],$material['relative_path']?:$material['name']]);
                }
            }
            $db->exec('COMMIT');
        }catch(Throwable $error){$db->exec('ROLLBACK');foreach($createdFiles as $path)if(is_file($path))unlink($path);throw $error;}
        $ids=array_map(fn($studentId)=>$resultIds[$studentId],$studentIds);
        reply(['ok'=>true,'id'=>$ids[0],'ids'=>$ids,'count'=>count($ids),'group_id'=>$groupId]);
    }
    if ($action === 'save_task') {
        requireAdmin($user);
        $title = textValue($data,'title',250,true); $subject = textValue($data,'subject',100,true); $description = textValue($data,'description',20000,true);
        $resource = validLink(textValue($data,'resource_url',2000)); $due = validDate(textValue($data,'due_date',10));
        $max = filter_var($data['max_score'] ?? null,FILTER_VALIDATE_INT);
        if ($max === false || $max < 1 || $max > 1000) fail('Максимальный балл: от 1 до 1000.');
        if (!empty($data['id'])) {
            $id = idValue($data,'id'); $task = run($db,'SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL',[$id])->fetch();
            if (!$task) fail('Задание не найдено.',404);
            $studentId = idValue($data,'student_id');
            if ((int)$task['student_id'] !== $studentId) fail('Нельзя перенести историю задания другому ученику. Создайте новое задание.');
            $groupScope = ($data['scope'] ?? '') === 'group' && !empty($task['group_id']);
            $targets = $groupScope
                ? run($db,'SELECT id,score FROM tasks WHERE group_id=? AND deleted_at IS NULL',[$task['group_id']])->fetchAll()
                : [['id'=>$id,'score'=>$task['score']]];
            foreach ($targets as $target) if ($target['score'] !== null && (int)$target['score'] > $max) fail('Максимальный балл меньше уже выставленной оценки.');
            $ids = array_map(fn($target)=>(int)$target['id'],$targets);
            $marks = implode(',',array_fill(0,count($ids),'?'));
            run($db,"UPDATE tasks SET title=?,subject=?,description=?,resource_url=?,due_date=?,max_score=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id IN ($marks)",array_merge([$title,$subject,$description,$resource,$due,$max],$ids));
        } else {
            $rawIds = $data['student_ids'] ?? (isset($data['student_id']) ? [$data['student_id']] : []);
            if (!is_array($rawIds) || !$rawIds || count($rawIds)>200) fail('Выберите от 1 до 200 учеников.');
            $studentIds=[]; foreach ($rawIds as $rawId) {
                $studentId=filter_var($rawId,FILTER_VALIDATE_INT);
                if ($studentId===false || $studentId<1) fail('Некорректный ученик.');
                $studentIds[]=(int)$studentId;
            }
            $studentIds=array_values(array_unique($studentIds));
            $marks=implode(',',array_fill(0,count($studentIds),'?'));
            $found=run($db,"SELECT id FROM users WHERE id IN ($marks) AND role='student' AND active=1 AND deleted_at IS NULL",$studentIds)->fetchAll();
            if (count($found)!==count($studentIds)) fail('Один из учеников не найден или его доступ приостановлен.',404);
            $groupId=count($studentIds)>1?bin2hex(random_bytes(12)):null; $ids=[];
            $db->exec('BEGIN IMMEDIATE');
            try {
                foreach ($studentIds as $studentId) {
                    run($db,'INSERT INTO tasks(student_id,title,subject,description,resource_url,due_date,max_score,group_id) VALUES(?,?,?,?,?,?,?,?)',[$studentId,$title,$subject,$description,$resource,$due,$max,$groupId]);
                    $ids[]=(int)$db->lastInsertId();
                }
                $db->exec('COMMIT');
            } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
            $id=$ids[0];
        }
        reply(['id'=>$id,'ids'=>$ids,'count'=>count($ids),'group_id'=>$task['group_id'] ?? $groupId ?? null]);
    }
    if ($action === 'delete_task') {
        requireAdmin($user); $id = idValue($data,'id');
        $task=run($db,'SELECT group_id FROM tasks WHERE id=? AND deleted_at IS NULL',[$id])->fetch();
        if (!$task) fail('Задание не найдено.',404);
        $groupScope=($data['scope'] ?? '')==='group'&&!empty($task['group_id']);
        $changed=$groupScope
            ? run($db,"UPDATE tasks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE group_id=? AND deleted_at IS NULL",[$task['group_id']])
            : run($db,"UPDATE tasks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND deleted_at IS NULL",[$id]);
        if (!$changed->rowCount()) fail('Задание не найдено.',404);
        reply(['ok'=>true,'count'=>$changed->rowCount()]);
    }
    if ($action === 'submit' || $action === 'review') {
        $id=idValue($data,'id');
        // Scope the SQL query itself, not just the UI, to the signed-in student.
        $task = $user['role'] === 'admin' ? run($db,'SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL',[$id])->fetch() : run($db,'SELECT * FROM tasks WHERE id=? AND student_id=? AND deleted_at IS NULL',[$id,$user['id']])->fetch();
        if (!$task) fail('Задание не найдено.',404);
        if ($action === 'submit') {
            if ($user['role'] !== 'student') fail('Решение отправляет ученик.',403);
            if (!in_array($task['status'],['assigned','revision'],true)) fail('Эта работа уже отправлена. Для исправления преподаватель должен вернуть её на доработку.',409);
            $solution=textValue($data,'solution',30000); $url=validLink(textValue($data,'solution_url',2000));
            if ($solution === '' && $url === '' && !run($db,"SELECT id FROM attachments WHERE task_id=? AND kind='solution' AND deleted=0 LIMIT 1",[$id])->fetch()) fail('Добавьте решение: текст, ссылку или файл.');
            run($db,"UPDATE tasks SET solution=?,solution_url=?,status='submitted',submitted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),completed_at=NULL,score=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",[$solution,$url,$id]);
        } else {
            requireAdmin($user); $status=textValue($data,'status',20,true);
            if (!in_array($status,['done','revision'],true)) fail('Некорректный статус проверки.');
            $feedback=textValue($data,'feedback',20000);
            if ($status === 'revision' && $feedback === '') fail('Напишите, что нужно исправить.');
            $score=$data['score'] ?? null;
            if ($score === '') $score=null;
            if ($score !== null && (filter_var($score,FILTER_VALIDATE_INT) === false || (int)$score < 0 || (int)$score > $task['max_score'])) fail('Балл должен быть от 0 до '.$task['max_score'].'.');
            if ($status === 'revision') $score=null;
            run($db,"UPDATE tasks SET status=?,feedback=?,score=?,completed_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",[$status,$feedback,$score,$status==='done'?gmdate('Y-m-d\TH:i:s\Z'):null,$id]);
        }
        reply(['ok'=>true]);
    }
    fail('Действие не найдено.',404);
} catch (Throwable $error) {
    error_log('Kourage: '.$error->getMessage());
    fail('Не удалось выполнить запрос. Попробуйте ещё раз. Если ошибка повторяется, проверьте журнал ошибок хостинга.',500);
}
