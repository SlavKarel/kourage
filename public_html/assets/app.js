'use strict';
const $ = (s, root = document) => root.querySelector(s);
const app = $('#app'), modal = $('#modal');
const demo = new URLSearchParams(location.search).has('demo');
let csrf = '', user = null, students = [], tasks = [], view = 'tasks', filter = 'all', search = '', studentFilter = '', toastTimer;
const statusNames = {assigned:'К выполнению', submitted:'На проверке', revision:'На доработку', done:'Выполнено'};
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
 book:'<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z"/><path d="M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 check:'<path d="m5 12 4 4L19 6"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 users:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 5a5 5 0 0 1 3 5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>', arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', logout:'<path d="M9 4H4v16h5m5-12 4 4-4 4M8 12h12"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>', edit:'<path d="m14 5 5 5M4 20l5-1L20 8a3 3 0 0 0-4-4L5 15z"/>',
 key:'<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3"/>', star:'<path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const brand = '<div class="brand"><img src="assets/favicon.svg" alt="">kourage<span style="color:#2457e8">.</span></div>';
const initials = name => name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
const date = value => value ? new Date(value.length === 10 ? value+'T12:00:00' : value).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}) : 'Без срока';
const today = () => {const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const badge = task => `<span class="badge ${esc(task.status)}">${task.status==='done'?'✓ ':''}${esc(statusNames[task.status])}</span>`;
const admin = () => user?.role === 'admin';
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').style.display='block';toastTimer=setTimeout(()=>$('#toast').style.display='none',4500);}
function closeModal(){modal.close();document.body.classList.remove('modal-open');}
function openModal(title,body){modal.innerHTML=`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="btn ghost" data-action="close" aria-label="Закрыть">${icon('close')}</button></div><div class="modal-body">${body}</div>`;document.body.classList.add('modal-open');if(!modal.open)modal.showModal();}
modal.addEventListener('close',()=>document.body.classList.remove('modal-open'));
modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}});
function errorBox(){return '<p class="form-error" role="alert"></p>';}
function field(label,name,value='',type='text',extra=''){return `<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;}
function area(label,name,value='',extra=''){return `<label class="field">${esc(label)}<textarea name="${name}" ${extra}>${esc(value)}</textarea></label>`;}
function actions(label,danger=false){return `${errorBox()}<div class="modal-actions"><button type="button" class="btn secondary" data-action="close">Отмена</button><button class="btn ${danger?'danger':''}" type="submit">${label}</button></div>`;}

async function api(action,data){
 if(demo)return demoApi(action,data);
 const response=await fetch(`api.php?action=${encodeURIComponent(action)}`,{method:data?'POST':'GET',credentials:'same-origin',headers:data?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:data?JSON.stringify(data):undefined});
 let result;try{result=await response.json();}catch{throw new Error('Сервер не ответил. Для установки нужен PHP-хостинг. Инструкция находится в архиве сайта.');}
 if(!response.ok){if(response.status===401 && action!=='login'){user=null;loginScreen(true);}throw new Error(result.error||'Не удалось выполнить запрос.');}
 if(result.csrf)csrf=result.csrf;return result;
}
async function refresh(){const data=await api('state');user=data.user;students=data.students;tasks=data.tasks;render();}
async function start(){try{const data=await api('bootstrap');user=data.user;if(user)await refresh();else loginScreen(data.installed);}catch(e){app.innerHTML=`<div class="error-page">${brand}<h1 style="margin-top:32px">Кабинет пока недоступен</h1><p class="muted">${esc(e.message)}</p><button class="btn" data-action="retry">Попробовать снова</button> <a class="btn secondary" href="?demo=1">Посмотреть демо</a></div>`;}}
function loginScreen(installed){app.innerHTML=`<div class="login"><section class="login-story">${brand}<div><div class="eyebrow" style="color:#c9f475">Твой учебный маршрут</div><h1>Каждое задание —<br><span>шаг вперёд.</span></h1><p>Здесь остаются твои решения, новые знания и маленькие победы. Продолжим с того места, где остановились.</p></div><div class="story-note">Kourage · Учимся осмысленно</div></section><section class="login-form-wrap"><form class="login-form" data-form="${installed?'login':'setup'}"><h2>${installed?'С возвращением':'Настроим Kourage'}</h2><p>${installed?'Войди в кабинет, чтобы открыть свои задания.':'Создай учётную запись преподавателя. Это нужно сделать только один раз.'}</p>${!installed?field('Ключ установки','setup_key','','password','required autocomplete="off"')+field('Твоё имя','name','','text','required maxlength="80" autocomplete="name"'):''}${field('Логин','login','','text','required pattern="[A-Za-z0-9._-]{3,64}" autocomplete="username" placeholder="Твой логин"')}${field('Пароль','password','','password',`required ${installed?'':'minlength="6"'} maxlength="72" autocomplete="${installed?'current-password':'new-password'}" placeholder="Твой пароль"`)}${errorBox()}<button class="btn" type="submit">${installed?'Войти в кабинет':'Создать кабинет'} ${icon('arrow')}</button><div class="login-hint">${installed?'Логин и пароль выдаёт преподаватель. Если забыл пароль, попроси его создать новый.':'Ключ находится в файле private/setup-key.txt из установочного архива.'}</div><div class="login-hint"><a href="?demo=1">Посмотреть демоверсию</a></div></form></section></div>`;}

function render(){
 const completed=tasks.filter(t=>t.status==='done').length,pending=tasks.filter(t=>t.status==='submitted').length;
 const navItems=admin()?[['tasks','book','Задания'],['students','users','Ученики'],['history','check','Выполненные']]:[['tasks','book','Мои задания'],['history','check','Выполненные']];
 app.innerHTML=`${demo?`<div class="demo-ribbon">Демоверсия · Пример данных, изменения не сохраняются после обновления.<button data-action="demo-role">${admin()?'Кабинет ученика':'Панель преподавателя'}</button></div>`:''}<div class="shell"><aside class="sidebar">${brand}<div><div class="workspace-label">${admin()?'Преподаватель':'Личный кабинет'}</div><nav class="nav" aria-label="Разделы кабинета">${navItems.map(([id,ic,label])=>`<button data-action="view" data-value="${id}" class="${view===id?'active':''}" ${view===id?'aria-current="page"':''}>${icon(ic)}${label}${id==='history'?`<span class="count">${completed}</span>`:''}</button>`).join('')}</nav></div><div class="sidebar-bottom"><div class="tip"><strong>${admin()?'Всё обучение — рядом':'Не бойся ошибаться'}</strong>${admin()?'Назначай задания, проверяй решения и сохраняй обратную связь.':'Возвращайся к прошлым решениям: так знания остаются с тобой.'}</div><div class="profile"><span class="avatar">${esc(initials(user.name))}</span><div><div class="profile-name">${esc(user.name)}</div><div class="muted small">${admin()?'Преподаватель':'Ученик'}</div></div><button class="btn ghost" data-action="logout" aria-label="Выйти">${icon('logout')}</button></div></div></aside><main class="main"><header class="topbar"><span class="muted">Кабинет / <span style="color:#26344d">${view==='students'?'Ученики':view==='history'?'Выполненные задания':'Задания'}</span></span><div class="right"><span>${esc(user.name)}</span><span class="role-label">${admin()?'Преподаватель':'Ученик'}</span><button class="btn ghost" data-action="password" aria-label="Сменить пароль" title="Сменить пароль">${icon('key')}</button><button class="btn ghost" data-action="logout" aria-label="Выйти" title="Выйти">${icon('logout')}</button></div></header><div class="content">${view==='students'?studentView():taskView(completed,pending)}</div></main></div>`;
 bindSearch();
}
function taskView(completed,pending){
 const history=view==='history', percent=tasks.length?Math.round(completed/tasks.length*100):0;
 const active=tasks.filter(t=>['assigned','revision'].includes(t.status)).length;
 const scored=tasks.filter(t=>t.status==='done'&&t.score!==null);
 const average=scored.length?Math.round(scored.reduce((sum,t)=>sum+t.score/t.max_score*100,0)/scored.length):null;
 return `<div class="heading"><div><div class="eyebrow">${history?'Твой результат':admin()?'Учебный процесс':'Продолжаем учиться'}</div><h1>${history?'Выполненные задания':admin()?'Задания учеников':'Мои задания'}</h1><p>${history?'Все решения и комментарии преподавателя — в одном месте.':admin()?'Следи за работами и помогай двигаться дальше.':'Всё, что нужно сделать. И всё, что уже получилось.'}</p></div>${admin()?`<button class="btn" data-action="new-task">${icon('plus')} Добавить задание</button>`:''}</div>
 ${!admin()&&!history?`<section class="banner"><div><h2>${completed?'Хорошая работа. Продолжай!':'Начнём с первого задания'}</h2><p>${completed?`Уже выполнено ${completed} из ${tasks.length} заданий. Каждое решение делает сложное понятнее.`:'Открой задание, изучи материалы и отправь своё решение преподавателю.'}</p></div><div class="progress-ring" style="--progress:${percent}%" aria-label="Выполнено ${percent}% заданий"><div><b>${percent}%</b><span>выполнено</span></div></div></section>`:''}
 <section class="stats" aria-label="Статистика"><div class="stat"><span class="stat-icon">${icon('book')}</span><div><b>${history?tasks.length:active}</b><p>${history?'Всего заданий':'К выполнению'}</p></div></div><div class="stat"><span class="stat-icon">${icon('check')}</span><div><b>${completed}</b><p>Выполнено</p></div></div><div class="stat"><span class="stat-icon">${icon(history?'star':'clock')}</span><div><b>${history?(average===null?'—':average+'%'):pending}</b><p>${history?'Средний результат':'На проверке'}</p></div></div></section>
 <div class="section-top"><h2>${history?'История работ':'Все задания'}</h2>${!history?`<div class="filters" role="group" aria-label="Статус задания">${[['all','Все'],['assigned','К выполнению'],['submitted','На проверке'],['revision','Доработка']].map(([id,label])=>`<button class="filter ${filter===id?'active':''}" data-action="filter" data-value="${id}" aria-pressed="${filter===id}">${label}</button>`).join('')}</div>`:''}</div><div class="tools"><label class="search">${icon('search')}<input id="search" aria-label="Поиск заданий" placeholder="Найти задание или тему" value="${esc(search)}"></label>${admin()?`<select id="student-filter" aria-label="Фильтр по ученику"><option value="">Все ученики</option>${students.map(s=>`<option value="${s.id}" ${studentFilter===String(s.id)?'selected':''}>${esc(s.name)}</option>`).join('')}</select>`:''}</div><div id="task-results">${taskResults()}</div><p class="footer-note">${history?'К выполненным заданиям можно вернуться в любой момент.':'Открой задание, чтобы увидеть условие, решение и обратную связь.'}</p>`;
}
function taskResults(){
 const list=tasks.filter(t=>(view==='history'?t.status==='done':filter==='all'||t.status===filter)&&(!studentFilter||String(t.student_id)===studentFilter)&&`${t.title} ${t.subject} ${t.description} ${t.student_name}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')));
 if(!list.length)return `<div class="empty">${icon(view==='history'?'check':'book')}<h3>${search||studentFilter?'Ничего не найдено':view==='history'?'История начинается с первого решения':'Заданий пока нет'}</h3><p>${search||studentFilter?'Попробуй другой запрос или убери фильтры.':admin()?'Добавь ученика и назначь ему первое задание.':'Когда преподаватель добавит или проверит работу, она появится здесь.'}</p></div>`;
 return `<div class="task-list">${list.map(t=>`<article class="task ${t.status==='done'?'done':''}"><span class="task-mark">${icon(t.status==='done'?'check':'book')}</span><div class="task-body"><div class="meta"><span class="subject">${esc(t.subject)}</span><span>Задание #${t.id}</span>${admin()?`<span>· ${esc(t.student_name)}</span>`:''}</div><h3><button class="task-title" data-action="detail" data-id="${t.id}">${esc(t.title)}</button></h3><p class="task-description">${esc(t.description)}</p><div class="task-footer"><span class="${t.due_date&&t.due_date<today()&&['assigned','revision'].includes(t.status)?'overdue':''}">${t.status==='done'?'Выполнено '+date(t.completed_at):t.due_date?'Срок: '+date(t.due_date):'Без срока'}</span>${t.score!==null?`<span>Результат: <strong>${t.score} / ${t.max_score}</strong></span>`:''}${t.feedback?'<span>Есть комментарий</span>':''}</div></div><div class="task-side">${badge(t)}<button class="btn secondary" data-action="detail" data-id="${t.id}">${t.status==='done'?'Посмотреть работу':admin()&&t.status==='submitted'?'Проверить':'Открыть'} ${icon('arrow')}</button></div></article>`).join('')}</div>`;
}
function bindSearch(){if($('#search'))$('#search').addEventListener('input',e=>{search=e.target.value;$('#task-results').innerHTML=taskResults();});if($('#student-filter'))$('#student-filter').addEventListener('change',e=>{studentFilter=e.target.value;$('#task-results').innerHTML=taskResults();});}
function studentView(){return `<div class="heading"><div><div class="eyebrow">Вместе к результату</div><h1>Мои ученики</h1><p>${students.filter(s=>s.active).length} активных учеников · Индивидуальная история каждого</p></div><button class="btn" data-action="new-student">${icon('plus')} Добавить ученика</button></div>${students.length?`<div class="student-grid">${students.map(s=>{const mine=tasks.filter(t=>t.student_id===s.id);return `<article class="student"><div class="student-head"><span class="avatar">${esc(initials(s.name))}</span><div><h3>${esc(s.name)}</h3><p class="small muted">${esc(s.login)}${s.active?'':' · Доступ приостановлен'}</p></div></div><div class="student-meta"><span><strong>${mine.length}</strong> заданий</span><span><strong>${mine.filter(t=>t.status==='done').length}</strong> выполнено</span></div><div class="actions"><button class="btn secondary" data-action="student-tasks" data-id="${s.id}">Задания ${icon('arrow')}</button><button class="btn secondary" data-action="new-task" data-id="${s.id}">${icon('plus')} Задание</button><button class="btn ghost" data-action="student-settings" data-id="${s.id}" aria-label="Доступ: ${esc(s.name)}">${icon('key')}</button></div></article>`;}).join('')}</div>`:`<div class="empty">${icon('users')}<h3>Пригласи первого ученика</h3><p>Добавь имя и логин. Пароль для входа создадим автоматически.</p></div>`}`;}
function newStudent(){openModal('Новый ученик',`<form data-form="create_student">${field('Имя и фамилия','name','','text','required maxlength="80" autocomplete="off" placeholder="Например, Анна Смирнова"')}${field('Логин для входа','login','','text','required minlength="3" maxlength="64" pattern="[A-Za-z0-9._-]{3,64}" placeholder="anna.smirnova" autocomplete="off"')}<p class="small muted" style="margin-top:13px">Латинские буквы, цифры, точки и дефисы. Пароль будет создан после добавления.</p>${actions('Добавить ученика')}</form>`);}
function credentials(data){openModal('Данные для входа',`<p class="small muted" style="margin-bottom:17px">Передай ученику эти данные лично. Пароль показывается только сейчас.</p><div class="credentials"><strong>${esc(data.name)}</strong><br>Логин: <code>${esc(data.login)}</code><br>Пароль: <code>${esc(data.password)}</code></div><p class="small muted" style="margin-top:14px">Ученик сможет сменить пароль в своём кабинете.</p><div class="modal-actions"><button class="btn secondary" data-action="copy-credentials" data-login="${esc(data.login)}" data-password="${esc(data.password)}">Скопировать</button><button class="btn" data-action="close">Готово</button></div>`);}
function newTask(studentId='',task=null){
 if(!students.length){newStudent();toast('Сначала добавь ученика.');return;}
 const activeStudents=students.filter(s=>s.active||s.id===task?.student_id);
 if(!activeStudents.length){toast('Сначала возобнови доступ хотя бы одному ученику.');return;}
 openModal(task?'Редактировать задание':'Новое задание',`<form data-form="save_task">${task?`<input type="hidden" name="id" value="${task.id}">`:''}<label class="field">Ученик<select name="student_id" required ${task?'disabled':''}>${activeStudents.map(s=>`<option value="${s.id}" ${String(s.id)===String(task?.student_id||studentId)?'selected':''}>${esc(s.name)}</option>`).join('')}</select>${task?`<input type="hidden" name="student_id" value="${task.student_id}">`:''}</label>${field('Название задания','title',task?.title||'','text','required maxlength="125" placeholder="Например, Циклы и обработка чисел"')}${field('Предмет или тема','subject',task?.subject||'Информатика','text','required maxlength="50"')}${area('Условие задания','description',task?.description||'','required maxlength="10000" placeholder="Что нужно сделать? Добавь условие и пояснения."')}${field('Ссылка на материалы (необязательно)','resource_url',task?.resource_url||'','url','maxlength="2000" placeholder="https://…"')}<div class="form-row">${field('Срок (необязательно)','due_date',task?.due_date||'','date')}${field('Максимальный балл','max_score',task?.max_score||10,'number','required min="1" max="1000" step="1"')}</div>${inlineFiles('Файлы к заданию')}${actions(task?'Сохранить изменения':'Назначить задание')}</form>`);
}
const fileSize = bytes => bytes < 1024 ? bytes+' Б' : bytes < 1024*1024 ? (bytes/1024).toFixed(1)+' КБ' : (bytes/1024/1024).toFixed(1)+' МБ';
function attachmentSection(t,kind,editable,showUpload=true){
 const files=(t.attachments||[]).filter(f=>f.kind===kind);
 if(!files.length&&!editable)return '';
 return `<section class="detail-section"><h3>${kind==='material'?'Файлы к заданию':'Файлы решения'}</h3><ul class="attachment-list">${files.map(f=>`<li><div><a href="api.php?action=download&id=${f.id}" ${demo?'data-action="demo-download"':''}>${esc(f.name)}</a><span class="small muted">${fileSize(f.size)}</span></div>${editable?`<button type="button" class="btn ghost" data-action="remove-file" data-id="${f.id}" data-task="${t.id}" aria-label="Убрать файл ${esc(f.name)}">Убрать</button>`:''}</li>`).join('')}</ul>${editable&&showUpload?`<form data-form="upload"><input type="hidden" name="task_id" value="${t.id}"><input type="hidden" name="kind" value="${kind}"><label class="field">Прикрепить файлы<input type="file" name="files" accept=".xlsx,.xls,.csv,.txt" multiple required></label><p class="small muted">Excel, CSV или TXT · До 10 МБ каждый · До 20 файлов</p>${errorBox()}<button type="submit" class="btn secondary" style="margin-top:12px">Загрузить файлы</button><p class="small muted" role="status" data-upload-status></p></form>`:''}</section>`;
}
const uploadedSelections = new WeakMap();
function inlineFiles(label){return `<label class="field">${label} (необязательно)<input type="file" name="files" accept=".xlsx,.xls,.csv,.txt" multiple></label><p class="small muted">Excel, CSV или TXT · До 10 МБ каждый · До 20 файлов. Файлы загрузятся при сохранении.</p><p class="small muted" role="status" data-upload-status></p>`;}
function selectedFiles(form){return Array.from(form.elements.files?.files||[]);}
function validateFiles(files){
 if(files.length>20)throw new Error('Можно выбрать не более 20 файлов.');
 if(files.some(f=>f.size>10*1024*1024||! /\.(xlsx|xls|csv|txt)$/i.test(f.name)))throw new Error('Выбери файлы XLSX, XLS, CSV или TXT не больше 10 МБ каждый.');
 if(demo&&files.length)throw new Error('Загрузка доступна в настоящем кабинете. Демоверсия не хранит файлы.');
}
async function sendAttachment(id,kind,file){
 const body=new FormData();body.append('task_id',id);body.append('kind',kind);body.append('file',file);
 const response=await fetch('api.php?action=upload',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrf},body});
 let result;try{result=await response.json();}catch{throw new Error('Сервер отклонил файл. Проверь размер и лимиты загрузки PHP на хостинге.');}
 if(!response.ok)throw new Error(result.error||'Файл не загружен.');
}
async function uploadSelected(form,id,kind){
 const files=selectedFiles(form),done=uploadedSelections.get(form)||new Set();uploadedSelections.set(form,done);
 for(const file of files){
  if(done.has(file))continue;
  $('[data-upload-status]',form).textContent=`Загружаем: ${file.name}`;
  try{await sendAttachment(id,kind,file);done.add(file);}catch(e){
   $('[data-upload-status]',form).textContent='';
   throw new Error(`${e.message} Уже загруженные файлы сохранены. Нажми кнопку ещё раз, чтобы повторить оставшиеся. ${kind==='material'?'Задание уже сохранено; повторное нажатие не создаст копию.':'Решение пока не отправлено на проверку.'}`);
  }
 }
 $('[data-upload-status]',form).textContent=files.length?'Файлы загружены.':'';
}
function solutionDraft(){const f=$('[data-form="submit"],[data-form="review"]',modal);return f?{form:f.dataset.form,values:Object.fromEntries([...new FormData(f)].filter(([,value])=>typeof value==='string'))}:null;}
async function redrawDetail(id,draft){await refresh();detail(id);const f=draft?$(`[data-form="${draft.form}"]`,modal):null;if(f)for(const [name,value]of Object.entries(draft.values)){if(f.elements[name])f.elements[name].value=value;}}
async function uploadFiles(form){
 const files=Array.from(form.elements.files.files),id=Number(form.elements.task_id.value),kind=form.elements.kind.value;
 const error=$('.form-error',form),button=$('[type="submit"]',form);error.textContent='';
 if(files.some(f=>f.size>10*1024*1024||! /\.(xlsx|xls|csv|txt)$/i.test(f.name))){error.textContent='Выбери файлы XLSX, XLS, CSV или TXT не больше 10 МБ каждый.';return;}
 let uploaded=0;button.disabled=true;let failure='';
 try{for(const file of files){
  $('[data-upload-status]',form).textContent=`Загружаем ${uploaded+1} из ${files.length}: ${file.name}`;
  if(demo)throw new Error('Загрузка доступна в настоящем кабинете. Демоверсия не хранит файлы.');
  const body=new FormData();body.append('task_id',id);body.append('kind',kind);body.append('file',file);
  const response=await fetch('api.php?action=upload',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrf},body});
  let result;try{result=await response.json();}catch{throw new Error('Сервер отклонил файл. Проверь размер и лимиты загрузки PHP на хостинге.');}
  if(!response.ok)throw new Error(result.error||'Файл не загружен.');uploaded++;
 }}catch(e){failure=e.message;}finally{button.disabled=false;}
 if(uploaded){const draft=solutionDraft();await redrawDetail(id,draft);toast(`Загружено файлов: ${uploaded}`);}
 if(failure){const current=$(`[data-form="upload"] [name="kind"][value="${kind}"]`,modal)?.form||form;$('.form-error',current).textContent=failure+(uploaded?' Уже загруженные файлы сохранены. Повтори загрузку только оставшихся файлов.':'');}
 else $('[data-upload-status]',form).textContent='';
}
function detail(id){
 const t=tasks.find(t=>t.id===id);if(!t)return;
 const canSubmit=!admin()&&['assigned','revision'].includes(t.status);
 openModal(t.title,`<div class="detail-info">${badge(t)}<span class="subject">${esc(t.subject)}</span><span class="small muted">${t.due_date?'До '+date(t.due_date):'Без срока'}</span>${t.score!==null?`<strong class="small">${t.score} / ${t.max_score} баллов</strong>`:''}</div>${admin()?`<p class="small muted" style="margin-bottom:16px">Ученик: ${esc(t.student_name)}</p>`:''}<div class="detail-text">${esc(t.description)}</div>${t.resource_url?`<p style="margin-top:13px"><a href="${esc(t.resource_url)}" target="_blank" rel="noopener noreferrer">Открыть материалы ↗</a></p>`:''}${t.solution||t.solution_url?`<section class="detail-section"><h3>Решение ученика</h3><div class="detail-text">${esc(t.solution)}</div>${t.solution_url?`<p style="margin-top:12px"><a href="${esc(t.solution_url)}" target="_blank" rel="noopener noreferrer">Открыть решение ↗</a></p>`:''}<p class="small muted" style="margin-top:10px">Отправлено ${date(t.submitted_at)}</p></section>`:''}${t.feedback?`<section class="detail-section"><h3>Комментарий преподавателя</h3><div class="feedback detail-text">${esc(t.feedback)}</div></section>`:''}${attachmentSection(t,'material',admin())}${attachmentSection(t,'solution',canSubmit,false)}${canSubmit?`<section class="detail-section"><h3>${t.status==='revision'?'Доработать решение':'Твоё решение'}</h3><form data-form="submit"><input type="hidden" name="id" value="${t.id}">${area('Ответ и ход решения','solution',t.solution,'maxlength="15000" placeholder="Напиши ответ, вставь код или объясни ход решения…"')}${field('Ссылка на решение (необязательно)','solution_url',t.solution_url,'url','maxlength="2000" placeholder="https://…"')}<p class="small muted" style="margin-top:10px">Если решение по ссылке, проверь, что преподаватель сможет его открыть.</p>${inlineFiles('Файлы решения')}${actions('Отправить на проверку')}</form></section>`:''}${admin()?`<section class="detail-section"><h3>Проверка работы</h3><form data-form="review"><input type="hidden" name="id" value="${t.id}"><div class="form-row"><label class="field">Результат<select name="status"><option value="done" ${t.status==='done'?'selected':''}>Выполнено</option><option value="revision" ${t.status==='revision'?'selected':''}>Вернуть на доработку</option></select></label>${field('Балл из '+t.max_score+' (необязательно)','score',t.score??'','number',`min="0" max="${t.max_score}" step="1"`)}</div>${area('Комментарий ученику','feedback',t.feedback,'maxlength="10000" placeholder="Что получилось? На что обратить внимание?"')}${actions('Сохранить результат')}</form><div class="modal-actions"><button class="btn secondary" data-action="edit-task" data-id="${t.id}">${icon('edit')} Изменить условие</button><button class="btn danger" data-action="confirm-delete-task" data-id="${t.id}">Удалить задание</button></div></section>`:''}${!canSubmit&&!admin()?`<div class="modal-actions"><button class="btn secondary" data-action="close">Закрыть</button></div>`:''}`);
}
function studentSettings(id){const s=students.find(s=>s.id===id);if(!s)return;openModal('Доступ ученика',`<p><strong>${esc(s.name)}</strong><br><span class="muted small">Логин: ${esc(s.login)}</span></p><p class="small muted" style="margin-top:18px">Новый пароль завершит прежние сеансы ученика. Приостановка доступа сохранит все его задания и решения.</p><div class="modal-actions"><button class="btn secondary" data-action="confirm-reset" data-id="${id}">Новый пароль</button><button class="btn ${s.active?'danger':''}" data-action="confirm-access" data-id="${id}">${s.active?'Приостановить доступ':'Возобновить доступ'}</button><button class="btn danger" data-action="confirm-delete-student" data-id="${id}">Удалить ученика</button></div>`);}
function passwordDialog(){openModal('Сменить пароль',`<form data-form="change_password">${field('Текущий пароль','old_password','','password','required maxlength="72" autocomplete="current-password"')}${field('Новый пароль','password','','password','required minlength="6" maxlength="72" autocomplete="new-password"')}${field('Повтори новый пароль','confirmation','','password','required minlength="6" maxlength="72" autocomplete="new-password"')}<p class="small muted" style="margin-top:15px">Не менее 6 символов. Остальные сеансы будут завершены.</p>${actions('Сменить пароль')}</form>`);}

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-action]');if(!button)return;
 const action=button.dataset.action,id=Number(button.dataset.id);
 if(action==='demo-download'){event.preventDefault();toast('Файлы доступны в настоящем кабинете.');return;}
 try{
  if(action==='remove-file'){const taskId=Number(button.dataset.task),draft=solutionDraft();button.disabled=true;try{await api('remove_attachment',{id});await redrawDetail(taskId,draft);toast('Файл убран из задания');}finally{button.disabled=false;}return;}
  if(action==='close')closeModal();
  if(action==='retry')start();
  if(action==='view'){view=button.dataset.value;filter='all';search='';studentFilter='';render();}
  if(action==='filter'){filter=button.dataset.value;render();}
  if(action==='new-student')newStudent();
  if(action==='new-task')newTask(id||'');
  if(action==='edit-task')newTask('',tasks.find(t=>t.id===id));
  if(action==='detail')detail(id);
  if(action==='student-settings')studentSettings(id);
  if(action==='student-tasks'){view='tasks';filter='all';search='';studentFilter=String(id);render();}
  if(action==='password')passwordDialog();
  if(action==='logout'){await api('logout',{});user=null;closeModal();view='tasks';filter='all';search='';studentFilter='';await start();}
  if(action==='demo-role'){demoUser=demoUser.role==='admin'?{...demoStudents[0]}:{id:1,name:'Слава',login:'teacher',role:'admin',active:1};view='tasks';filter='all';search='';studentFilter='';await refresh();}
  if(action==='copy-credentials'){
   const text=`Kourage\n${location.href.split('?')[0]}\nЛогин: ${button.dataset.login}\nПароль: ${button.dataset.password}`;
   try{await navigator.clipboard.writeText(text);toast('Данные скопированы');}catch{toast('Выдели логин и пароль в окне и скопируй вручную.');}
  }
  if(action==='confirm-reset'){const s=students.find(s=>s.id===id);openModal('Создать новый пароль?',`<p>Прежний пароль ученика ${esc(s.name)} перестанет работать. Его текущие сеансы будут завершены.</p><form data-form="reset_password"><input type="hidden" name="id" value="${id}">${actions('Создать новый пароль')}</form>`);}
  if(action==='confirm-access'){const s=students.find(s=>s.id===id);openModal(s.active?'Приостановить доступ?':'Возобновить доступ?',`<p>${esc(s.name)} ${s.active?'не сможет войти в кабинет, пока ты не возобновишь доступ. Все работы сохранятся.':'снова сможет войти со своим паролем.'}</p><form data-form="student_access"><input type="hidden" name="id" value="${id}"><input type="hidden" name="active" value="${s.active?'false':'true'}">${actions('Подтвердить')}</form>`);}
  if(action==='confirm-delete-task'){const t=tasks.find(t=>t.id===id);if(t)openModal('Удалить задание?',`<p>Задание <strong>${esc(t.title)}</strong> исчезнет из кабинетов преподавателя и ученика. Решение, проверка и файлы сохранятся в архиве.</p><form data-form="delete_task"><input type="hidden" name="id" value="${id}">${actions('Удалить задание',true)}</form>`);}
  if(action==='confirm-delete-student'){const s=students.find(s=>s.id===id),count=tasks.filter(t=>t.student_id===id).length;if(s)openModal('Удалить ученика?',`<p><strong>${esc(s.name)}</strong> и ${count} ${count===1?'задание':count>1&&count<5?'задания':'заданий'} исчезнут из кабинета. Вход ученика будет закрыт, а его работы и файлы сохранятся в архиве.</p><form data-form="delete_student"><input type="hidden" name="id" value="${id}">${actions('Удалить ученика',true)}</form>`);}
 }catch(e){toast(e.message);}
});
document.addEventListener('submit',async event=>{
 const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();
 if(form.dataset.form==='upload'){try{await uploadFiles(form);}catch(e){toast(e.message);}return;}
 const action=form.dataset.form,data=Object.fromEntries([...new FormData(form)].filter(([,value])=>typeof value==='string'));
 if(action==='save_task'&&form.dataset.savedTaskId)data.id=form.dataset.savedTaskId;
 const button=$('[type="submit"]',form),error=$('.form-error',form);error.textContent='';
 if(action==='change_password'&&data.password!==data.confirmation){error.textContent='Пароли не совпадают.';return;}
 if(action==='student_access')data.active=data.active==='true';
 button.disabled=true;
 try{
  if(action==='save_task'||action==='submit')validateFiles(selectedFiles(form));
  if(action==='submit')await uploadSelected(form,Number(data.id),'solution');
  const result=await api(action,data);
  if(action==='save_task'){form.dataset.savedTaskId=String(result.id);await uploadSelected(form,Number(result.id),'material');}
  if(action==='login'||action==='setup'){user=result.user;await refresh();}
  else if(action==='create_student'||action==='reset_password'){await refresh();credentials(result);}
  else if(action==='save_task'){await refresh();detail(Number(result.id));toast('Задание и файлы сохранены.');}
  else{if(action==='delete_student'&&studentFilter===String(data.id))studentFilter='';closeModal();await refresh();toast(action==='submit'?'Решение отправлено на проверку':action==='change_password'?'Пароль изменён':action==='delete_task'?'Задание удалено':action==='delete_student'?'Ученик удалён':'Изменения сохранены');}
 }catch(e){error.textContent=e.message;}finally{button.disabled=false;}
});

