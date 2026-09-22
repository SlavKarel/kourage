#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { File } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const allowed = new Set(['xlsx','xls','csv','txt','md','py','js','ts','jsx','tsx','html','css','json','xml','yaml','yml','sql','java','c','cpp','h','hpp','cs','go','rs','php','sh','ini','toml']);
const ignoredFolders = new Set(['.git','.vscode','node_modules','__pycache__','.pytest_cache']);
const [siteArg, taskArg, folderArg] = process.argv.slice(2);

if (!siteArg || !taskArg || !folderArg || !/^\d+$/.test(taskArg)) {
  console.error('Использование: node tools/publish-assignment.mjs https://kourage.ru 123 ./папка-задания');
  process.exit(1);
}

const site = new URL(siteArg.endsWith('/') ? siteArg : siteArg + '/');
const taskId = Number(taskArg);
const folder = resolve(folderArg);
const folderInfo = await stat(folder).catch(() => null);
if (!folderInfo?.isDirectory()) throw new Error(`Папка не найдена: ${folder}`);

const rl = createInterface({ input: stdin, output: stdout });
const login = process.env.KOURAGE_LOGIN || await rl.question('Логин преподавателя: ');
const password = process.env.KOURAGE_PASSWORD || await rl.question('Пароль преподавателя: ');
rl.close();

let cookie = '';
let csrf = '';
function apiUrl(action) {
  const url = new URL('api.php', site);
  url.searchParams.set('action', action);
  return url;
}
function remember(response) {
  const raw = response.headers.get('set-cookie');
  if (raw) cookie = raw.split(';', 1)[0];
}
async function jsonResponse(response) {
  remember(response);
  const value = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  if (value.csrf) csrf = value.csrf;
  return value;
}
async function get(action) {
  return jsonResponse(await fetch(apiUrl(action), { headers: cookie ? { Cookie: cookie } : {} }));
}
async function post(action, data) {
  return jsonResponse(await fetch(apiUrl(action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(data)
  }));
}

const bootstrap = await get('bootstrap');
csrf = bootstrap.csrf;
await post('login', { login: login.trim(), password });
const state = await get('state');
if (state.user?.role !== 'admin') throw new Error('Публиковать файлы может только преподаватель.');
const sourceTask = state.tasks.find(task => Number(task.id) === taskId);
if (!sourceTask) throw new Error(`Задание #${taskId} не найдено.`);
const targetTasks = sourceTask.group_id ? state.tasks.filter(task => task.group_id === sourceTask.group_id) : [sourceTask];

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignoredFolders.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(full));
    else if (entry.isFile()) {
      const extension = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
      if (!allowed.has(extension)) continue;
      const info = await stat(full);
      if (info.size > 10 * 1024 * 1024) throw new Error(`${entry.name}: файл больше 10 МБ.`);
      result.push({ full, path: relative(folder, full).split(sep).join('/'), size: info.size });
    }
  }
  return result.sort((a,b) => a.path.localeCompare(b.path, 'ru'));
}

const files = await collect(folder);
if (!files.length) throw new Error('В папке нет поддерживаемых файлов.');
if (files.length > 20) throw new Error(`Найдено ${files.length} файлов. В одном задании можно хранить не больше 20.`);

console.log(`\n${sourceTask.title}`);
console.log(`Файлов: ${files.length} · кабинетов: ${targetTasks.length}\n`);

for (const task of targetTasks) {
  for (let index = 0; index < files.length; index++) {
    const item = files[index];
    stdout.write(`[${task.student_name}] ${index + 1}/${files.length} ${item.path} ... `);
    const body = new FormData();
    body.append('task_id', String(task.id));
    body.append('kind', 'material');
    body.append('path', item.path);
    body.append('file', new File([await readFile(item.full)], basename(item.path)));
    await jsonResponse(await fetch(apiUrl('upload'), {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf, Cookie: cookie },
      body
    }));
    console.log('готово');
  }

  const publishedPaths = new Set(files.map(file => file.path));
  const obsolete = (task.attachments || []).filter(file => file.kind === 'material' && !publishedPaths.has(file.relative_path || file.name));
  for (const file of obsolete) await post('remove_attachment', { id: Number(file.id) });
}

console.log(`\nГотово. Папка опубликована в задании #${taskId}.`);
console.log('Ученики увидят новую структуру после обновления страницы.');
