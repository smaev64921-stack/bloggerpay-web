/* Пересборка таблицы каналов: старый ключ «один канал — один аккаунт»
   меняется на «аккаунт + канал». Проверка важна тем, что трогает боевые
   данные: при ошибке пересборки подтверждённые каналы просто исчезли бы.

   Порядок: поднимаем сервер на чистой базе (он создаёт всю схему), гасим,
   руками возвращаем таблице каналов СТАРЫЙ вид и кладём две строки, снова
   поднимаем — и смотрим, что строки на месте, ключ новый, один канал
   заходит в два аккаунта, а дважды в один — нет.
   Запуск: node test-chan-migrate.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CWD = fileURLToPath(new URL('.', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-chan-'));
const DB = path.join(dir, 'db.sqlite');
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 220) : '')); }
}

function start(port) {
  return spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: {
      ...process.env, PORT: String(port), DB_PATH: DB, ADMIN_KEY: 'test-key',
      YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '',
    },
    stdio: 'ignore',
  });
}
async function up(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let srv = null;
try {
  console.log('\nПересборка таблицы каналов');

  /* ── 1. Схему создаёт сам сервер ── */
  srv = start(8097);
  ok(await up(8097), 'сервер поднялся на чистой базе');
  srv.kill();
  await new Promise((r) => setTimeout(r, 500));

  /* ── 2. Возвращаем таблице каналов старый вид ── */
  {
    const db = new DatabaseSync(DB);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS channels');
    db.exec(`CREATE TABLE channels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      platform    TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title       TEXT,
      url         TEXT,
      subs        INTEGER,
      checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, external_id)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS channels_user ON channels(user_id)');
    db.prepare('INSERT INTO users (email,name,role,pass_salt,pass_hash) VALUES (?,?,?,?,?)')
      .run('a@x.local', 'Первый', 'blogger', 's', 'h');
    db.prepare('INSERT INTO users (email,name,role,pass_salt,pass_hash) VALUES (?,?,?,?,?)')
      .run('b@x.local', 'Второй', 'blogger', 's', 'h');
    db.prepare('INSERT INTO channels (user_id,platform,external_id,title,url,subs) VALUES (?,?,?,?,?,?)')
      .run(1, 'tiktok', 'kanal-1', 'Канал один', 'https://tiktok.com/@k1', 1234);
    db.prepare('INSERT INTO channels (user_id,platform,external_id,title,url,subs) VALUES (?,?,?,?,?,?)')
      .run(2, 'youtube', 'kanal-2', 'Канал два', 'https://youtube.com/@k2', 42);
    db.close();
  }

  /* ── 3. Второй запуск должен пересобрать таблицу ── */
  srv = start(8097);
  ok(await up(8097), 'сервер поднялся на базе со старым ключом');

  const db = new DatabaseSync(DB);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'").get().sql;
  ok(/UNIQUE\s*\(\s*user_id\s*,\s*platform\s*,\s*external_id\s*\)/i.test(sql),
    'ключ стал «аккаунт + канал»', sql.slice(0, 200));
  ok(!/UNIQUE\s*\(\s*platform\s*,\s*external_id\s*\)/i.test(sql), 'старого ключа больше нет');

  const rows = db.prepare('SELECT id, user_id, platform, external_id, title, subs FROM channels ORDER BY id').all();
  ok(rows.length === 2, 'обе строки пережили пересборку', rows);
  ok(rows[0].external_id === 'kanal-1' && rows[0].user_id === 1 && rows[0].title === 'Канал один',
    'первая строка не потеряла данные', rows[0]);
  ok(rows[1].external_id === 'kanal-2' && rows[1].subs === 42, 'вторая строка не потеряла данные', rows[1]);
  ok(rows[0].id === 1 && rows[1].id === 2, 'номера строк сохранились', rows.map((r) => r.id));

  const cols = db.prepare("PRAGMA table_info('channels')").all().map((c) => c.name);
  ok(cols.includes('avatar'), 'колонка avatar на месте', cols);
  const idx = db.prepare("PRAGMA index_list('channels')").all().map((i) => i.name);
  ok(idx.includes('channels_user'), 'индекс по аккаунту вернулся', idx);

  let added = true;
  try {
    db.prepare('INSERT INTO channels (user_id,platform,external_id,title) VALUES (?,?,?,?)')
      .run(2, 'tiktok', 'kanal-1', 'Тот же канал');
  } catch (e) { added = false; }
  ok(added, 'один канал заходит во второй аккаунт');

  let twice = false;
  try {
    db.prepare('INSERT INTO channels (user_id,platform,external_id,title) VALUES (?,?,?,?)')
      .run(2, 'tiktok', 'kanal-1', 'Он же ещё раз');
    twice = true;
  } catch (e) { twice = false; }
  ok(!twice, 'дважды в один аккаунт — нельзя');
  db.close();

  /* ── 4. Ещё один запуск ничего не трогает ── */
  srv.kill();
  await new Promise((r) => setTimeout(r, 500));
  srv = start(8097);
  ok(await up(8097), 'сервер поднялся на уже пересобранной базе');
  const db2 = new DatabaseSync(DB);
  ok(db2.prepare('SELECT COUNT(*) AS n FROM channels').get().n === 3, 'повторный запуск ничего не стёр');
  db2.close();
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + e.message);
} finally {
  try { if (srv) srv.kill(); } catch (e) { /* уже мёртв */ }
}
console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
process.exit(failed ? 1 : 0);
