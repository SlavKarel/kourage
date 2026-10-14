(()=>{
  const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
  if(!supported)return;
  let state=null,registration=null,banner=null;
  const decode=value=>{const padding='='.repeat((4-value.length%4)%4),raw=atob((value+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,char=>char.charCodeAt(0));};
  const post=async(action,data)=>{const response=await fetch(`/api.php?action=${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(data),credentials:'same-origin'});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Не удалось включить уведомления.');return result;};
  const subscriptionData=subscription=>{const json=subscription.toJSON();return {endpoint:json.endpoint,p256dh:json.keys?.p256dh||'',auth:json.keys?.auth||''};};
  const removeBanner=()=>{banner?.remove();banner=null;};
  const message=text=>{if(!banner)return;const label=banner.querySelector('[data-push-label]');if(label)label.textContent=text;};
  async function syncSubscription(subscription){await post('push_subscribe',subscriptionData(subscription));}
  async function subscribe(){
    const button=banner?.querySelector('button');if(button)button.disabled=true;message('Включаем уведомления…');
    try{
      const permission=await Notification.requestPermission();
      if(permission!=='granted'){message('Уведомления выключены в настройках браузера');if(button)button.disabled=false;return;}
      let subscription=await registration.pushManager.getSubscription();
      if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decode(state.public_key)});
      await syncSubscription(subscription);message('Уведомления включены');setTimeout(removeBanner,1300);
    }catch(error){message(error?.message||'Не удалось включить уведомления');if(button)button.disabled=false;}
  }
  function showBanner(){
    if(banner||Notification.permission==='denied')return;
    banner=document.createElement('div');banner.className='push-opt-in';banner.innerHTML='<span class="push-opt-in-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></span><span data-push-label>Получать уведомления о ДЗ и занятиях</span><button type="button">Включить</button><button class="push-opt-in-close" type="button" aria-label="Закрыть">×</button>';
    banner.querySelector('button:not(.push-opt-in-close)').addEventListener('click',subscribe);
    banner.querySelector('.push-opt-in-close').addEventListener('click',removeBanner);
    document.body.append(banner);
  }
  async function start(){
    try{
      const response=await fetch('/api.php?action=push_state',{credentials:'same-origin',cache:'no-store'});if(!response.ok)return;
      state=await response.json();if(!state.supported||!state.public_key)return;
      registration=await navigator.serviceWorker.register('/service-worker.js',{scope:'/'});
      await navigator.serviceWorker.ready;
      const existing=await registration.pushManager.getSubscription();
      if(existing&&Notification.permission==='granted'){await syncSubscription(existing);return;}
      showBanner();
    }catch(error){console.warn('Kourage notifications:',error);}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
