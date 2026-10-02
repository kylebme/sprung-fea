export async function api(url:string,options:RequestInit={}){
 const response=await fetch('/api'+url,options);
 const data=await response.json();if(!response.ok)throw Error(data.error||'The request failed.');return data;
}
export const post=(url:string,body:unknown)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export async function saveFile(name:string,content:string,type='text'){
 if(window.desktop)return window.desktop.saveFile({name,content,type});
 const blob=type==='base64'?new Blob([Uint8Array.from(atob(content),c=>c.charCodeAt(0))]):new Blob([content],{type:'application/octet-stream'});
 const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;
}
