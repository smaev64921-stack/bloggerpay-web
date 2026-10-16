# ══════════════════════════════════════════════════════════════════════
#  BloggerPay — публикация на GitHub в один запуск.
#
#  Что делает: создаёт публичный репозиторий в вашем аккаунте и заливает
#  туда код. Всё остальное уже готово: коммит собран, секреты исключены.
#
#  Как запустить: правой кнопкой по файлу → «Выполнить с помощью
#  PowerShell». Или в терминале из папки проекта:
#      powershell -ExecutionPolicy Bypass -File .\опубликовать.ps1
#
#  Токен вводится в ЭТОМ окне и уходит напрямую в GitHub. Он не
#  сохраняется на диск и не остаётся в настройках репозитория.
#
#  Файл сохранён в UTF-8 с BOM — иначе Windows PowerShell читает
#  кириллицу как набор символов и скрипт не запускается.
#
#  Только проверить секреты, ничего не коммитя и не отправляя:
#      powershell -ExecutionPolicy Bypass -File .\опубликовать.ps1 -CheckOnly
# ══════════════════════════════════════════════════════════════════════

param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  [!] $text" -ForegroundColor Red }

Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "  Публикация BloggerPay на GitHub" -ForegroundColor White
Write-Host "  -------------------------------" -ForegroundColor DarkGray

# ── Секреты не должны уехать ни при каких обстоятельствах ─────────────
# Порядок важен (аудит 16.10): сначала ищем секреты в файлах и в индексе,
# потом коммитим, потом проверяем ВСЮ историю ветки. Раньше было наоборот:
# git add -A и коммит, а поиск — только по текущим файлам. Найденный ключ
# уже лежал в коммите; человек стирал его, запускал снова — дерево чистое,
# и git push отправлял в публичный репозиторий всю историю вместе с ключом.
Step "Проверяю, что секреты не попадут в публичный репозиторий"

if (-not (Test-Path ".git")) { Fail "В этой папке нет репозитория."; Read-Host "  Enter"; exit 1 }

# git без падения скрипта: «ничего не найдено» у git grep — код 1, это норма.
function GitOut([string[]]$GitArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return @(& git @GitArgs 2>$null) } finally { $ErrorActionPreference = $old }
}
# Значение ключа в выводе не показываем целиком — только первые 4 знака.
function Masked([string]$line) {
    $parts = $line -split ':', 3
    if ($parts.Count -lt 3) { return $line }
    return $parts[0] + ':' + $parts[1] + ': ' + ($parts[2] -replace '([A-Za-z0-9_:.-]{4})[A-Za-z0-9_:.-]{8,}', '$1********')
}
function Stop-Leak([string]$why, $lines) {
    Fail $why
    $lines | Select-Object -First 20 | ForEach-Object { Write-Host "    $(Masked $_)" -ForegroundColor Red }
    Write-Host "  Секреты должны быть только в server/.env, который не входит в репозиторий." -ForegroundColor Yellow
    Read-Host "  Enter"; exit 1
}

# Любой .env (кроме .env.example): уже в репозитории, в индексе или
# будет добавлен git add -A (не закрыт .gitignore).
$willTrack = GitOut @('ls-files', '--cached', '--others', '--exclude-standard')
$envFiles = @($willTrack | Where-Object { $_ -match '(^|/)\.env$' })
if ($envFiles.Count -gt 0) {
    Fail "Файл с ключами попадёт в репозиторий — публикация отменена:"
    $envFiles | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Write-Host "  Добавьте его в .gitignore (и git rm --cached, если он уже в репозитории)." -ForegroundColor Yellow
    Read-Host "  Enter"; exit 1
}

# Ищем ЗАПОЛНЕННЫЕ значения — то, что выглядит как настоящий ключ:
# имя из .env и минимум 12 символов латиницы, цифр и разделителей. Пустые
# строки в .env.example и пояснения в инструкциях («TT_CLIENT_SECRET=сюда
# client secret») под это не подходят. Плюс «голые» ключи по их виду:
# токен бота, Resend, Google, ЮKassa (live), GitHub, закрытые ключи.
$value = '[A-Za-z0-9_:.-]{12,}'
$names = @('BOT_TOKEN', 'TT_CLIENT_KEY', 'TT_CLIENT_SECRET', 'YT_CLIENT_ID', 'YT_CLIENT_SECRET',
           'YT_API_KEY', 'IG_CLIENT_SECRET', 'YOOKASSA_SHOP_ID', 'YOOKASSA_SECRET_KEY',
           'ADMIN_KEY', 'RESEND_API_KEY', 'RELAY_KEY')
