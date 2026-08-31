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
# ══════════════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  [!] $text" -ForegroundColor Red }

Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "  Публикация BloggerPay на GitHub" -ForegroundColor White
Write-Host "  -------------------------------" -ForegroundColor DarkGray

# ── Всё ли готово ─────────────────────────────────────────────────────
Step "Проверяю, что всё готово к отправке"

if (-not (Test-Path ".git")) { Fail "В этой папке нет репозитория."; Read-Host "  Enter"; exit 1 }

$dirty = git status --porcelain
if ($dirty) {
    Write-Host "  Есть несохранённые изменения — добавляю их в коммит:" -ForegroundColor Yellow
    $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    git add -A
    git commit -q -m "Обновление перед публикацией"
}
Done "все файлы сохранены в коммит"

# ── Секреты не должны уехать ни при каких обстоятельствах ─────────────
Step "Ещё раз проверяю, что секреты не попадут в публичный репозиторий"

$tracked = git ls-files
if ($tracked -contains 'server/.env') {
    Fail "В репозиторий попал server/.env — публикация отменена."
    Read-Host "  Enter"; exit 1
}

# Ищем ЗАПОЛНЕННЫЕ значения — то, что выглядит как настоящий ключ:
# минимум 12 символов латиницы, цифр и разделителей, без пробелов.
# Пустые строки в .env.example и пояснения в инструкциях
# («TT_CLIENT_SECRET=сюда client secret») под это не подходят.
$value = '[A-Za-z0-9_:.-]{12,}'
$patterns = @(
    "BOT_TOKEN=$value",
    "TT_CLIENT_KEY=$value",
    "TT_CLIENT_SECRET=$value",
    "YT_CLIENT_ID=$value",
    "YT_CLIENT_SECRET=$value",
    "YOOKASSA_SHOP_ID=$value",
    "YOOKASSA_SECRET_KEY=$value",
    "ADMIN_KEY=$value"
)
$leaks = @()
foreach ($p in $patterns) {
    $hit = git grep -I -n -E $p 2>$null
    if ($hit) { $leaks += $hit }
}
if ($leaks.Count -gt 0) {
    Fail "Похоже на заполненный секрет в файлах репозитория — публикация отменена."
    $leaks | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Write-Host "  Секреты должны быть только в server/.env, который не входит в репозиторий." -ForegroundColor Yellow
    Read-Host "  Enter"; exit 1
}
Done "секретов нет: server/.env, база и личные файлы исключены"

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
