/* PDF Studio: all document bytes stay in this browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { bytes:null, pdf:null, previewPdf:null, previewRun:0, name:'', page:1, zoom:1, tool:'select', notes:[], committed:[], history:[], committedHistory:[], fonts:new Map(), nativeColors:new Map(), pending:false, selected:null, targets:[], ocr:[], ocrRun:0, busy:false, renderRun:0, renderTask:null };
  const canvas = $('pdfCanvas'), surface = $('pageSurface'), layer = $('annotationLayer');
  let mupdfPromise;
  const loadMupdf = () => mupdfPromise ||= (window.PDFStudioMuPDF?Promise.resolve(window.PDFStudioMuPDF):import('https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js')).catch(e=>{mupdfPromise=null;throw e;});
  async function rewriteNative(notes, source=state.bytes){
    const changes=notes.filter(n=>n.type==='correction'&&n.text!==n.originalText)
      .map(n=>({page:n.page,original:n.originalText,text:n.text,origin:n.origin}));
    if(!changes.length)return null;
    const mupdf=await loadMupdf();
    return window.PDFStudioStructural.edit(mupdf,source,changes);
  }
  async function rebuildPreview(notes=state.notes){
    const run=++state.previewRun;
    const bytes=await rewriteNative(notes);
    if(run!==state.previewRun)return false;
    const preview=bytes?await pdfjsLib.getDocument({data:bytes.slice()}).promise:null;
    if(run!==state.previewRun){await preview?.destroy?.();return false;}
    const previous=state.previewPdf;
    state.previewPdf=preview;
    try{await render();}
    finally{await previous?.destroy?.();}
    return run===state.previewRun;
  }
  function refreshPreview(){
    return rebuildPreview().catch(error=>{console.error(error);toast(error.message||'Não foi possível atualizar a prévia do PDF.');});
  }
  const toast = message => { const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),3500); };
  const clone = notes => notes.map(n=>({...n}));
  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
  const rgbHex = (r,g,b) => '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
  const rgbColor = hex => PDFLib.rgb(parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255);
  const contrast = (a,b) => Math.abs(.2126*(a[0]-b[0])+.7152*(a[1]-b[1])+.0722*(a[2]-b[2]));
  function sampleStyle(x,y,w=0,h=0){
    const ctx=canvas.getContext('2d',{willReadFrequently:true}),W=canvas.width,H=canvas.height;
    const at=(nx,ny)=>{const px=clamp(Math.floor(nx*W),0,W-1),py=clamp(Math.floor(ny*H),0,H-1);return [...ctx.getImageData(px,py,1,1).data].slice(0,3);};
    const bgSamples=[];
    for(let i=0;i<8;i++){
      const t=(i+.5)/8;
      bgSamples.push(at(x+w*t,y-.004),at(x+w*t,y+h+.004));
    }
    const groups=new Map();
    for(const p of bgSamples){const key=p.map(v=>Math.round(v/24)).join(',');const g=groups.get(key)||{count:0,colors:[]};g.count++;g.colors.push(p);groups.set(key,g);}
    const common=[...groups.values()].sort((a,b)=>b.count-a.count)[0];
    const bg=[0,1,2].map(i=>Math.round(common.colors.reduce((sum,p)=>sum+p[i],0)/common.count));
    let fg=null,score=0;
    for(let row=1;row<=5;row++)for(let col=1;col<=12;col++){
      const p=at(x+w*col/13,y+h*row/6),c=contrast(p,bg);
      if(c>score){score=c;fg=p;}
    }
    const dark=(.2126*bg[0]+.7152*bg[1]+.0722*bg[2])<125;
    return {bg:rgbHex(...bg),color:score>45?rgbHex(...fg):dark?'#ffffff':'#1c293d'};
  }
  async function originalTextColor(pageNumber,rects){
    if(!state.nativeColors.has(pageNumber)){
      const mupdf=await loadMupdf(),doc=mupdf.Document.openDocument(state.bytes,'application/pdf');
      const page=doc.loadPage(pageNumber-1),bounds=page.getBounds(),W=bounds[2]-bounds[0],H=bounds[3]-bounds[1],chars=[];
      page.toStructuredText().walk({onChar:(character,origin,font,size,quad,color)=>{
        if(!character.trim()||!Array.isArray(color)||color.length<3)return;
        const cx=(quad[0]+quad[2]+quad[4]+quad[6])/4,cy=(quad[1]+quad[3]+quad[5]+quad[7])/4;
        chars.push({x:(cx-bounds[0])/W,y:(cy-bounds[1])/H,color:rgbHex(...color.slice(0,3).map(c=>clamp(c*255,0,255)))});
      }});
      state.nativeColors.set(pageNumber,chars);
    }
    const counts=new Map();
    for(const c of state.nativeColors.get(pageNumber)){
      if(rects.some(r=>c.x>=r.x-.003&&c.x<=r.x+r.w+.003&&c.y>=r.y-.008&&c.y<=r.y+r.h+.008))counts.set(c.color,(counts.get(c.color)||0)+1);
    }
    return [...counts].sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  }
  function documentEdits(){
    return state.notes.filter(note=>note.type==='correction'?note.text!==note.originalText:note.type!=='text'||note.text.trim());
  }
  function sameEdits(a,b){
    return a.length===b.length&&a.every((note,i)=>{
      const keys=Object.keys(note);
      return keys.length===Object.keys(b[i]).length&&keys.every(key=>note[key]===b[i][key]);
    });
  }
  function setPending(){
    state.pending=!sameEdits(documentEdits(),state.committed);
    updateControls();refreshOcr();renderObjectList();
  }
  function remember(before){
    if(!sameEdits(before,documentEdits())){
      state.history.push(before);
      if(state.history.length>100)state.history.shift();
    }
    setPending();
  }
  function effectiveSize(note){
    let size=clamp(+note.size||18,6,96);
    return size;
  }
  function textForPage(pageIndex){
    const data=state.ocr[pageIndex];if(!data?.ready)return '';
    const replacement=key=>state.notes.find(n=>n.page===pageIndex+1&&n.type==='correction'&&n.sourceKey===key);
    const edited=state.notes.some(n=>n.page===pageIndex+1&&n.type==='correction'&&n.text!==n.originalText);
    if(data.nativeItems?.length&&(!data.scanned||edited))return data.nativeItems.map((t,i)=>replacement(`native-${i}`)?.text??t).join(' ').replace(/\s+/g,' ').trim();
    if(data.scanned&&data.words.length)return data.words.map((w,i)=>replacement(`scan-${i}`)?.text??w.text).join(' ').trim();
    return data.text;
  }
  function refreshOcr(){if(state.pdf)$('ocrText').value=textForPage(state.page-1);}
  function renderObjectList(){
    const inserted=state.notes.filter(note=>note.type!=='correction');
    const list=$('objectList');list.replaceChildren();$('objectPanel').classList.toggle('hidden',!state.pdf||inserted.length===0);
    inserted.forEach((note,index)=>{
      const row=document.createElement('div');row.className='object-row';
      const choose=document.createElement('button');choose.className='object-select'+(note.id===state.selected?' active':'');
      choose.textContent=`${note.type==='image'?'▧ Imagem':'T Texto'} ${index+1} · p. ${note.page}`;
      choose.onclick=async()=>{if(state.page!==note.page){state.page=note.page;await render();}select(note.id);};
      const remove=document.createElement('button');remove.className='object-remove';remove.title='Remover este elemento';remove.setAttribute('aria-label',`Remover ${choose.textContent}`);remove.textContent='✕';remove.onclick=()=>removeNote(note.id);
      row.append(choose,remove);list.append(row);
    });
  }
  function removeNote(id){
    if(state.busy)return;
    layer.querySelector('.inline-editor')?.blur();
    finishFieldEdit();
    const note=state.notes.find(n=>n.id===id);
    if(!note)return;
    const before=clone(documentEdits());
    if(note.type==='correction'){
      if(note.text==='')return;
      // Keep the source reference so preview and export write an empty string
      // to the same text operator. Only undo restores an earlier value.
      note.text='';
      select(null);renderNotes();remember(before);refreshPreview();
      toast('Texto apagado. Clique em Aplicar alterações para confirmar.');
      return;
    }
    state.notes=state.notes.filter(n=>n.id!==id);
    if(state.selected===id)select(null);
    renderNotes();remember(before);toast('Elemento removido. Clique em Aplicar alterações para confirmar.');
  }
  const setHint = s => $('workHint').textContent=s;
  const setStatus = s => $('ocrState').textContent=s;
  const showPanel = name => {
    ['intro','edit','ocr'].forEach(n=>$(n+'Panel').classList.toggle('hidden',n!==name));
    $('inspectorTitle').textContent=({intro:'Comece por aqui',edit:'Editar elemento',ocr:'Texto reconhecido'})[name];
  };
  const setTool = tool => {
    const data=state.ocr[state.page-1];
    if(tool==='correct'&&data?.scanned&&!data.nativeItems?.length){toast('Esta página é escaneada: não há texto original no PDF para editar.');return;}
    layer.querySelector('.inline-editor')?.blur();
    state.tool=tool;
    document.querySelectorAll('[data-tool]').forEach(el=>el.classList.toggle('active',el.dataset.tool===tool));
    layer.classList.toggle('tool-text',tool==='text');layer.classList.toggle('tool-correct',tool==='correct');
    if(tool==='text') setHint('Clique na página para inserir texto');
    else if(tool==='correct') setHint('Clique no texto para editar ou apagar');
    else if(tool==='image') setHint('Selecione uma imagem para inserir');
    else setHint(state.pdf?'Arraste textos e imagens para posicionar':'Abra um PDF para começar');
    if(state.pdf) renderNotes();
  };
  const updateControls = () => {
    const has=!!state.pdf, n=state.pdf?.numPages||0;
    $('pageCounter').textContent=has?`${state.page} / ${n}`:'— / —';
    $('zoomLabel').textContent=`${Math.round(state.zoom*100)}%`;
    $('prevPage').disabled=!has||state.page===1;
    $('nextPage').disabled=!has||state.page===n;
    $('zoomOut').disabled=!has||state.zoom<=.55;
    $('zoomIn').disabled=!has||state.zoom>=1.75;
    $('saveTop').disabled=!has||state.pending||state.busy;
    $('undoAction').disabled=!has||!state.history.length||state.busy;
    $('applyTop').disabled=state.busy;
    $('discardTop').disabled=state.busy;
    $('applyTop').classList.toggle('hidden',!has||!state.pending);
    $('discardTop').classList.toggle('hidden',!has||!state.pending);
    document.body.classList.toggle('has-document',has);
  };
  async function render() {
    if(!state.pdf) return;
    const run=++state.renderRun, previous=state.renderTask;
    if(previous?.cancel){
      previous.cancel();
      await previous.promise.catch(error=>{if(error.name!=='RenderingCancelledException')throw error;});
    }
    if(run!==state.renderRun)return;
    const page=await state.pdf.getPage(state.page);
    const viewport=page.getViewport({scale:1.45*state.zoom});
    if(run!==state.renderRun) return;
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    surface.style.width=canvas.width+'px';surface.style.height=canvas.height+'px';
    const displayPage=state.previewPdf?await state.previewPdf.getPage(state.page):page;
    if(run!==state.renderRun)return;
    const task=displayPage.render({canvasContext:canvas.getContext('2d'),viewport});
    state.renderTask=task;
    try{await task.promise;}
    catch(error){if(run===state.renderRun||error.name!=='RenderingCancelledException')throw error;return;}
    finally{if(state.renderTask===task)state.renderTask=null;}
    if(run!==state.renderRun) return;
    const content=await page.getTextContent();
    if(run!==state.renderRun) return;
    state.targets=content.items.map((item,i)=>{
      if(!item.str?.trim())return null;
      const t=pdfjsLib.Util.transform(viewport.transform,item.transform),px=Math.hypot(t[0],t[1]);
      if(Math.abs(t[1])>1||!px)return null;
      const top=t[5]-px*.88;
      const x=clamp(t[4]/viewport.width,0,1),w=clamp(Math.max(12,item.width*viewport.scale)/viewport.width,.01,1-x);
      const family=content.styles?.[item.fontName]?.fontFamily||'';
      const font=/courier|mono/i.test(family)?'courier':/times|georgia/i.test(family)||(/serif/i.test(family)&&!/sans.serif/i.test(family))?'times':'helvetica';
      const bold=/bold|black|heavy/i.test(item.fontName+' '+family);
      return {key:`native-${i}`,text:item.str,origin:item.transform.slice(4),x,y:clamp(top/viewport.height,0,1),w,h:px*1.15/viewport.height,size:px/viewport.scale,font,bold,align:Math.abs(x+w/2-.5)<.045?'center':'left'};
    }).filter(Boolean);
    renderNotes();refreshOcr();
    updateControls();
  }
  function renderNotes() {
    const editing=layer.querySelector('.inline-editor');
    for(const child of [...layer.children])if(child!==editing)child.remove();
    if(state.tool==='correct'){
      const targets=state.targets;
      for(const target of targets){
        if(state.notes.some(n=>n.page===state.page&&n.sourceKey===target.key))continue;
        const hit=document.createElement('div');hit.className='text-target';hit.title=`Corrigir: ${target.text}`;
        hit.style.left=(target.x*100)+'%';hit.style.top=(target.y*100)+'%';hit.style.width=(Math.min(1-target.x,target.w)*100)+'%';hit.style.height=(target.h*100)+'%';
        hit.onclick=async e=>{
          e.stopPropagation();
          if(state.busy)return;
          const source=state.bytes,page=state.page;
          const style=sampleStyle(target.x,target.y,target.w,target.h);
          try{
            const mupdf=await loadMupdf();
            if(source!==state.bytes||page!==state.page||state.tool!=='correct')return;
            window.PDFStudioStructural.inspect(mupdf,source,page-1,target.text,target.origin);
            style.color=await originalTextColor(page,[target])||style.color;
          }catch(error){toast(error.message||'Este trecho não permite edição original segura.');return;}
          if(source!==state.bytes||page!==state.page||state.tool!=='correct')return;
          const width=Math.max(target.w+.025,.2);
          setTool('select');
          const note=addNote('correction',{
            x:target.x,y:target.y,w:Math.min(1-target.x,width),h:target.h,hitWidth:target.w,
            text:target.text,originalText:target.text,size:clamp(target.size,6,96),
            sourceKey:target.key,origin:target.origin,font:target.font,bold:target.bold,align:target.align,...style
          });
          await beginInlineEdit(note);
        };
        layer.append(hit);
      }
    }
    for(const note of state.notes.filter(n=>n.page===state.page)) {
      if(note.type==='correction'){
        if(!note.text)continue;
        const hit=document.createElement('button');
        hit.type='button';
        hit.className=`text-target native-edit-target${state.selected===note.id?' selected':''}`;
        hit.dataset.id=note.id;
        hit.setAttribute('aria-label',`Selecionar texto do PDF: ${note.text}`);
        hit.title='Selecione e pressione Delete para apagar. Dê dois cliques para editar.';
        hit.style.left=(note.x*100)+'%';
        hit.style.top=(note.y*100)+'%';
        hit.style.width=(note.hitWidth*100)+'%';
        hit.style.height=(note.h*100)+'%';
        hit.onclick=e=>{
          e.stopPropagation();select(note.id);
          if(state.tool==='correct'){setTool('select');beginInlineEdit(note);}
        };
        hit.ondblclick=e=>{e.stopPropagation();if(!layer.querySelector('.inline-editor'))beginInlineEdit(note);};
        layer.append(hit);
        continue;
      }
      const el=document.createElement('div');el.className=`annotation ${note.type}${state.selected===note.id?' selected':''}`;
      el.style.left=(note.x*100)+'%';el.style.top=(note.y*100)+'%';el.dataset.id=note.id;
      if(note.type==='text') {
        el.textContent=note.text||'Digite aqui';el.style.fontSize=(effectiveSize(note)*state.zoom*1.45)+'px';el.style.color=note.color;
        el.style.setProperty('--document-fg',note.color);el.style.setProperty('--document-bg','transparent');
        el.style.fontWeight=note.bold?'700':'400';el.style.fontFamily=note.previewFamily||(note.font==='times'?'Times New Roman':note.font==='courier'?'Courier New':'Arial');el.style.textAlign=note.align||'left';
        el.style.maxWidth=`${Math.max(2,(1-note.x)*100)}%`;
        if(editing?.dataset.id===note.id)el.classList.add('editing');
      } else { el.style.width=(note.width*100)+'%';const img=document.createElement('img');img.src=note.src;img.alt='Imagem inserida';el.append(img); }
      el.addEventListener('pointerdown',e=>startDrag(e,note,el));layer.append(el);
      if(note.type!=='image')el.addEventListener('dblclick',e=>{e.stopPropagation();beginInlineEdit(note);});
    }
    renderObjectList();
  }
  function select(id) {
    state.selected=id;const note=state.notes.find(n=>n.id===id);
    // Preserve the element under the pointer while starting a drag. Rebuilding
    // the layer here would detach it before setPointerCapture can take effect.
    layer.querySelectorAll('.annotation, .native-edit-target').forEach(el=>el.classList.toggle('selected',el.dataset.id===id));renderObjectList();
    if(!note){showPanel(state.pdf?'ocr':'intro');return;}
    showPanel('edit');$('textInput').value=note.text||'';$('textInput').disabled=note.type==='image';
    $('fontSize').value=note.size||18;$('fontSize').disabled=note.type==='image'||note.type==='correction';
    $('textColor').value=note.color||'#1c293d';$('textColor').disabled=note.type==='image'||note.type==='correction';
    $('chooseFont').disabled=note.type==='image'||note.type==='correction';$('fontName').textContent=note.type==='correction'?'Fonte original preservada':note.fontKey?(state.fonts.get(note.fontKey)?.name||'Fonte local'):'Fonte similar à original';
    $('imageWidth').value=Math.round((note.type==='correction'?note.w:note.width||.35)*100);$('imageWidth').disabled=note.type!=='image';
    $('widthLabel').textContent='LARGURA DA IMAGEM';$('widthLabel').hidden=note.type==='correction';$('imageWidth').hidden=note.type==='correction';
    $('deleteItem').textContent=note.type==='correction'?'Apagar texto do PDF':'Remover este elemento';
    if(note.type==='correction')$('inspectorTitle').textContent='Editar texto do PDF';
  }
  function startDrag(e,note,el) {
    if(state.busy)return;
    e.preventDefault();e.stopPropagation();select(note.id);
    const before=clone(documentEdits());
    const rect=layer.getBoundingClientRect(), x=e.clientX, y=e.clientY, initialX=note.x, initialY=note.y;
    el.setPointerCapture(e.pointerId);
    el.onpointermove=move=>{note.x=Math.max(0,Math.min(1-el.offsetWidth/rect.width,initialX+(move.clientX-x)/rect.width));note.y=Math.max(0,Math.min(1-el.offsetHeight/rect.height,initialY+(move.clientY-y)/rect.height));el.style.left=(note.x*100)+'%';el.style.top=(note.y*100)+'%';};
    el.onpointerup=el.onpointercancel=()=>{remember(before);el.onpointermove=null;el.onpointerup=null;el.onpointercancel=null;};
  }
  function addNote(type, values={}) {
    const before=clone(documentEdits());
    const note={id:crypto.randomUUID(),page:state.page,type,x:.12,y:.16,text:'',size:18,color:'#1c293d',width:.35,...values};
    state.notes.push(note);renderNotes();select(note.id);remember(before);
    if(type==='image')toast('Imagem inserida. Selecione para mover ou remover; depois clique em Aplicar alterações.');
    return note;
  }
  async function beginInlineEdit(note) {
    if(!note||note.type==='image'||state.busy)return;
    layer.querySelector('.inline-editor')?.blur();
    finishFieldEdit();
    select(note.id);
    if(note.type==='correction'){
      const source=state.bytes;
      // Render the selected operator empty while the text field is open.
      // This temporary preview uses the same PDF rewrite as a real deletion.
      try{
        const editing=state.notes.map(n=>n.id===note.id?{...n,text:''}:n);
        if(!await rebuildPreview(editing))return;
      }catch(error){toast(error.message||'Não foi possível abrir a edição deste trecho.');refreshPreview();return;}
      if(source!==state.bytes)return;
      if(state.selected!==note.id||state.page!==note.page||state.tool!=='select'||state.busy){refreshPreview();return;}
    }
    const el=[...layer.querySelectorAll('.annotation, .native-edit-target')].find(n=>n.dataset.id===note.id);
    if(!el)return;
    el.classList.add('editing');
    const before=clone(documentEdits());
    const initial=note.text;
    const editor=document.createElement('textarea');editor.className='inline-editor';editor.setAttribute('aria-label','Editar texto na página');
    editor.dataset.id=note.id;
    editor.value=note.text;editor.style.left=(note.x*100)+'%';editor.style.top=(note.y*100)+'%';
    editor.style.fontSize=(effectiveSize(note)*state.zoom*1.45)+'px';editor.style.color=note.color;
    editor.style.background='transparent';
    editor.style.setProperty('--document-fg',note.color);editor.style.setProperty('--document-bg','transparent');
    editor.style.fontWeight=note.bold?'700':'400';editor.style.textAlign=note.align||'left';
    editor.style.fontFamily=note.previewFamily||(note.font==='times'?'Times New Roman':note.font==='courier'?'Courier New':'Arial');
    editor.style.width=note.type==='correction'?(note.w*layer.clientWidth)+'px':Math.min(layer.clientWidth*(1-note.x),Math.max(130,el.offsetWidth+36))+'px';
    editor.style.overflowWrap='anywhere';
    editor.style.height=Math.max(28,el.offsetHeight+6)+'px';
    editor.onpointerdown=e=>e.stopPropagation();editor.onclick=e=>e.stopPropagation();
    editor.oninput=()=>{note.text=editor.value;$('textInput').value=note.text;editor.style.fontSize=(effectiveSize(note)*state.zoom*1.45)+'px';editor.style.height=Math.max(28,editor.scrollHeight+4)+'px';setPending();};
    editor.onkeydown=e=>{if(e.key==='Escape'){note.text=initial;editor.blur();}if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();editor.blur();}};
    editor.onblur=()=>{
      editor.remove();
      if(!note.text.trim()&&note.type==='text')state.notes=state.notes.filter(n=>n.id!==note.id);
      if(!note.text&&state.selected===note.id)select(null);
      else if(state.selected===note.id)select(note.id);
      renderNotes();remember(before);
      if(note.type==='correction')refreshPreview();
    };
    layer.append(editor);editor.focus();editor.select();
  }
  async function openPdf(file) {
    if(!file||state.busy) return;
    if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){toast('Escolha um arquivo PDF.');return;}
    try {
      setHint('Abrindo PDF...');const bytes=new Uint8Array(await file.arrayBuffer());
      const pdf=await pdfjsLib.getDocument({data:bytes.slice()}).promise;
      layer.querySelector('.inline-editor')?.blur();
      finishFieldEdit();
      ++state.ocrRun;++state.previewRun;state.bytes=bytes;state.pdf=pdf;state.previewPdf=null;state.name=file.name;state.page=1;state.zoom=1;state.notes=[];state.committed=[];state.history=[];state.committedHistory=[];state.fonts.clear();state.nativeColors.clear();state.pending=false;state.selected=null;state.targets=[];
      state.ocr=Array.from({length:pdf.numPages},()=>({text:'',words:[],scanned:false,ready:false}));
      $('fileName').textContent=file.name;$('emptyState').classList.add('hidden');$('documentArea').classList.remove('hidden');
      setStatus('Analisando páginas...');
      setTool('select');showPanel('ocr');updateControls();await render();
      toast(`PDF aberto: ${pdf.numPages} página${pdf.numPages===1?'':'s'}. OCR iniciado.`);
      startOcr(state.ocrRun);
    } catch(error){console.error(error);setHint('Não foi possível abrir o PDF');toast('Não foi possível abrir o PDF. Verifique o arquivo ou sua senha.');}
  }
  async function startOcr(run) {
    const pdf=state.pdf,n=pdf.numPages;let worker;
    setStatus('Analisando páginas...');$('ocrProgress').style.width='0%';
    try {
      for(let p=1;p<=n;p++) {
        if(run!==state.ocrRun) return;
        const page=await pdf.getPage(p), content=await page.getTextContent();
        if(run!==state.ocrRun)return;
        const nativeItems=content.items.map(item=>item.str||'');
        const nativeText=nativeItems.filter(Boolean).join(' ').trim();
        if(nativeText)state.ocr[p-1]={text:nativeText,nativeItems,words:[],scanned:false,ready:true};
        if(nativeText.length<6){
          if(!worker){setStatus('Carregando OCR em português e inglês...');worker=await Tesseract.createWorker('por+eng',1,{logger:m=>{if(run===state.ocrRun&&m.status==='recognizing text')setStatus(`Reconhecendo página ${p}/${n} · ${Math.round(m.progress*100)}%`);}});}
          if(run!==state.ocrRun) return;
          setStatus(`Reconhecendo página ${p}/${n}...`);
          const viewport=page.getViewport({scale:2});const c=document.createElement('canvas');c.width=Math.ceil(viewport.width);c.height=Math.ceil(viewport.height);
          await page.render({canvasContext:c.getContext('2d'),viewport}).promise;
          const result=await worker.recognize(c,{}, {tsv:true});
          const lines=(result.data.tsv||'').trim().split('\n');
          const words=lines.slice(1).map(line=>line.split('\t')).filter(v=>v.length>=12&&v[11]?.trim()&&Number(v[10])>20).map(v=>({text:v.slice(11).join('\t'),x:+v[6]/c.width,y:+v[7]/c.height,w:+v[8]/c.width,h:+v[9]/c.height}));
          if(run!==state.ocrRun)return;
          state.ocr[p-1]={text:result.data.text.trim()||nativeText,words,nativeItems:nativeText?nativeItems:[],scanned:true,ready:true};
          c.width=0;c.height=0;
        }
        $('ocrProgress').style.width=(p/n*100)+'%';
        if(p===state.page){refreshOcr();if(state.tool==='correct')renderNotes();}
        setStatus(`OCR ativo · ${p}/${n} páginas analisadas`);
      }
      if(run===state.ocrRun){setStatus('OCR concluído');toast('Texto de todas as páginas disponível.');}
    } catch(error){console.error(error);if(run===state.ocrRun){setStatus('OCR indisponível');$('ocrInfo').textContent='Não foi possível carregar o OCR. Confira sua conexão e recarregue a página. Você ainda pode editar e baixar o PDF.';toast('Falha no OCR. Verifique a conexão.');}}
    finally{if(worker) await worker.terminate();}
  }
  function cleanPdfText(s){return String(s).replace(/[^\x20-\x7e\xa0-\xff]/g,'?');}
  async function fontForNote(doc,note,fonts){
    const key=note.fontKey||`${note.font||'helvetica'}:${!!note.bold}`;
    if(!fonts.has(key)){
      if(note.fontKey){
        if(!window.fontkit)throw new Error('Fontkit não carregado');
        doc.registerFontkit(window.fontkit);
        const local=state.fonts.get(key);
        if(!local)throw new Error('Fonte local não disponível');
        fonts.set(key,await doc.embedFont(local.bytes,{subset:true}));
      }else{
        const family=note.font==='times'?'TimesRoman':note.font==='courier'?'Courier':'Helvetica';
        fonts.set(key,await doc.embedFont(PDFLib.StandardFonts[family+(note.bold?'Bold':'')]));
      }
    }
    return fonts.get(key);
  }
  function drawTextNote(page,note,font){
    const {width:W,height:H}=page.getSize(),size=clamp(+note.size||18,6,96);
    const lines=note.text.split('\n');
    lines.forEach((line,i)=>{
      if(!line)return;
      const cleaned=note.fontKey?line:cleanPdfText(line);
      const y=H-note.y*H-size-i*size*1.1;
      if(y<0)throw new Error('O texto excede o limite da página.');
      page.drawText(cleaned,{x:clamp(note.x*W,0,W-1),y,size,font,color:rgbColor(note.color)});
    });
  }
  async function exportPdf() {
    if(!state.pdf||state.busy)return;
    if(state.pending){toast('Clique em Aplicar alterações antes de baixar.');return;}
    state.busy=true;updateControls();setHint('Preparando o PDF...');
    try{
      const nativeBytes=await rewriteNative(state.committed);
      if(nativeBytes&&state.committed.every(n=>n.type==='correction')){
        downloadPdf(nativeBytes);toast('PDF com texto original editado baixado com sucesso.');return;
      }
      const doc=await PDFLib.PDFDocument.load((nativeBytes||state.bytes).slice(),{ignoreEncryption:false});
      const font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const embeddedFonts=new Map();
      for(let p=0;p<doc.getPageCount();p++){
        const page=doc.getPage(p);
        const {width:W,height:H}=page.getSize(),data=state.ocr[p];
        const nativeEditOnPage=state.committed.some(n=>n.page===p+1&&n.type==='correction');
        if(data?.scanned&&data.words.length&&!nativeEditOnPage){
          for(const [i,w] of data.words.entries()){
            if(state.notes.some(n=>n.page===p+1&&n.sourceKey===`scan-${i}`))continue;
            const text=cleanPdfText(w.text);if(!text.trim())continue;
            const size=Math.max(3,Math.min(60,w.h*H*.86));
            page.drawText(text,{x:w.x*W,y:H-(w.y+w.h)*H,size,font,opacity:0,maxWidth:Math.max(1,w.w*W*1.2)});
          }
        }
        for(const note of state.committed.filter(n=>n.page===p+1)){
          if(note.type==='text'){
            const textFont=await fontForNote(doc,note,embeddedFonts);
            drawTextNote(page,note,textFont);
          } else if(note.type==='image') {
            const imageBytes=await (await fetch(note.src)).arrayBuffer();const image=note.mime==='image/png'?await doc.embedPng(imageBytes):await doc.embedJpg(imageBytes);
            const width=note.width*W,height=width*image.height/image.width;
            page.drawImage(image,{x:note.x*W,y:H-note.y*H-height,width,height});
          }
        }
      }
      downloadPdf(await doc.save());
      toast('PDF editado baixado com sucesso.');
    }catch(error){console.error(error);toast(error.message||'Não foi possível salvar o PDF.');}
    finally{state.busy=false;updateControls();setHint('Arraste textos e imagens para posicionar');}
  }
  function downloadPdf(bytes){const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));const a=document.createElement('a');a.href=url;a.download=state.name.replace(/\.pdf$/i,'')+'-editado.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  async function applyChanges(){
    if(state.busy)return;
    layer.querySelector('.inline-editor')?.blur();
    finishFieldEdit();
    if(!state.pending)return;
    const draft=clone(documentEdits());
    const history=state.history.slice();
    state.busy=true;updateControls();
    try{
      await rewriteNative(draft);
      state.committed=draft;state.committedHistory=history;setPending();
      toast('Alterações aplicadas. Confira o documento e depois baixe o PDF.');
    }catch(error){console.error(error);toast(error.message||'Este trecho não permite edição original.');}
    finally{state.busy=false;updateControls();}
  }
  function discardChanges(){
    if(state.busy)return;
    layer.querySelector('.inline-editor')?.blur();
    finishFieldEdit();
    state.notes=clone(state.committed);state.history=state.committedHistory.slice();
    select(null);renderNotes();setPending();refreshPreview();
    toast('Alterações não aplicadas descartadas.');
  }
  function undoChange(){
    if(state.busy)return;
    layer.querySelector('.inline-editor')?.blur();
    finishFieldEdit();
    const previous=state.history.pop();
    if(!previous)return;
    state.notes=clone(previous);
    select(null);renderNotes();setPending();refreshPreview();
    toast('Última ação desfeita.');
  }
  $('openTop').onclick=$('openEmpty').onclick=()=>$('pdfInput').click();
  $('pdfInput').onchange=e=>{openPdf(e.target.files[0]);e.target.value='';};
  $('applyTop').onclick=applyChanges;$('discardTop').onclick=discardChanges;
  $('saveTop').onclick=exportPdf;
  $('undoAction').onclick=undoChange;
  $('prevPage').onclick=async()=>{if(state.page>1){layer.querySelector('.inline-editor')?.blur();state.page--;select(null);await render();}};
  $('nextPage').onclick=async()=>{if(state.page<state.pdf.numPages){layer.querySelector('.inline-editor')?.blur();state.page++;select(null);await render();}};
  $('zoomIn').onclick=()=>{layer.querySelector('.inline-editor')?.blur();state.zoom=Math.min(1.75,Math.round((state.zoom+.15)*100)/100);render();};
  $('zoomOut').onclick=()=>{layer.querySelector('.inline-editor')?.blur();state.zoom=Math.max(.55,Math.round((state.zoom-.15)*100)/100);render();};
  document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{if(!state.pdf){toast('Abra um PDF primeiro.');return;}if(b.dataset.tool==='image'){$('imageInput').click();return;}setTool(b.dataset.tool);});
  $('ocrTab').onclick=()=>{showPanel('ocr');if(!state.pdf)toast('Abra um PDF para iniciar o OCR.');};
  layer.onclick=e=>{if(e.target!==layer||state.busy)return;if(state.tool==='text'){const r=layer.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;const {color}=sampleStyle(x,y,.02,.02);setTool('select');beginInlineEdit(addNote('text',{x,y,color}));}else if(state.tool==='correct')toast('Clique diretamente em uma linha de texto para corrigir.');else select(null);};
  $('imageInput').onchange=async e=>{const file=e.target.files[0],source=state.bytes;e.target.value='';if(!file||!source||state.busy)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('Use uma imagem PNG, JPG ou WebP.');return;}
    try{let src,mime=file.type;const url=URL.createObjectURL(file);const img=new Image();img.src=url;await img.decode();
      if(file.type==='image/webp'){const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);src=c.toDataURL('image/png');mime='image/png';}else src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
      URL.revokeObjectURL(url);
      if(source!==state.bytes||state.busy)return;
      addNote('image',{src,mime,width:.35});setTool('select');
    }catch(error){console.error(error);toast('Não foi possível inserir esta imagem.');}
  };
  let fieldEdit=null;
  function finishFieldEdit(){
    if(!fieldEdit)return;
    const {note,before}=fieldEdit;
    fieldEdit=null;
    if(!note.text.trim()&&note.type==='text')state.notes=state.notes.filter(n=>n.id!==note.id);
    if(!note.text.trim()&&note.type!=='image'&&state.selected===note.id)select(null);
    renderNotes();remember(before);
    if(note.type==='correction')refreshPreview();
  }
  for(const [field,property,readValue] of [
    ['textInput','text',value=>value],
    ['fontSize','size',Number],
    ['textColor','color',value=>value],
    ['imageWidth','width',value=>Number(value)/100]
  ]){
    const input=$(field);
    input.oninput=()=>{
      const note=state.notes.find(n=>n.id===state.selected);
      if(!note||input.disabled||state.busy)return;
      if(fieldEdit?.input!==input||fieldEdit.note!==note){
        finishFieldEdit();fieldEdit={input,note,before:clone(documentEdits())};
      }
      note[property]=readValue(input.value);
      renderNotes();setPending();
    };
    input.onchange=input.onblur=finishFieldEdit;
  }
  $('chooseFont').onclick=()=>$('fontInput').click();
  $('fontInput').onchange=async e=>{
    const file=e.target.files[0];e.target.value='';const note=state.notes.find(n=>n.id===state.selected);
    if(!file||!note||note.type!=='text'||state.busy)return;
    if(!/\.(ttf|otf)$/i.test(file.name)){toast('Selecione uma fonte TTF ou OTF.');return;}
    try{
      const bytes=new Uint8Array(await file.arrayBuffer()),key=crypto.randomUUID(),family=`pdf-studio-${key}`;
      const face=new FontFace(family,bytes);await face.load();
      if(state.busy||!state.notes.includes(note))return;
      document.fonts.add(face);
      const before=clone(documentEdits());
      state.fonts.set(key,{bytes,name:file.name});note.fontKey=key;note.previewFamily=family;note.bold=false;
      if(state.selected===note.id)$('fontName').textContent=file.name;
      renderNotes();remember(before);toast('Fonte escolhida. Clique em Aplicar alterações para confirmar.');
    }catch(error){console.error(error);toast('Não foi possível carregar essa fonte. Use um arquivo TTF ou OTF válido.');}
  };
  $('deleteItem').onclick=()=>removeNote(state.selected);
  $('copyOcr').onclick=async()=>{try{await navigator.clipboard.writeText($('ocrText').value);toast('Texto copiado.');}catch{toast('Não foi possível copiar. Selecione o texto manualmente.');}};
  $('downloadTxt').onclick=()=>{if(!state.pdf)return toast('Abra um PDF primeiro.');const text=state.ocr.map((p,i)=>`--- Página ${i+1} ---\n${textForPage(i)}`).join('\n\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=state.name.replace(/\.pdf$/i,'')+'-ocr.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);};
  document.addEventListener('keydown',e=>{
    const focused=document.activeElement;
    if(e.defaultPrevented||e.isComposing||focused?.matches('input,textarea,select')||focused?.isContentEditable)return;
    if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='z'&&state.history.length&&!state.busy){
      e.preventDefault();undoChange();return;
    }
    if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&(e.key==='Delete'||e.key==='Backspace')&&state.selected){
      e.preventDefault();removeNote(state.selected);
    }
  });
  let depth=0;document.addEventListener('dragenter',e=>{if([...e.dataTransfer?.types||[]].includes('Files')){e.preventDefault();depth++;$('dropOverlay').classList.remove('hidden');}});
  document.addEventListener('dragover',e=>{if([...e.dataTransfer?.types||[]].includes('Files'))e.preventDefault();});
  document.addEventListener('dragleave',e=>{e.preventDefault();if(--depth<=0){depth=0;$('dropOverlay').classList.add('hidden');}});
  document.addEventListener('drop',e=>{e.preventDefault();depth=0;$('dropOverlay').classList.add('hidden');openPdf([...e.dataTransfer.files].find(f=>/\.pdf$/i.test(f.name)||f.type==='application/pdf'));});
    if(!window.pdfjsLib||!window.PDFLib||!window.Tesseract||!window.PDFStudioStructural){setHint('Falha ao carregar bibliotecas. Verifique a conexão e recarregue.');toast('Não foi possível iniciar o editor. Verifique sua conexão.');}
  else pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  updateControls();
})();