$patterns = @('(' + ($names -join '|') + ")=$value") + @(
    '(^|[^0-9])[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}',
    '(^|[^A-Za-z0-9_])re_[A-Za-z0-9]{6,}_[A-Za-z0-9_]{16,}',
    'AIza[0-9A-Za-z_-]{35}',
    'GOCSPX-[0-9A-Za-z_-]{20,}',
    '(^|[^A-Za-z0-9_])live_[A-Za-z0-9_-]{30,}',
    'gh[pousr]_[A-Za-z0-9]{36}',
    'github_pat_[A-Za-z0-9_]{50,}',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
$rx = $patterns -join '|'

# 1) Файлы: отслеживаемые и новые (их заберёт git add -A), затем индекс.
$leaks = GitOut @('grep', '--untracked', '-I', '-n', '-E', $rx)
if ($leaks.Count -gt 0) { Stop-Leak "Похоже на заполненный секрет в файлах — публикация отменена, ничего не закоммичено." $leaks }
$leaks = GitOut @('grep', '--cached', '-I', '-n', '-E', $rx)
if ($leaks.Count -gt 0) { Stop-Leak "Секрет лежит в индексе (git add уже сделан) — публикация отменена. Уберите его: git reset -- <файл>." $leaks }
Done "в файлах и индексе секретов нет"

# 2) Вся история ветки main: git push отправит её целиком, не только
#    последний коммит. Стёртый в файле ключ в старом коммите остаётся.
Write-Host "  Проверяю историю ветки main (может занять до минуты)..." -ForegroundColor DarkGray
$histBranch = 'main'
if ((GitOut @('rev-parse', '--verify', '--quiet', 'main')).Count -eq 0) { $histBranch = 'HEAD' }
$bad = GitOut @('log', '-m', '--format=%h %ad %s', '--date=short', "-G$rx", $histBranch)
if ($bad.Count -gt 0) {
    Fail "Секрет есть в ИСТОРИИ (в старых коммитах) — публикация отменена."
    $bad | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Write-Host "  Такой ключ считайте утёкшим: смените его (BotFather /revoke, кабинет площадки)" -ForegroundColor Yellow
    Write-Host "  и до публикации перепишите историю (git filter-repo), иначе он уйдёт в GitHub." -ForegroundColor Yellow
    Read-Host "  Enter"; exit 1
}
Done "в истории секретов нет"

if ($CheckOnly) {
    Done "проверка закончена, ничего не закоммичено и не отправлено"
    exit 0
}

# ── Коммит ────────────────────────────────────────────────────────────
Step "Сохраняю изменения в коммит"

$dirty = git status --porcelain
if ($dirty) {
    Write-Host "  Есть несохранённые изменения — добавляю их в коммит:" -ForegroundColor Yellow
    $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    git add -A
    git commit -q -m "Обновление перед публикацией"
    # Файл мог измениться между проверкой и git add — сверяем то, что
    # реально попало в новый коммит.
    $leaks = GitOut @('grep', '-I', '-n', '-E', $rx, 'HEAD')
    if ($leaks.Count -gt 0) {
        git reset -q --soft HEAD~1
        Stop-Leak "Секрет попал в коммит — коммит отменён (изменения остались в индексе), публикация отменена." $leaks
    }
}
Done "все файлы сохранены в коммит; секретов нет: server/.env, база и личные файлы исключены"

# ── Кто вы на GitHub ──────────────────────────────────────────────────
Step "Данные для входа"
Write-Host "  Нужен токен доступа. Где взять:" -ForegroundColor Gray
Write-Host "    github.com -> Settings -> Developer settings ->" -ForegroundColor DarkGray
Write-Host "    Personal access tokens -> Tokens (classic) -> Generate new token" -ForegroundColor DarkGray
Write-Host "    Отметьте галочку repo. Строка начинается на ghp_" -ForegroundColor DarkGray
Write-Host ""

$login = Read-Host "  Ваш логин на GitHub"
if (-not $login) { Fail "Логин не введён."; Read-Host "  Enter"; exit 1 }

$repoName = Read-Host "  Название репозитория (Enter - bloggerpay)"
if (-not $repoName) { $repoName = "bloggerpay" }

$secure = Read-Host "  Токен (ввод не отображается)" -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
           [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $token) { Fail "Токен не введён."; Read-Host "  Enter"; exit 1 }

$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "BloggerPay-publish"
}

