/* PDF Studio: all document bytes stay in this browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { bytes:null, pdf:null, previewPdf:null, previewRun:0, name:'', page:1, zoom:1, tool:'select', notes:[], committed:[], fonts:new Map(), nativeColors:new Map(), pending:false, selected:null, targets:[], ocr:[], ocrRun:0, busy:false, renderRun:0 };
  const canvas = $('pdfCanvas'), surface = $('pageSurface'), layer = $('annotationLayer');
  let mupdfPromise;
  const loadMupdf = () => mupdfPromise ||= (window.PDFStudioMuPDF?Promise.resolve(window.PDFStudioMuPDF):import('https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js')).catch(e=>{mupdfPromise=null;throw e;});
  async function redactNative(notes){
    const corrections=notes.filter(n=>n.type==='correction'&&n.sourceKey?.startsWith('native-'));
    if(!corrections.length)return null;
    const mupdf=await loadMupdf();
    const doc=mupdf.Document.openDocument(state.bytes,'application/pdf');
    for(const index of [...new Set(corrections.map(n=>n.page-1))]){
      const page=doc.loadPage(index),bounds=page.getBounds(),W=bounds[2]-bounds[0],H=bounds[3]-bounds[1];
      for(const n of corrections.filter(item=>item.page===index+1)){
        for(const r of n.originalRects||[{x:n.x,y:n.y,w:n.w,h:n.h}]){
          const annotation=page.createAnnotation('Redact');
          annotation.setRect([bounds[0]+r.x*W,bounds[1]+r.y*H,bounds[0]+(r.x+r.w)*W,bounds[1]+(r.y+r.h)*H]);
        }
      }
      page.applyRedactions(false,mupdf.PDFPage.REDACT_IMAGE_NONE,mupdf.PDFPage.REDACT_LINE_ART_NONE,mupdf.PDFPage.REDACT_TEXT_REMOVE);
    }
    return new Uint8Array(doc.saveToBuffer('garbage=4,compress').asUint8Array());
  }
  async function rebuildPreview(){
    const run=++state.previewRun;
    const bytes=await redactNative(state.notes);
    if(run!==state.previewRun)return;
    const preview=bytes?await pdfjsLib.getDocument({data:bytes.slice()}).promise:null;
    if(run!==state.previewRun)return;
    state.previewPdf=preview;
    await render();
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
  function setPending(){state.pending=true;updateControls();refreshOcr();renderObjectList();}
  function effectiveSize(note){
    let size=clamp(+note.size||18,6,96);
    return size;
  }
  function groupTargets(items){
    const groups=[];
    for(const item of items){
      const prev=groups[groups.length-1];
      const gap=prev?(item.x-prev.x-prev.w)*canvas.width:Infinity;
      const sameLine=prev&&Math.abs(item.y-prev.y)*canvas.height<Math.max(3,item.size*state.zoom*.4);
      const sameStyle=prev&&prev.font===item.font&&prev.bold===item.bold&&Math.abs(prev.size-item.size)<1.5;
      if(sameLine&&sameStyle&&gap>=-2&&gap<Math.max(7,item.size*state.zoom*1.8)){
        prev.text+=(gap>item.size*state.zoom*.2?' ':'')+item.text;
        prev.w=Math.max(prev.w,item.x+item.w-prev.x);prev.h=Math.max(prev.h,item.h);
        prev.sourceKeys.push(item.key);
      }else groups.push({...item,sourceKeys:[item.key]});
    }
    groups.forEach(g=>g.align=Math.abs(g.x+g.w/2-.5)<.045?'center':'left');
    const paragraphs=[];
    for(const line of groups){
      const previous=paragraphs[paragraphs.length-1];
      const gap=previous?(line.y-previous.lastY)*canvas.height:Infinity;
      const lineHeight=line.size*state.zoom*1.45;
      const aligned=previous&&Math.abs(line.x-previous.x)*canvas.width<Math.max(14,lineHeight*1.4);
      const sameStyle=previous&&line.font===previous.font&&line.bold===previous.bold&&Math.abs(line.size-previous.size)<1.5;
      if(aligned&&sameStyle&&gap>lineHeight*.7&&gap<lineHeight*1.8&&line.align!=='center'&&previous.align!=='center'){
        previous.text+=' '+line.text;
        previous.sourceKeys.push(...line.sourceKeys);
        previous.originalRects.push({x:line.x,y:line.y,w:line.w,h:line.h});
        previous.w=Math.max(previous.w,line.x+line.w-previous.x);
        previous.h=line.y+line.h-previous.y;
        previous.lastY=line.y;
      }else paragraphs.push({...line,originalRects:[{x:line.x,y:line.y,w:line.w,h:line.h}],lastY:line.y});
    }
    return paragraphs.map(({lastY,...p})=>p);
  }
  function textForPage(pageIndex){
    const data=state.ocr[pageIndex];if(!data?.ready)return '';
    const replacement=key=>state.notes.find(n=>n.page===pageIndex+1&&n.type==='correction'&&(n.sourceKeys||[n.sourceKey]).includes(key));
    if(data.nativeItems?.length)return data.nativeItems.map((t,i)=>{const n=replacement(`native-${i}`);return n?(n.sourceKey===`native-${i}`?n.text:''):t;}).join(' ').replace(/\s+/g,' ').trim();
    if(data.scanned&&data.words.length)return data.words.map((w,i)=>replacement(`scan-${i}`)?.text??w.text).join(' ').trim();
    return data.text;
  }
  function refreshOcr(){if(state.pdf)$('ocrText').value=textForPage(state.page-1);}
  function renderObjectList(){
    const list=$('objectList');list.replaceChildren();$('objectPanel').classList.toggle('hidden',!state.pdf||state.notes.length===0);
    state.notes.forEach((note,index)=>{
      const row=document.createElement('div');row.className='object-row';
      const choose=document.createElement('button');choose.className='object-select'+(note.id===state.selected?' active':'');
      choose.textContent=`${note.type==='image'?'▧ Imagem':note.type==='correction'?'✎ Correção':'T Texto'} ${index+1} · p. ${note.page}`;
      choose.onclick=async()=>{if(state.page!==note.page){state.page=note.page;await render();}select(note.id);};
      const remove=document.createElement('button');remove.className='object-remove';remove.title='Remover este elemento';remove.setAttribute('aria-label',`Remover ${choose.textContent}`);remove.textContent='✕';remove.onclick=()=>removeNote(note.id);
      row.append(choose,remove);list.append(row);
    });
  }
  function removeNote(id){
    layer.querySelector('.inline-editor')?.blur();
    const removed=state.notes.find(n=>n.id===id),count=state.notes.length;state.notes=state.notes.filter(n=>n.id!==id);
    if(state.notes.length===count)return;
    if(state.selected===id)select(null);
    renderNotes();setPending();toast('Elemento removido. Clique em Aplicar alterações para confirmar.');
    if(removed?.type==='correction')rebuildPreview().catch(error=>{console.error(error);toast('Não foi possível atualizar a prévia.');});
  }
  const setHint = s => $('workHint').textContent=s;
  const setStatus = s => $('ocrState').textContent=s;
  const showPanel = name => {
    ['intro','edit','ocr'].forEach(n=>$(n+'Panel').classList.toggle('hidden',n!==name));
    $('inspectorTitle').textContent=({intro:'Comece por aqui',edit:'Editar elemento',ocr:'Texto reconhecido'})[name];
  };
  const setTool = tool => {
    state.tool=tool;
    document.querySelectorAll('[data-tool]').forEach(el=>el.classList.toggle('active',el.dataset.tool===tool));
    layer.classList.toggle('tool-text',tool==='text');layer.classList.toggle('tool-correct',tool==='correct');
    if(tool==='text') setHint('Clique na página para inserir texto');
    else if(tool==='correct') setHint('Clique no texto existente para corrigir diretamente na página');
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
    $('applyTop').classList.toggle('hidden',!has||!state.pending);
    $('discardTop').classList.toggle('hidden',!has||!state.pending);
    document.body.classList.toggle('has-document',has);
  };
  async function render() {
    if(!state.pdf) return;
    const run=++state.renderRun, page=await state.pdf.getPage(state.page);
    const viewport=page.getViewport({scale:1.45*state.zoom});
    if(run!==state.renderRun) return;
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    surface.style.width=canvas.width+'px';surface.style.height=canvas.height+'px';
    const displayPage=state.previewPdf?await state.previewPdf.getPage(state.page):page;
    if(run!==state.renderRun)return;
    await displayPage.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    if(run!==state.renderRun) return;
    patchScannedCanvas(canvas,state.notes.filter(n=>n.page===state.page&&n.type==='correction'&&n.sourceKey?.startsWith('scan-')));
    const content=await page.getTextContent();
    if(run!==state.renderRun) return;
    state.targets=groupTargets(content.items.map((item,i)=>{
      if(!item.str?.trim())return null;
      const t=pdfjsLib.Util.transform(viewport.transform,item.transform),px=Math.hypot(t[0],t[1]);
      if(Math.abs(t[1])>1||!px)return null;
      const top=t[5]-px*.88;
      const x=clamp(t[4]/viewport.width,0,1),w=clamp(Math.max(12,item.width*viewport.scale)/viewport.width,.01,1-x);
      const family=content.styles?.[item.fontName]?.fontFamily||'';
      const font=/courier|mono/i.test(family)?'courier':/times|georgia/i.test(family)||(/serif/i.test(family)&&!/sans.serif/i.test(family))?'times':'helvetica';
      const bold=/bold|black|heavy/i.test(item.fontName+' '+family);
      return {key:`native-${i}`,text:item.str,x,y:clamp(top/viewport.height,0,1),w,h:px*1.15/viewport.height,size:px/viewport.scale,font,bold,align:Math.abs(x+w/2-.5)<.045?'center':'left'};
    }).filter(Boolean));
    renderNotes();refreshOcr();
    updateControls();
  }
  function patchScannedCanvas(target,notes){
    if(!notes.length)return;
    const ctx=target.getContext('2d');
    for(const n of notes){ctx.fillStyle=n.bg;ctx.fillRect(n.x*target.width,n.y*target.height,n.w*target.width,n.h*target.height);}
  }
  function renderNotes() {
    layer.replaceChildren();
    if(state.tool==='correct'){
      const scanned=state.ocr[state.page-1];
      const targets=[...state.targets,...(scanned?.scanned?scanned.words.map((w,i)=>({...w,key:`scan-${i}`,size:w.h*canvas.height/(1.45*state.zoom),h:w.h,font:'regular',align:'left'})):[])];
      for(const target of targets){
        if(state.notes.some(n=>n.page===state.page&&(n.sourceKeys||[n.sourceKey]).includes(target.key)))continue;
        const hit=document.createElement('div');hit.className='text-target';hit.title=`Corrigir: ${target.text}`;
        hit.style.left=(target.x*100)+'%';hit.style.top=(target.y*100)+'%';hit.style.width=(Math.min(1-target.x,target.w)*100)+'%';hit.style.height=(target.h*100)+'%';
        hit.onclick=async e=>{
          e.stopPropagation();const style=sampleStyle(target.x,target.y,target.w,target.h);
          if(target.key.startsWith('native-')){
            try{style.color=await originalTextColor(state.page,target.originalRects||[{x:target.x,y:target.y,w:target.w,h:target.h}])||style.color;}
            catch(error){console.warn('Cor original indisponível; usando cor estimada.',error);}
          }
          const neighbor=state.targets.filter(t=>t!==target&&t.x>target.x+target.w*.5&&t.y<target.y+target.h+.015&&t.y+t.h>target.y-.015).sort((a,b)=>a.x-b.x)[0];
          const available=(neighbor?.x??.93)-target.x-.015;
          const width=target.originalRects?.length>1?Math.max(target.w+.025,available):Math.max(target.w+.025,.2);
          setTool('select');const note=addNote('correction',{x:target.x,y:target.y,w:Math.min(1-target.x,width),h:target.h,text:target.text,size:clamp(target.size,6,96),sourceKey:target.key,sourceKeys:target.sourceKeys||[target.key],originalRects:target.originalRects,font:target.font,bold:target.bold,align:target.align,...style});
          try{
            setHint(target.key.startsWith('native-')?'Removendo o texto original do PDF...':'Reconstruindo o trecho reconhecido por OCR...');
            await rebuildPreview();beginInlineEdit(note);setHint('Edite o texto no documento e clique em Aplicar alterações');
          }catch(error){console.error(error);state.notes=state.notes.filter(n=>n.id!==note.id);state.selected=null;renderNotes();toast('Não foi possível preparar a edição real deste trecho. O original foi preservado.');}
        };
        layer.append(hit);
      }
    }
    for(const note of state.notes.filter(n=>n.page===state.page)) {
      const el=document.createElement('div');el.className=`annotation ${note.type}${state.selected===note.id?' selected':''}`;
      el.style.left=(note.x*100)+'%';el.style.top=(note.y*100)+'%';el.dataset.id=note.id;
      if(note.type==='text'||note.type==='correction') {
        el.textContent=note.text||'Digite aqui';el.style.fontSize=(effectiveSize(note)*state.zoom*1.45)+'px';el.style.color=note.color;
        el.style.setProperty('--document-fg',note.color);el.style.setProperty('--document-bg','transparent');
        el.style.fontWeight=note.bold?'700':'400';el.style.fontFamily=note.previewFamily||(note.font==='times'?'Times New Roman':note.font==='courier'?'Courier New':'Arial');el.style.textAlign=note.align||'left';
        el.style.maxWidth=`${Math.max(2,(1-note.x)*100)}%`;
        if(note.type==='correction'){el.style.width=(note.w*100)+'%';el.style.background='transparent';el.style.overflowWrap='anywhere';}
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
    layer.querySelectorAll('.annotation').forEach(el=>el.classList.toggle('selected',el.dataset.id===id));renderObjectList();
    if(!note){showPanel(state.pdf?'ocr':'intro');return;}
    showPanel('edit');$('textInput').value=note.text||'';$('textInput').disabled=note.type==='image';
    $('fontSize').value=note.size||18;$('fontSize').disabled=note.type==='image';
    $('textColor').value=note.color||'#1c293d';$('textColor').disabled=note.type==='image';
    $('chooseFont').disabled=note.type==='image';$('fontName').textContent=note.fontKey?(state.fonts.get(note.fontKey)?.name||'Fonte local'):'Fonte similar à original';
    $('imageWidth').value=Math.round((note.type==='correction'?note.w:note.width||.35)*100);$('imageWidth').disabled=!['image','correction'].includes(note.type);
    $('widthLabel').textContent=note.type==='correction'?'LARGURA DO PARÁGRAFO':'LARGURA DA IMAGEM';
  }
  function startDrag(e,note,el) {
    e.preventDefault();e.stopPropagation();select(note.id);
    if(note.type==='correction')return;
    const rect=layer.getBoundingClientRect(), x=e.clientX, y=e.clientY, initialX=note.x, initialY=note.y;
    el.setPointerCapture(e.pointerId);
    el.onpointermove=move=>{note.x=Math.max(0,Math.min(1-el.offsetWidth/rect.width,initialX+(move.clientX-x)/rect.width));note.y=Math.max(0,Math.min(1-el.offsetHeight/rect.height,initialY+(move.clientY-y)/rect.height));el.style.left=(note.x*100)+'%';el.style.top=(note.y*100)+'%';};
    el.onpointerup=el.onpointercancel=()=>{if(Math.abs(note.x-initialX)+Math.abs(note.y-initialY)>.001)setPending();el.onpointermove=null;el.onpointerup=null;el.onpointercancel=null;};
  }
  function addNote(type, values={}) {
    const note={id:crypto.randomUUID(),page:state.page,type,x:.12,y:.16,text:'',size:18,color:'#1c293d',width:.35,...values};
    state.notes.push(note);renderNotes();select(note.id);setPending();
    if(type==='image')toast('Imagem inserida. Selecione para mover ou remover; depois clique em Aplicar alterações.');
    return note;
  }
  function beginInlineEdit(note) {
    if(!note||note.type==='image')return;
    layer.querySelector('.inline-editor')?.blur();
    const el=[...layer.querySelectorAll('.annotation')].find(n=>n.dataset.id===note.id);
    if(!el)return;
    el.classList.add('editing');select(note.id);
    const editor=document.createElement('textarea');editor.className='inline-editor';editor.setAttribute('aria-label','Editar texto na página');
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
    const initial=note.text;
    editor.onblur=()=>{editor.remove();if(!note.text.trim()&&note.type==='text'){state.notes=state.notes.filter(n=>n.id!==note.id);if(state.selected===note.id)state.selected=null;}renderNotes();refreshOcr();};
    layer.append(editor);editor.focus();editor.select();
  }
  async function openPdf(file) {
    if(!file) return;
    if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){toast('Escolha um arquivo PDF.');return;}
    try {
      setHint('Abrindo PDF...');const bytes=new Uint8Array(await file.arrayBuffer());
      const pdf=await pdfjsLib.getDocument({data:bytes.slice()}).promise;
      ++state.ocrRun;++state.previewRun;state.bytes=bytes;state.pdf=pdf;state.previewPdf=null;state.name=file.name;state.page=1;state.zoom=1;state.notes=[];state.committed=[];state.fonts.clear();state.nativeColors.clear();state.pending=false;state.selected=null;state.targets=[];
      state.ocr=Array.from({length:pdf.numPages},()=>({text:'',words:[],scanned:false,ready:false}));
      $('fileName').textContent=file.name;$('emptyState').classList.add('hidden');$('documentArea').classList.remove('hidden');
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
        const nativeText=content.items.map(item=>item.str).filter(Boolean).join(' ').trim();
        if(nativeText.length>=6){state.ocr[p-1]={text:nativeText,nativeItems:content.items.map(item=>item.str||''),words:[],scanned:false,ready:true};}
        else {
          if(!worker){setStatus('Carregando OCR em português e inglês...');worker=await Tesseract.createWorker('por+eng',1,{logger:m=>{if(run===state.ocrRun&&m.status==='recognizing text')setStatus(`Reconhecendo página ${p}/${n} · ${Math.round(m.progress*100)}%`);}});}
          if(run!==state.ocrRun) return;
          setStatus(`Reconhecendo página ${p}/${n}...`);
          const viewport=page.getViewport({scale:2});const c=document.createElement('canvas');c.width=Math.ceil(viewport.width);c.height=Math.ceil(viewport.height);
          await page.render({canvasContext:c.getContext('2d'),viewport}).promise;
          const result=await worker.recognize(c,{}, {tsv:true});
          const lines=(result.data.tsv||'').trim().split('\n');
          const words=lines.slice(1).map(line=>line.split('\t')).filter(v=>v.length>=12&&v[11]?.trim()&&Number(v[10])>20).map(v=>({text:v.slice(11).join('\t'),x:+v[6]/c.width,y:+v[7]/c.height,w:+v[8]/c.width,h:+v[9]/c.height}));
          if(run!==state.ocrRun)return;
          state.ocr[p-1]={text:result.data.text.trim(),words,scanned:true,ready:true};
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
  function wrapPdfLines(text,font,size,maxWidth){
    const result=[];
    for(const paragraph of String(text).split('\n')){
      let line='';
      for(const word of paragraph.trim().split(/\s+/).filter(Boolean)){
        const next=line?line+' '+word:word;
        if(font.widthOfTextAtSize(next,size)<=maxWidth){line=next;continue;}
        if(line){result.push(line);line='';}
        let piece='';
        for(const char of word){
          if(piece&&font.widthOfTextAtSize(piece+char,size)>maxWidth){result.push(piece);piece='';}
          piece+=char;
        }
        line=piece;
      }
      result.push(line);
    }
    return result;
  }
  async function replaceScannedPage(doc,index,notes){
    const source=await state.pdf.getPage(index+1),viewport=source.getViewport({scale:2});
    const c=document.createElement('canvas');c.width=Math.ceil(viewport.width);c.height=Math.ceil(viewport.height);
    await source.render({canvasContext:c.getContext('2d'),viewport}).promise;
    patchScannedCanvas(c,notes);
    const pngBytes=await (await fetch(c.toDataURL('image/png'))).arrayBuffer();
    const old=doc.getPage(index),{width,height}=old.getSize();
    doc.removePage(index);const page=doc.insertPage(index,[width,height]);
    const image=await doc.embedPng(pngBytes);page.drawImage(image,{x:0,y:0,width,height});
    c.width=0;c.height=0;
    return page;
  }
  async function exportPdf() {
    if(!state.pdf||state.busy)return;
    if(state.pending){toast('Clique em Aplicar alterações antes de baixar.');return;}
    state.busy=true;updateControls();setHint('Preparando o PDF...');
    try{
      const nativeBytes=await redactNative(state.committed);
      const doc=await PDFLib.PDFDocument.load((nativeBytes||state.bytes).slice(),{ignoreEncryption:false});
      const font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const embeddedFonts=new Map();
      const textFontFor=async note=>{
        const key=note.fontKey||`${note.font||'helvetica'}:${!!note.bold}`;
        if(!embeddedFonts.has(key)){
          if(note.fontKey){
            if(!window.fontkit)throw new Error('Fontkit não carregado');
            doc.registerFontkit(window.fontkit);
            const local=state.fonts.get(key);
            if(!local)throw new Error('Fonte local não disponível');
            embeddedFonts.set(key,await doc.embedFont(local.bytes,{subset:true}));
          }else{
            const family=note.font==='times'?'TimesRoman':note.font==='courier'?'Courier':'Helvetica';
            const name=PDFLib.StandardFonts[family+(note.bold?'Bold':'')];
            embeddedFonts.set(key,await doc.embedFont(name));
          }
        }
        return embeddedFonts.get(key);
      };
      for(let p=0;p<doc.getPageCount();p++){
        const scanCorrections=state.committed.filter(n=>n.page===p+1&&n.type==='correction'&&n.sourceKey?.startsWith('scan-'));
        const page=scanCorrections.length?await replaceScannedPage(doc,p,scanCorrections):doc.getPage(p);
        const {width:W,height:H}=page.getSize(),data=state.ocr[p];
        if(data?.scanned&&data.words.length){
          for(const [i,w] of data.words.entries()){
            if(state.notes.some(n=>n.page===p+1&&n.sourceKey===`scan-${i}`))continue;
            const text=cleanPdfText(w.text);if(!text.trim())continue;
            const size=Math.max(3,Math.min(60,w.h*H*.86));
            page.drawText(text,{x:w.x*W,y:H-(w.y+w.h)*H,size,font,opacity:0,maxWidth:Math.max(1,w.w*W*1.2)});
          }
        }
        for(const note of state.committed.filter(n=>n.page===p+1)){
          if(note.type==='text'||note.type==='correction'){
            const textFont=await textFontFor(note);
            const size=clamp(+note.size||18,6,96);
            const lines=note.type==='correction'?wrapPdfLines(note.fontKey?note.text:cleanPdfText(note.text),textFont,size,Math.max(10,note.w*W-4)):note.text.split('\n');
            lines.forEach((line,i)=>{
              if(!line)return;
              const cleaned=note.fontKey?line:cleanPdfText(line),lineWidth=textFont.widthOfTextAtSize(cleaned,size);
              const alignOffset=note.type==='correction'?(note.align==='center'?(note.w*W-lineWidth)/2:note.align==='right'?note.w*W-lineWidth:0):0;
              const y=H-note.y*H-size-i*size*1.1;
              if(y<0)throw new Error('O parágrafo excede o limite da página. Aumente a largura ou reduza a fonte.');
              page.drawText(cleaned,{x:clamp(note.x*W+alignOffset,0,W-1),y,size,font:textFont,color:rgbColor(note.color)});
            });
          } else {
            const imageBytes=await (await fetch(note.src)).arrayBuffer();const image=note.mime==='image/png'?await doc.embedPng(imageBytes):await doc.embedJpg(imageBytes);
            const width=note.width*W,height=width*image.height/image.width;
            page.drawImage(image,{x:note.x*W,y:H-note.y*H-height,width,height});
          }
        }
      }
      const bytes=await doc.save();const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const a=document.createElement('a');a.href=url;a.download=state.name.replace(/\.pdf$/i,'')+'-editado.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      toast('PDF editado baixado com sucesso.');
    }catch(error){console.error(error);toast(error.message?.includes('parágrafo excede')?error.message:'Não foi possível salvar o PDF. Confira as imagens e tente novamente.');}
    finally{state.busy=false;updateControls();setHint('Arraste textos e imagens para posicionar');}
  }
  function applyChanges(){
    layer.querySelector('.inline-editor')?.blur();
    if(!state.pending)return;
    state.committed=clone(state.notes);state.pending=false;updateControls();refreshOcr();
    toast('Alterações aplicadas. Confira o documento e depois baixe o PDF.');
  }
  function discardChanges(){
    layer.querySelector('.inline-editor')?.blur();
    state.notes=clone(state.committed);state.pending=false;state.selected=null;
    renderNotes();select(null);updateControls();refreshOcr();toast('Alterações não aplicadas descartadas.');
    rebuildPreview().catch(error=>{console.error(error);toast('Não foi possível atualizar a prévia.');});
  }
  $('openTop').onclick=$('openEmpty').onclick=()=>$('pdfInput').click();
  $('pdfInput').onchange=e=>{openPdf(e.target.files[0]);e.target.value='';};
  $('applyTop').onclick=applyChanges;$('discardTop').onclick=discardChanges;
  $('saveTop').onclick=exportPdf;
  $('prevPage').onclick=async()=>{if(state.page>1){state.page--;select(null);await render();}};
  $('nextPage').onclick=async()=>{if(state.page<state.pdf.numPages){state.page++;select(null);await render();}};
  $('zoomIn').onclick=()=>{state.zoom=Math.min(1.75,Math.round((state.zoom+.15)*100)/100);render();};
  $('zoomOut').onclick=()=>{state.zoom=Math.max(.55,Math.round((state.zoom-.15)*100)/100);render();};
  document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{if(!state.pdf){toast('Abra um PDF primeiro.');return;}if(b.dataset.tool==='image'){$('imageInput').click();return;}setTool(b.dataset.tool);});
  $('ocrTab').onclick=()=>{showPanel('ocr');if(!state.pdf)toast('Abra um PDF para iniciar o OCR.');};
  layer.onclick=e=>{if(e.target!==layer)return;if(state.tool==='text'){const r=layer.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;const {color}=sampleStyle(x,y,.02,.02);setTool('select');beginInlineEdit(addNote('text',{x,y,color}));}else if(state.tool==='correct')toast('Clique diretamente em uma linha de texto para corrigir.');else select(null);};
  $('imageInput').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file||!state.pdf)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('Use uma imagem PNG, JPG ou WebP.');return;}
    try{let src,mime=file.type;const url=URL.createObjectURL(file);const img=new Image();img.src=url;await img.decode();
      if(file.type==='image/webp'){const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);src=c.toDataURL('image/png');mime='image/png';}else src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
      URL.revokeObjectURL(url);addNote('image',{src,mime,width:.35});setTool('select');
    }catch(error){console.error(error);toast('Não foi possível inserir esta imagem.');}
  };
  $('textInput').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){n.text=e.target.value;renderNotes();setPending();}};
  $('fontSize').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){n.size=+e.target.value;renderNotes();setPending();}};
  $('textColor').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){n.color=e.target.value;renderNotes();setPending();}};
  $('imageWidth').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){if(n.type==='correction')n.w=Math.min(1-n.x,+e.target.value/100);else n.width=+e.target.value/100;renderNotes();setPending();}};
  $('chooseFont').onclick=()=>$('fontInput').click();
  $('fontInput').onchange=async e=>{
    const file=e.target.files[0];e.target.value='';const note=state.notes.find(n=>n.id===state.selected);
    if(!file||!note||note.type==='image')return;
    if(!/\.(ttf|otf)$/i.test(file.name)){toast('Selecione uma fonte TTF ou OTF.');return;}
    try{
      const bytes=new Uint8Array(await file.arrayBuffer()),key=crypto.randomUUID(),family=`pdf-studio-${key}`;
      const face=new FontFace(family,bytes);await face.load();document.fonts.add(face);
      state.fonts.set(key,{bytes,name:file.name});note.fontKey=key;note.previewFamily=family;note.bold=false;
      $('fontName').textContent=file.name;renderNotes();setPending();toast('Fonte escolhida. Clique em Aplicar alterações para confirmar.');
    }catch(error){console.error(error);toast('Não foi possível carregar essa fonte. Use um arquivo TTF ou OTF válido.');}
  };
  $('deleteItem').onclick=()=>removeNote(state.selected);
  $('copyOcr').onclick=async()=>{try{await navigator.clipboard.writeText($('ocrText').value);toast('Texto copiado.');}catch{toast('Não foi possível copiar. Selecione o texto manualmente.');}};
  $('downloadTxt').onclick=()=>{if(!state.pdf)return toast('Abra um PDF primeiro.');const text=state.ocr.map((p,i)=>`--- Página ${i+1} ---\n${textForPage(i)}`).join('\n\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=state.name.replace(/\.pdf$/i,'')+'-ocr.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);};
  document.addEventListener('keydown',e=>{if((e.key==='Delete'||e.key==='Backspace')&&state.selected&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName))$('deleteItem').click();});
  let depth=0;document.addEventListener('dragenter',e=>{if([...e.dataTransfer?.types||[]].includes('Files')){e.preventDefault();depth++;$('dropOverlay').classList.remove('hidden');}});
  document.addEventListener('dragover',e=>{if([...e.dataTransfer?.types||[]].includes('Files'))e.preventDefault();});
  document.addEventListener('dragleave',e=>{e.preventDefault();if(--depth<=0){depth=0;$('dropOverlay').classList.add('hidden');}});
  document.addEventListener('drop',e=>{e.preventDefault();depth=0;$('dropOverlay').classList.add('hidden');openPdf([...e.dataTransfer.files].find(f=>/\.pdf$/i.test(f.name)||f.type==='application/pdf'));});
  if(!window.pdfjsLib||!window.PDFLib||!window.Tesseract){setHint('Falha ao carregar bibliotecas. Verifique a conexão e recarregue.');toast('Não foi possível iniciar o editor. Verifique sua conexão.');}
  else pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  updateControls();
})();
