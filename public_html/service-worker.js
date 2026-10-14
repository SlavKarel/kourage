self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data={title:'Kourage',body:'У тебя новое уведомление.',url:'/',tag:'kourage'};
  try{if(event.data)data={...data,...event.data.json()};}catch(error){if(event.data)data.body=event.data.text();}
  event.waitUntil(self.registration.showNotification(data.title,{body:data.body,tag:data.tag,icon:'/assets/icon-192.png?v=icon-2',badge:'/assets/favicon-32.png?v=icon-2',data:{url:data.url||'/'},vibrate:[120,60,120]}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    for(const client of clients){if(new URL(client.url).origin===self.location.origin){await client.focus();if('navigate' in client)await client.navigate(target);return;}}
    return self.clients.openWindow(target);
  }));
});