# ── Создаём репозиторий ───────────────────────────────────────────────
Step "Создаю публичный репозиторий $login/$repoName"

$body = @{
    name        = $repoName
    description = "Биржа рекламы у блогеров: сделки с эскроу, выплаты, мини-приложение Telegram"
    private     = $false
    has_issues  = $true
    has_wiki    = $false
} | ConvertTo-Json

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $repo = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Method Post `
                              -Headers $headers -Body $body -ContentType "application/json"
    Done "репозиторий создан: $($repo.html_url)"
}
catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 422) {
        Write-Host "  Репозиторий с таким именем уже есть — залью код в него." -ForegroundColor Yellow
    }
    elseif ($code -eq 401) {
        Fail "Токен не подошёл. Проверьте, что скопировали его целиком и срок не истёк."
        Read-Host "  Enter"; exit 1
    }
    elseif ($code -eq 403) {
        Fail "У токена нет прав на создание репозиториев. Нужна галочка repo."
        Read-Host "  Enter"; exit 1
    }
    else {
        Fail "GitHub ответил ошибкой $code : $($_.Exception.Message)"
        Read-Host "  Enter"; exit 1
    }
}

# ── Заливаем ──────────────────────────────────────────────────────────
Step "Отправляю код"

# В настройках репозитория оставляем ЧИСТЫЙ адрес, без токена,
# чтобы он не сохранился на диске в .git/config.
git remote remove origin 2>$null | Out-Null
git remote add origin "https://github.com/$login/$repoName.git"

$pushUrl = "https://" + $login + ":" + $token + "@github.com/$login/$repoName.git"
git push --quiet $pushUrl main 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

if ($LASTEXITCODE -ne 0) {
    Fail "Отправить не удалось. Чаще всего причина — у токена нет прав repo."
    Read-Host "  Enter"; exit 1
}
git branch --set-upstream-to=origin/main main 2>$null | Out-Null
Done "код на GitHub"

# Токен нигде не оставляем.
$token = $null
$pushUrl = $null
[GC]::Collect()

$pageUrl  = "https://github.com/$login/$repoName"
$cloneUrl = "$pageUrl.git"

Write-Host ""
Write-Host "  ГОТОВО. Код опубликован." -ForegroundColor White
Write-Host ""
Write-Host "  Ссылка на репозиторий (её открывают в браузере):" -ForegroundColor Gray
Write-Host "    $pageUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Ссылка из кнопки Code (её вставляют в git clone):" -ForegroundColor Gray
Write-Host "    $cloneUrl" -ForegroundColor Cyan
Write-Host ""

# Кладём ссылки в буфер обмена и в файл рядом — чтобы не переписывать руками.
try {
    Set-Clipboard -Value $pageUrl
    Write-Host "  Ссылка скопирована в буфер обмена — можно сразу вставить." -ForegroundColor DarkGray
} catch { }
"$pageUrl`r`n$cloneUrl`r`n" | Out-File -FilePath "ссылка-на-репозиторий.txt" -Encoding UTF8
Write-Host "  Также сохранена в файл: ссылка-на-репозиторий.txt" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Дальше обновлять так:" -ForegroundColor Gray
Write-Host '    git add -A; git commit -m "что изменил"; git push' -ForegroundColor DarkGray
Write-Host ""

$open = Read-Host "  Открыть репозиторий в браузере? (д/н)"
if ($open -match '^[дdyY]') { Start-Process $pageUrl }
Read-Host "  Нажмите Enter, чтобы закрыть"
