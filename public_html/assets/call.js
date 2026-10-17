'use strict';
const app=document.querySelector('#call-app'),meetingId=Number(new URLSearchParams(location.search).get('id'));
let csrf='';
const esc=value=>String(value??'').replace(/[&<>\"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
async function request(action,data){const response=await fetch(`api.php?action=${action}`,{method:data?'POST':'GET',credentials:'same-origin',headers:data?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:data?JSON.stringify(data):undefined});const result=await response.json().catch(()=>({error:'Сервер не ответил.'}));if(!response.ok)throw new Error(result.error||'Не удалось открыть звонок.');if(result.csrf)csrf=result.csrf;return result;}
function showError(message){app.className='call-loading';app.innerHTML=`<div class="call-status call-error"><div class="brand"><img src="assets/favicon.svg" alt="">kourage<span>.</span></div><h1>Не удалось открыть звонок</h1><p>${esc(message)}</p><a class="btn" href="meeting.html">Вернуться к звонкам</a></div>`;}
async function start(){try{if(!meetingId)throw new Error('Некорректная ссылка на звонок.');const state=await request('meeting_state');csrf=state.csrf;const meeting=await request('meeting_join',{id:meetingId});location.replace(`https://meet.jit.si/${encodeURIComponent(meeting.room_name)}`);}catch(error){showError(error.message);}}
start();
