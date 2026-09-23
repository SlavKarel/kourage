#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { File } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const allowed=new Set(['xlsx','xls','csv','txt','md','py','js','ts','jsx','tsx','html','css','json','xml','yaml','yml','sql','java','c','cpp','h','hpp','cs','go','rs','php','sh','ini','toml']);
const ignored=new Set(['.git','.vscode','node_modules','__pycache__','.pytest_cache']);
const [siteArg,studentLogin,folderArg]=process.argv.slice(2);
if(!siteArg||!studentLogin||!folderArg){console.error('Использование: node tools/publish-classwork.mjs https://kourage.ru логин_ученика ./папка');process.exit(1);}
const site=new URL(siteArg.endsWith('/')?siteArg:siteArg+'/'),folder=resolve(folderArg);
if(!(await stat(folder).catch(()=>null))?.isDirectory())throw new Error(`Папка не найдена: ${folder}`);

const rl=createInterface({input:stdin,output:stdout});
const login=process.env.KOURAGE_LOGIN||await rl.question('Логин преподавателя: ');
const password=process.env.KOURAGE_PASSWORD||await rl.question('Пароль преподавателя: ');
rl.close();
let cookie='',csrf='';
const apiUrl=action=>{const url=new URL('api.php',site);url.searchParams.set('action',action);return url;};
async function result(response){const raw=response.headers.get('set-cookie');if(raw)cookie=raw.split(';',1)[0];const value=await response.json().catch(()=>({error:`HTTP ${response.status}`}));if(!response.ok)throw new Error(value.error||`HTTP ${response.status}`);if(value.csrf)csrf=value.csrf;return value;}
async function get(action,params={}){const url=apiUrl(action);for(const [key,value]of Object.entries(params))url.searchParams.set(key,String(value));return result(await fetch(url,{headers:cookie?{Cookie:cookie}:{}}));}
async function post(action,data){return result(await fetch(apiUrl(action),{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)}));}
const boot=await get('bootstrap');csrf=boot.csrf;await post('login',{login:login.trim(),password});
const state=await get('classwork_state');if(state.user?.role!=='admin')throw new Error('Публиковать классные работы может только преподаватель.');
const student=state.students.find(item=>item.login.toLowerCase()===studentLogin.toLowerCase());if(!student)throw new Error(`Ученик с логином ${studentLogin} не найден.`);if(!student.active)throw new Error('Доступ ученика приостановлен.');

async function collect(directory){const found=[];for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.name.startsWith('.')||ignored.has(entry.name))continue;const full=join(directory,entry.name);if(entry.isDirectory())found.push(...await collect(full));else if(entry.isFile()){const ext=entry.name.includes('.')?entry.name.split('.').pop().toLowerCase():'';if(!allowed.has(ext))continue;const info=await stat(full);if(info.size>10*1024*1024)throw new Error(`${entry.name}: файл больше 10 МБ.`);found.push({full,path:relative(folder,full).split(sep).join('/')});}}return found.sort((a,b)=>a.path.localeCompare(b.path,'ru'));}
const files=await collect(folder);if(files.length>200)throw new Error(`Найдено ${files.length} файлов. Допустимо не больше 200.`);
console.log(`\n${student.name} · файлов: ${files.length}\n`);
for(let index=0;index<files.length;index++){const item=files[index];stdout.write(`${index+1}/${files.length} ${item.path} ... `);const body=new FormData();body.append('student_id',String(student.id));body.append('path',item.path);body.append('file',new File([await readFile(item.full)],basename(item.path)));await result(await fetch(apiUrl('classwork_upload'),{method:'POST',headers:{'X-CSRF-Token':csrf,Cookie:cookie},body}));console.log('готово');}
await post('classwork_sync',{student_id:Number(student.id),paths:files.map(file=>file.path)});
console.log(`\nПапка классных работ ${student.name} обновлена.`);
