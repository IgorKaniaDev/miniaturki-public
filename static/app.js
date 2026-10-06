const $ = id => document.getElementById(id);
let products = [], catalog, current, page = 0, busy = false, previewVersion = 0, previewUrl, previewTimer, previewController, crop;
const pageSize = 12;
const labels = {needs:'Wybierz zdjęcia',ready:'Gotowy do generowania',queued:'W kolejce',processing:'Przetwarzanie…',done:'Zakończony',error:'Wymaga uwagi'};
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notify(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => $('notice').hidden = true, 6500); }
async function api(url, options) { const r = await fetch(url,options); if(!r.ok) { let error; try {error = (await r.json()).error;} catch {} throw Error(error || 'Nie udało się połączyć z aplikacją.'); } return r; }
function imageUrl(p,i) {return `/api/image?catalog=${catalog}&id=${p.id}&index=${i}`;}
const requiredPicks=p=>p.mode==='single'?1:2;
const isReady=p=>p && p.picks.length===requiredPicks(p);
function filtered() {const term = $('search').value.toLocaleLowerCase(); const filter = $('filter').value; return products.filter(p => `${p.name} ${p.id} ${p.brand}`.toLocaleLowerCase().includes(term) && (filter === 'all' || (filter === 'selected' ? p.selected : p.status === filter)));}
function render() {
 const list = filtered(); page = Math.min(page,Math.max(0,Math.ceil(list.length/pageSize)-1));
 $('cards').innerHTML = list.slice(page*pageSize,(page+1)*pageSize).map(p => `<article class="card ${current===p?'current':''}" data-id="${p.id}" tabindex="0" role="button" aria-label="Wybierz ujęcia: ${esc(p.name)}"><input class="card-check" type="checkbox" aria-label="Dodaj produkt ${p.id} do partii" ${p.selected?'checked':''} ${busy?'disabled':''}><div class="card-image">${p.count?`<img loading="lazy" src="${imageUrl(p,0)}" alt="${esc(p.name)}">`:'Brak zdjęć'}</div><div class="card-body"><small>#${p.id} · ${p.count} zdjęć</small><h3>${esc(p.name)}</h3><span class="status ${p.status}" title="${esc(p.error || '')}">${labels[p.status]}</span></div></article>`).join('') || '<p class="empty">Brak produktów pasujących do filtrów.</p>';
 $('cards').querySelectorAll('img').forEach(img => img.onerror = () => { img.parentElement.textContent = 'Nie udało się wczytać zdjęcia'; });
 $('cards').querySelectorAll('.card').forEach(card => {
  const p = products.find(p => p.id===card.dataset.id);
  card.onclick = e => {if(e.target.type==='checkbox'){p.selected=e.target.checked;updateBatch();return;} openProduct(p);};
  card.onkeydown = e => {if(e.target===card && ['Enter',' '].includes(e.key)){e.preventDefault();openProduct(p);}};
 });
 $('pageLabel').textContent = `${list.length} produktów · strona ${page+1} / ${Math.max(1,Math.ceil(list.length/pageSize))}`;
 $('prev').disabled = page===0; $('next').disabled = (page+1)*pageSize>=list.length;
 updateBatch();
}
function updateBatch() {
 const selected = products.filter(p=>p.selected), ready = selected.filter(isReady);
 if(!busy) $('batchInfo').textContent = `${selected.length} zaznaczonych · ${ready.length} z wybranymi ujęciami${selected.length>ready.length?' · uzupełnij brakujące zdjęcia':''}`;
 $('generate').disabled = busy || !selected.length || ready.length!==selected.length;
 $('generate').textContent = busy ? 'Trwa generowanie…' : `Wygeneruj partię (${selected.length}) →`;
}
function resetPreview() { previewVersion++; clearTimeout(previewTimer); previewController?.abort(); $('previewStage').setAttribute('aria-busy','false'); if(previewUrl){URL.revokeObjectURL(previewUrl); previewUrl=null;} $('preview').hidden=true; $('previewHint').hidden=false; $('previewHint').textContent=`Wybierz ${current?.mode==='single'?'zdjęcie':'dwa ujęcia'} — podgląd pojawi się automatycznie`; document.querySelectorAll('.frame-trigger').forEach(b=>b.hidden=true); }
function openProduct(p) { if(busy) return; finishCrop(); current=p; resetPreview(); $('editorName').textContent=p.name; $('editorId').textContent='#'+p.id; $('editorHint').textContent=p.error || (p.count<requiredPicks(p)?'Ten produkt ma za mało zdjęć dla wybranego układu.':`Wybierz ${p.mode==='single'?'jedno zdjęcie':'dwa ujęcia'} do miniaturki.`); renderPhotos();render();schedulePreview(); }
function renderPhotos() {
 $('photos').innerHTML = current ? Array.from({length:current.count},(_,i)=>`<button class="photo ${current.picks.includes(i)?'chosen':''}" data-index="${i}" aria-label="Zdjęcie ${i+1}" aria-pressed="${current.picks.includes(i)}" ${busy?'disabled':''}><img src="${imageUrl(current,i)}" alt="Ujęcie ${i+1}">${current.picks.includes(i)?`<b>${current.picks.indexOf(i)+1}</b>`:''}</button>`).join('') : '';
 $('photos').querySelectorAll('button').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.index); if(current.picks.includes(i)) current.picks=current.picks.filter(x=>x!==i); else if(current.mode==='single')current.picks=[i]; else if(current.picks.length<2) current.picks.push(i); else return notify('Odznacz jedno z wybranych zdjęć, aby zmienić ujęcie.'); current.selected=true;current.status=isReady(current)?'ready':'needs';current.error='';renderPhotos();render();schedulePreview();});
 $('modeChoice').disabled=busy || !current;
 document.querySelectorAll('input[name="photoMode"]').forEach(input=>input.checked=current?.mode===input.value);
 $('photoHelp').textContent=current?.mode==='single'?'Wybierz jedno zdjęcie. Kliknij je w podglądzie, aby ustawić pozycję i powiększenie.':'Kliknij dwa różne zdjęcia w kolejności: lewe, prawe. Kliknij ponownie, aby odznaczyć. Kliknij zdjęcie w podglądzie, aby ustawić jego kadr.';
 $('makePreview').disabled=busy || !isReady(current);
 $('swapPhotos').hidden=current?.mode==='single';
 $('swapPhotos').disabled=busy || !isReady(current) || current.mode==='single';
 $('removeBg').disabled=busy || !current;
 $('removeBg').checked=current?.removeBg ?? true;
}
function payload(items) {return {catalog,items:items.map(p=>({id:p.id,mode:p.mode,images:[...p.picks],removeBg:p.removeBg,frames:p.picks.map(i=>p.frames?.[p.mode]?.[i] || {x:.5,y:.5,zoom:1})}))};}
function post(body) {return {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};}
async function importFile(file) {
 if(busy) return;
 if(file && file.size>40*1024*1024) return notify('Maksymalny rozmiar XML to 40 MB.');
 setBusy(true); $('sample').textContent='Wczytywanie…';
 try {const r=await api(file?'/api/import':'/api/sample',file?{method:'POST',body:file}:undefined); const data=await r.json(); catalog=data.catalog;products=data.products.map(p=>({...p,mode:p.count===1?'single':'double',picks:[],savedPicks:{single:[],double:[]},frames:{single:{},double:{}},removeBg:true,selected:false,status:'needs'}));current=null;page=0;$('search').value='';$('filter').value='all';resetPreview();$('editorName').textContent='Wybierz produkt';$('editorId').textContent='';$('photos').innerHTML='';$('editorHint').textContent='Kliknij kartę produktu, aby wybrać układ i zdjęcia.';$('welcome').hidden=true;$('workspace').hidden=false;$('batch').hidden=false;$('count').textContent=products.length;$('filename').textContent=file?.name || 'Eksport z folderu projektu';$('step2').classList.add('active');$('step3').classList.remove('active');$('download').hidden=true;$('progress').hidden=true;$('batchTitle').textContent='Twoja partia';notify(`Wczytano ${products.length} produktów.`);
 } catch(e) {notify('Import: '+e.message);} finally {setBusy(false);$('sample').textContent='Użyj własnego XML z folderu projektu →';renderPhotos();render();$('file').value='';}
}
function setBusy(value) {busy=value;if(value){finishCrop();resetPreview();}['file','sample','selectAll','clear','removeBg'].forEach(id=>$(id).disabled=value);renderPhotos();updateBatch();}
$('file').onchange=e=>{if(e.target.files[0])importFile(e.target.files[0]);};
$('sample').onclick=()=>importFile();
$('search').oninput=$('filter').onchange=()=>{page=0;render();};
$('prev').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};
$('selectAll').onclick=()=>{filtered().forEach(p=>p.selected=true);render();};$('clear').onclick=()=>{products.forEach(p=>p.selected=false);render();};
function editComposition() {
 current.status=isReady(current)?'ready':'needs';current.error='';
 renderPhotos();render();schedulePreview();
}
$('removeBg').onchange=()=>{if(!current || busy)return;current.removeBg=$('removeBg').checked;editComposition();};
$('swapPhotos').onclick=()=>{if(!current || busy || current.mode==='single' || !isReady(current))return;current.picks.reverse();editComposition();};
document.querySelectorAll('input[name="photoMode"]').forEach(input=>input.onchange=()=>{
 if(!current || busy || !input.checked || current.mode===input.value)return;
 finishCrop(false);
 const previous=[...current.picks];current.savedPicks[current.mode]=previous;
 current.mode=input.value;
 current.picks=[...current.savedPicks[current.mode]];
 if(!current.picks.length && previous.length)current.picks=[previous[0]];
 $('editorHint').textContent=current.count<requiredPicks(current)?'Ten produkt ma za mało zdjęć dla wybranego układu.':`Wybierz ${current.mode==='single'?'jedno zdjęcie':'dwa ujęcia'} do miniaturki.`;
 editComposition();
});
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function cropGeometry() {
 const box=$('cropFrame').getBoundingClientRect(), im=crop.image;
 const scale=Math.min(box.width/im.naturalWidth,box.height/im.naturalHeight)*crop.frame.zoom;
 return {width:im.naturalWidth*scale,height:im.naturalHeight*scale,box};
}
function paintCrop() {
 if(!crop?.image?.naturalWidth)return;
 const {width,height,box}=cropGeometry(), frame=crop.frame, image=$('cropImage');
 image.style.width=`${width}px`;image.style.height=`${height}px`;
 image.style.left=`${width<=box.width?(box.width-width)*frame.x:-(width-box.width)*frame.x}px`;
 image.style.top=`${height<=box.height?(box.height-height)*frame.y:-(height-box.height)*frame.y}px`;
}
function finishCrop(refresh=true) {
 if(!crop)return;
 const active=crop;crop=null;
 $('cropFrame').hidden=true;$('cropControls').hidden=true;
 if(active.image?.naturalWidth && active.product===current) {
  current.frames ||= {};current.frames[active.mode] ||= {};current.frames[active.mode][active.index]={...active.frame};if(refresh)schedulePreview();
 }
}
function startCrop(slot) {
 if(!current || busy || !isReady(current) || $('preview').hidden)return;
 finishCrop(false);
 const index=current.picks[slot], saved=current.frames?.[current.mode]?.[index] || {x:.5,y:.5,zoom:1};
 crop={slot,index,mode:current.mode,product:current,frame:{...saved},image:null};
 $('cropFrame').className=`crop-frame ${current.mode==='single'?'single':slot?'right':'left'}`;
 $('cropFrame').hidden=false;$('cropControls').hidden=false;
 $('cropImage').removeAttribute('src');$('cropZoom').disabled=true;$('cropDone').disabled=true;
 const image=new Image();crop.image=image;
 image.onload=()=>{
  if(!crop || crop.image!==image)return;
  $('cropImage').src=image.src;
  const box=$('cropFrame').getBoundingClientRect();
  const cover=Math.max(box.width/image.naturalWidth,box.height/image.naturalHeight)/Math.min(box.width/image.naturalWidth,box.height/image.naturalHeight);
  const minimum=current.mode==='single'?1:cover;
  crop.frame.zoom=Math.max(crop.frame.zoom,minimum);
  $('cropZoom').min=String(minimum);$('cropZoom').max=String(Math.max(4,Math.ceil(cover*1.5)));
  $('cropZoom').value=String(crop.frame.zoom);
  $('cropZoom').disabled=false;$('cropDone').disabled=false;
  paintCrop();
 };
 image.onerror=()=>{if(crop?.image===image){crop=null;$('cropFrame').hidden=true;$('cropControls').hidden=true;notify('Nie udało się wczytać zdjęcia do edycji kadru.');}};
 image.src=`/api/prepared-image?catalog=${encodeURIComponent(catalog)}&id=${encodeURIComponent(current.id)}&index=${index}&removeBg=${current.removeBg}`;
}
document.querySelectorAll('.frame-trigger').forEach(button=>button.onclick=()=>startCrop(Number(button.dataset.slot)));
$('cropDone').onclick=finishCrop;
$('cropZoom').oninput=e=>{if(crop?.image?.naturalWidth){crop.frame.zoom=Number(e.target.value);paintCrop();}};
let drag;
$('cropFrame').onpointerdown=e=>{if(!crop?.image?.naturalWidth)return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY,frame:{...crop.frame}};$('cropFrame').setPointerCapture(e.pointerId);};
$('cropFrame').onpointermove=e=>{
 if(!drag || e.pointerId!==drag.id || !crop)return;
 const {width,height,box}=cropGeometry();
 crop.frame.x=width>box.width?clamp(drag.frame.x-(e.clientX-drag.x)/(width-box.width),0,1):width<box.width?clamp(drag.frame.x+(e.clientX-drag.x)/(box.width-width),0,1):.5;
 crop.frame.y=height>box.height?clamp(drag.frame.y-(e.clientY-drag.y)/(height-box.height),0,1):height<box.height?clamp(drag.frame.y+(e.clientY-drag.y)/(box.height-height),0,1):.5;
 paintCrop();
};
$('cropFrame').onpointerup=$('cropFrame').onpointercancel=()=>{drag=null;};
document.addEventListener('pointerdown',e=>{if(crop && !$('cropFrame').contains(e.target) && !$('cropControls').contains(e.target))finishCrop(!e.target.closest('.frame-trigger'));},true);
new ResizeObserver(()=>{if(crop)paintCrop();}).observe($('cropFrame'));
function schedulePreview() {
 resetPreview();
 if(busy || !isReady(current))return;
 $('previewHint').textContent='Przygotowuję podgląd…';
 previewTimer=setTimeout(makePreview,300);
}
async function makePreview() {
 if(busy || !isReady(current))return;
 resetPreview();
 const version=previewVersion, body=payload([current]);
 const controller=new AbortController();previewController=controller;
 $('makePreview').disabled=true;
 $('previewStage').setAttribute('aria-busy','true');
 $('previewHint').textContent='Przygotowuję podgląd…';
 try {
  const r=await api('/api/preview',{...post(body),signal:controller.signal});
  const blob=await r.blob();if(version!==previewVersion)return;
  previewUrl=URL.createObjectURL(blob);$('preview').src=previewUrl;
  // Keep the loading state until the new bitmap is ready to paint.
  await $('preview').decode();if(version!==previewVersion)return;
  $('preview').hidden=false;$('previewHint').hidden=true;
  const left=document.querySelector('.frame-trigger.left'),right=document.querySelector('.frame-trigger.right');
  left.classList.toggle('single',current.mode==='single');left.setAttribute('aria-label',current.mode==='single'?'Ustaw kadr zdjęcia':'Ustaw kadr lewego zdjęcia');
  left.hidden=false;right.hidden=current.mode==='single';
 } catch(e) {
  if(version===previewVersion && e.name!=='AbortError') {
   $('previewHint').textContent='Nie udało się przygotować podglądu. Kliknij „Odśwież podgląd”.';notify(e.message);
  }
 } finally {
  if(version===previewVersion){$('makePreview').disabled=busy;$('previewStage').setAttribute('aria-busy','false');}
 }
}
$('makePreview').onclick=makePreview;
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
$('generate').onclick=async()=>{
 const items=products.filter(p=>p.selected);if(!items.length||items.some(p=>!isReady(p)))return;
 setBusy(true);render();$('download').hidden=true;$('progress').hidden=false;$('progress').value=0;$('progress').max=items.length;$('step3').classList.add('active');
 let jobId;
 try {
  const start=await (await api('/api/generate',post(payload(items)))).json();jobId=start.id;
  while(true){
   let job;
   try{job=await (await api('/api/jobs/'+jobId)).json();}catch(e){$('batchInfo').textContent='Utracono połączenie. Ponawiam sprawdzanie partii…';await delay(3000);continue;}
   Object.entries(job.products).forEach(([id,result])=>{const p=products.find(p=>p.id===id);p.status=result.status;p.error=result.message||'';});
   $('progress').value=job.finished;$('batchInfo').textContent=`Przetworzono ${job.finished} z ${job.total} produktów`;render();
   if(job.status==='error')throw Error(job.message);
   if(job.status==='done'){const done=items.filter(p=>p.status==='done').length;const failed=items.length-done;$('batchTitle').textContent=failed?`Gotowe: ${done} · wymaga uwagi: ${failed}`:`Partia gotowa. ${done} miniaturek!`;$('download').href='/download/'+jobId;$('download').download='miniaturki.zip';$('download').hidden=!done;notify(failed?'Część produktów wymaga uwagi. Kliknij kartę z błędem.':'Gotowe! Pobierz ZIP lub otwórz folder output.');break;}
   await delay(900);
  }
 }catch(e){notify(e.message);}finally{setBusy(false);render();}
};
const drop=$('welcome');drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag');};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');if(e.dataTransfer.files[0])importFile(e.dataTransfer.files[0]);};