// Demonstration data exists only in this tab. Production always uses api.php.
const dayOffset=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().slice(0,10);};
let demoStudents=[{id:2,name:'Александр Морозов',login:'alex.morozov',role:'student',active:1},{id:3,name:'Анна Смирнова',login:'anna.smirnova',role:'student',active:1},{id:4,name:'Михаил Волков',login:'m.volkov',role:'student',active:1}];
let demoUser={...demoStudents[0]};
const base={resource_url:'',solution_url:'',feedback:'',solution:'',score:null,max_score:10,submitted_at:null,completed_at:null,created_at:dayOffset(-14),updated_at:dayOffset(0)};
let demoTasks=[
 {...base,id:1,student_id:2,student_name:demoStudents[0].name,title:'Циклы: от простого к сложному',subject:'Python · Циклы',description:'Напиши программу, которая принимает натуральное число N и находит сумму всех чётных чисел от 1 до N включительно. Реши задачу двумя способами: с помощью цикла for и цикла while. Объясни, почему результаты совпадают.',due_date:dayOffset(3),status:'assigned'},
 {...base,id:2,student_id:2,student_name:demoStudents[0].name,title:'Системы счисления',subject:'ЕГЭ · Задание 14',description:'Переведи число 173 из десятичной системы в двоичную и шестнадцатеричную. Покажи промежуточные вычисления и проверь результат обратным переводом.',due_date:dayOffset(1),status:'submitted',solution:'173 = 128 + 32 + 8 + 4 + 1.\nВ двоичной системе: 10101101.\nВ шестнадцатеричной: AD.\nПроверка: 10 × 16 + 13 = 173.',submitted_at:dayOffset(-1)},
 {...base,id:3,student_id:2,student_name:demoStudents[0].name,title:'Логические выражения и таблицы истинности',subject:'ЕГЭ · Задание 2',description:'Построй таблицу истинности для выражения (A ∧ B) ∨ ¬C. Укажи, при каких наборах значений выражение ложно.',due_date:dayOffset(-2),status:'done',score:9,solution:'Выражение ложно, когда C = 1 и хотя бы одна из переменных A, B равна 0.\nНаборы (A, B, C): (0, 0, 1), (0, 1, 1), (1, 0, 1).',feedback:'Все наборы найдены верно! В следующий раз приложи полную таблицу истинности — это поможет проверить, что ни один случай не пропущен.',submitted_at:dayOffset(-4),completed_at:dayOffset(-3)},
 {...base,id:4,student_id:2,student_name:demoStudents[0].name,title:'Строки и поиск подстрок',subject:'Python · Строки',description:'Найди количество вхождений строки «аа» в строку «аааа», включая пересекающиеся вхождения. Напиши универсальную функцию для такого поиска.',due_date:dayOffset(2),status:'revision',solution:'text = "аааа"\nprint(text.count("аа"))',feedback:'Метод count не учитывает пересекающиеся вхождения. Попробуй пройти по всем начальным позициям строки циклом. Для этого примера правильный ответ — 3.',submitted_at:dayOffset(-2)},
 {...base,id:5,student_id:2,student_name:demoStudents[0].name,title:'Первый алгоритм: сумма цифр',subject:'Python · Основы',description:'Напиши программу для вычисления суммы цифр натурального числа без преобразования в строку.',due_date:dayOffset(-7),status:'done',score:10,solution:'n = int(input())\ns = 0\nwhile n > 0:\n    s += n % 10\n    n //= 10\nprint(s)',feedback:'Отлично: решение корректное, переменные понятные. Ты уверенно используешь остаток от деления и целочисленное деление.',completed_at:dayOffset(-6),submitted_at:dayOffset(-7)},
 {...base,id:6,student_id:3,student_name:demoStudents[1].name,title:'Графы: подсчёт маршрутов',subject:'ЕГЭ · Задание 13',description:'Из A можно попасть в B и C, из B — в C и D, из C — в D. Найди число различных маршрутов из A в D. Нарисуй граф и перечисли маршруты.',due_date:dayOffset(4),status:'assigned'},
 {...base,id:7,student_id:4,student_name:demoStudents[2].name,title:'Списки и фильтрация данных',subject:'Python · Списки',description:'Из списка целых чисел выбери положительные числа, кратные трём. Сохрани их порядок.',due_date:dayOffset(2),status:'submitted',solution:'result = [x for x in numbers if x > 0 and x % 3 == 0]',submitted_at:dayOffset(-1)}
];
async function demoApi(action,data={}){
 if(action==='bootstrap')return {installed:true,user:demoUser,csrf:'demo'};
 if(action==='state')return {user:demoUser,students:demoUser.role==='admin'?demoStudents:[],tasks:demoTasks.filter(t=>demoUser.role==='admin'||t.student_id===demoUser.id)};
 if(action==='logout'){demoUser=null;return {ok:true};}
 if(action==='login'){demoUser={...demoStudents[0]};return {user:demoUser};}
 if(action==='change_password')return {ok:true};
 if(action==='create_student'){
  if(demoStudents.some(s=>s.login===data.login))throw new Error('Этот логин уже занят.');
  const s={id:Math.max(...demoStudents.map(s=>s.id))+1,name:data.name,login:data.login,role:'student',active:1};demoStudents.push(s);return {...s,password:'demo-only-2026'};
 }
 if(action==='reset_password')return {...demoStudents.find(s=>s.id===Number(data.id)),password:'demo-new-2026'};
 if(action==='student_access'){demoStudents.find(s=>s.id===Number(data.id)).active=data.active?1:0;return {ok:true};}
 if(action==='delete_task'){demoTasks=demoTasks.filter(t=>t.id!==Number(data.id));return {ok:true};}
 if(action==='delete_student'){const id=Number(data.id);demoStudents=demoStudents.filter(s=>s.id!==id);demoTasks=demoTasks.filter(t=>t.student_id!==id);return {ok:true};}
 if(action==='save_task'){
  for(const key of ['resource_url'])if(data[key]&&!/^https?:\/\//i.test(data[key]))throw new Error('Ссылка должна начинаться с http:// или https://.');
  const values={...data,student_id:Number(data.student_id),max_score:Number(data.max_score),student_name:demoStudents.find(s=>s.id===Number(data.student_id)).name};
  if(data.id){const t=demoTasks.find(t=>t.id===Number(data.id));Object.assign(t,values,{id:t.id});}else demoTasks.unshift({...base,...values,id:Math.max(...demoTasks.map(t=>t.id))+1,status:'assigned'});return {id:data.id?Number(data.id):demoTasks[0].id};
 }
 const task=demoTasks.find(t=>t.id===Number(data.id));
 if(action==='submit'){
  if(!data.solution.trim()&&!data.solution_url.trim())throw new Error('Добавь текст решения или ссылку.');
  if(data.solution_url&&!/^https?:\/\//i.test(data.solution_url))throw new Error('Ссылка должна начинаться с http:// или https://.');
  Object.assign(task,{solution:data.solution,solution_url:data.solution_url,status:'submitted',score:null,submitted_at:dayOffset(0)});return {ok:true};
 }
 if(action==='review'){
  if(data.status==='revision'&&!data.feedback.trim())throw new Error('Напиши, что нужно исправить.');
  Object.assign(task,{status:data.status,feedback:data.feedback,score:data.status==='done'&&data.score!==''?Number(data.score):null,completed_at:data.status==='done'?dayOffset(0):null});return {ok:true};
 }
 throw new Error('Действие недоступно в демоверсии.');
}
start();
