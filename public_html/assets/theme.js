(()=>{
  const key='kourage-theme';
  let teacherEarlyAccess=false;
  const system=()=>matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  const stored=()=>{try{const value=localStorage.getItem(key);return value==='dark'||value==='light'?value:null;}catch{return null;}};
  const current=()=>document.documentElement.dataset.theme||'light';
  const apply=theme=>{
    const changed=document.documentElement.dataset.theme!==theme;
    document.documentElement.dataset.theme=theme;
    document.documentElement.style.colorScheme=theme;
    const color=document.querySelector('meta[name="theme-color"]');
    if(color)color.content=theme==='dark'?'#0d1420':'#2457e8';
    const button=document.querySelector('[data-theme-toggle]');
    if(button){
      const dark=theme==='dark';
      button.setAttribute('aria-label',dark?'Включить светлую тему':'Включить тёмную тему');
      button.title=dark?'Светлая тема':'Тёмная тема';
      if(button.dataset.themeIcon!==theme){
        button.dataset.themeIcon=theme;
        button.innerHTML=dark?'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8 8 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4Z"/></svg>';
      }
    }
    if(changed)window.dispatchEvent(new CustomEvent('kourage-theme',{detail:{theme}}));
  };
  const setUserRole=role=>{teacherEarlyAccess=role==='admin';schedule();};
  const mountEarlyAccess=()=>{
    let badge=document.querySelector('[data-early-access]');
    const loggedIn=document.querySelector('.shell,.homework-main');
    if(!teacherEarlyAccess||!loggedIn){badge?.remove();return;}
    if(!badge){
      badge=document.createElement('span');
      badge.className='early-access-badge';
      badge.dataset.earlyAccess='';
      badge.innerHTML='<span>●</span> Ранний доступ <b>Бесплатно</b>';
      badge.title='Сейчас все возможности Kourage доступны преподавателям бесплатно';
    }
    const target=document.querySelector('.topbar .right')||document.querySelector('.topbar')||document.querySelector('.homework-top')||document.body;
    if(badge.parentElement!==target)target.append(badge);
    badge.classList.toggle('early-access-floating',target===document.body);
  };
  apply(stored()||system());
  let scheduled=false;
  const mount=()=>{
    scheduled=false;
    let button=document.querySelector('[data-theme-toggle]');
    if(!button){
      button=document.createElement('button');
      button.type='button';button.className='theme-toggle';button.dataset.themeToggle='';
      button.addEventListener('click',()=>{const next=current()==='dark'?'light':'dark';try{localStorage.setItem(key,next);}catch{}apply(next);});
    }
    const topbar=document.querySelector('.topbar');
    let target=topbar?.querySelector('.right');
    if(topbar&&!target){target=document.createElement('div');target.className='right';topbar.append(target);}
    target=target||document.body;
    if(button.parentElement!==target)target.append(button);
    button.classList.toggle('theme-toggle-floating',!topbar);
    apply(current());
    mountEarlyAccess();
  };
  const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(mount);}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
  addEventListener('kourage-user',event=>setUserRole(event.detail?.role));
  fetch('api.php?action=bootstrap',{credentials:'same-origin',cache:'no-store'}).then(response=>response.ok?response.json():null).then(data=>setUserRole(data?.user?.role)).catch(()=>{});
  addEventListener('storage',event=>{if(event.key===key)apply(stored()||system());});
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(!stored())apply(system());});
})();
