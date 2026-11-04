/* PDF Studio: all document bytes stay in this browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { bytes:null, pdf:null, name:'', page:1, zoom:1, tool:'select', notes:[], selected:null, targets:[], ocr:[], ocrRun:0, busy:false, renderRun:0 };
  const canvas = $('pdfCanvas'), surface = $('pageSurface'), layer = $('annotationLayer');
  const toast = message => { const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),3500); };
  const safe = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
    $('saveTop').disabled=!has;
  };
  async function render() {
    if(!state.pdf) return;
    const run=++state.renderRun, page=await state.pdf.getPage(state.page);
    const viewport=page.getViewport({scale:1.45*state.zoom});
    if(run!==state.renderRun) return;
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    surface.style.width=canvas.width+'px';surface.style.height=canvas.height+'px';
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    if(run!==state.renderRun) return;
    const content=await page.getTextContent();
    if(run!==state.renderRun) return;
    state.targets=content.items.map((item,i)=>{
      if(!item.str?.trim())return null;
      const t=pdfjsLib.Util.transform(viewport.transform,item.transform),px=Math.hypot(t[0],t[1]);
      if(Math.abs(t[1])>1||!px)return null;
      const top=t[5]-px*.88;
      return {key:`native-${i}`,text:item.str,x:Math.max(0,t[4]/viewport.width),y:Math.max(0,top/viewport.height),w:Math.max(12,item.width*viewport.scale)/viewport.width,h:px*1.15/viewport.height,size:px/viewport.scale};
    }).filter(Boolean);
    renderNotes();$('ocrText').value=state.ocr[state.page-1]?.text||'';
    updateControls();
  }
  function renderNotes() {
    layer.replaceChildren();
    if(state.tool==='correct'){
      const scanned=state.ocr[state.page-1];
      const targets=state.targets.length?state.targets:(scanned?.scanned?scanned.words.map((w,i)=>({...w,key:`scan-${i}`,size:w.h*canvas.height/(1.45*state.zoom),h:w.h})):[]);
      for(const target of targets){
        if(state.notes.some(n=>n.page===state.page&&n.sourceKey===target.key))continue;
        const hit=document.createElement('div');hit.className='text-target';hit.title=`Corrigir: ${target.text}`;
        hit.style.left=(target.x*100)+'%';hit.style.top=(target.y*100)+'%';hit.style.width=(Math.min(1-target.x,target.w)*100)+'%';hit.style.height=(target.h*100)+'%';
        hit.onclick=e=>{e.stopPropagation();setTool('select');const note=addNote('correction',{x:target.x,y:target.y,w:Math.min(1-target.x,target.w),h:target.h,text:target.text,size:Math.max(6,Math.min(96,target.size)),sourceKey:target.key});beginInlineEdit(note);};
        layer.append(hit);
      }
    }
    for(const note of state.notes.filter(n=>n.page===state.page)) {
      const el=document.createElement('div');el.className=`annotation ${note.type}${state.selected===note.id?' selected':''}`;
      el.style.left=(note.x*100)+'%';el.style.top=(note.y*100)+'%';el.dataset.id=note.id;
      if(note.type==='text'||note.type==='correction') {
        el.textContent=note.text||'Seu texto';el.style.fontSize=(note.size*state.zoom*1.45)+'px';el.style.color=note.color;
        el.style.maxWidth=`${Math.max(2,(1-note.x)*100)}%`;
        if(note.type==='correction')el.style.minWidth=(note.w*100)+'%';
      } else { el.style.width=(note.width*100)+'%';const img=document.createElement('img');img.src=note.src;img.alt='Imagem inserida';el.append(img); }
      el.addEventListener('pointerdown',e=>startDrag(e,note,el));layer.append(el);
      if(note.type!=='image')el.addEventListener('dblclick',e=>{e.stopPropagation();beginInlineEdit(note);});
    }
  }
  function select(id) {
    state.selected=id;const note=state.notes.find(n=>n.id===id);
    // Preserve the element under the pointer while starting a drag. Rebuilding
    // the layer here would detach it before setPointerCapture can take effect.
    layer.querySelectorAll('.annotation').forEach(el=>el.classList.toggle('selected',el.dataset.id===id));
    if(!note){showPanel(state.pdf?'ocr':'intro');return;}
    showPanel('edit');$('textInput').value=note.text||'';$('textInput').disabled=note.type==='image';
    $('fontSize').value=note.size||18;$('fontSize').disabled=note.type==='image';
    $('textColor').value=note.color||'#1c293d';$('textColor').disabled=note.type==='image';
    $('imageWidth').value=Math.round((note.width||.35)*100);$('imageWidth').disabled=note.type!=='image';
  }
  function startDrag(e,note,el) {
    e.preventDefault();e.stopPropagation();select(note.id);
    if(note.type==='correction')return;
    const rect=layer.getBoundingClientRect(), x=e.clientX, y=e.clientY, initialX=note.x, initialY=note.y;
    el.setPointerCapture(e.pointerId);
    el.onpointermove=move=>{note.x=Math.max(0,Math.min(1-el.offsetWidth/rect.width,initialX+(move.clientX-x)/rect.width));note.y=Math.max(0,Math.min(1-el.offsetHeight/rect.height,initialY+(move.clientY-y)/rect.height));el.style.left=(note.x*100)+'%';el.style.top=(note.y*100)+'%';};
    el.onpointerup=el.onpointercancel=()=>{el.onpointermove=null;el.onpointerup=null;el.onpointercancel=null;};
  }
  function addNote(type, values={}) {
    const note={id:crypto.randomUUID(),page:state.page,type,x:.12,y:.16,text:'',size:18,color:'#1c293d',width:.35,...values};
    state.notes.push(note);renderNotes();select(note.id);
    if(type==='image')toast('Imagem inserida. Arraste para posicionar.');
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
    editor.style.fontSize=(note.size*state.zoom*1.45)+'px';editor.style.color=note.color;
    editor.style.width=Math.min(layer.clientWidth*(1-note.x),Math.max(180,el.offsetWidth+36))+'px';
    editor.style.height=Math.max(40,el.offsetHeight+14)+'px';
    editor.onpointerdown=e=>e.stopPropagation();editor.onclick=e=>e.stopPropagation();
    editor.oninput=()=>{note.text=editor.value;$('textInput').value=note.text;editor.style.height=Math.max(40,editor.scrollHeight+4)+'px';};
    editor.onkeydown=e=>{if(e.key==='Escape'){note.text=initial;editor.blur();}if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();editor.blur();}};
    const initial=note.text;
    editor.onblur=()=>{editor.remove();if(!note.text.trim()&&note.type==='text')state.notes=state.notes.filter(n=>n.id!==note.id);renderNotes();};
    layer.append(editor);editor.focus();editor.select();
  }
  async function openPdf(file) {
    if(!file) return;
    if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){toast('Escolha um arquivo PDF.');return;}
    try {
      setHint('Abrindo PDF...');const bytes=new Uint8Array(await file.arrayBuffer());
      const pdf=await pdfjsLib.getDocument({data:bytes.slice()}).promise;
      ++state.ocrRun;state.bytes=bytes;state.pdf=pdf;state.name=file.name;state.page=1;state.zoom=1;state.notes=[];state.selected=null;state.targets=[];
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
        if(nativeText.length>=12){state.ocr[p-1]={text:nativeText,words:[],scanned:false,ready:true};}
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
        if(p===state.page){$('ocrText').value=state.ocr[p-1].text;if(state.tool==='correct')renderNotes();}
        setStatus(`OCR ativo · ${p}/${n} páginas analisadas`);
      }
      if(run===state.ocrRun){setStatus('OCR concluído');toast('Texto de todas as páginas disponível.');}
    } catch(error){console.error(error);if(run===state.ocrRun){setStatus('OCR indisponível');$('ocrInfo').textContent='Não foi possível carregar o OCR. Confira sua conexão e recarregue a página. Você ainda pode editar e baixar o PDF.';toast('Falha no OCR. Verifique a conexão.');}}
    finally{if(worker) await worker.terminate();}
  }
  function cleanPdfText(s){return String(s).replace(/[^\x20-\x7e\xa0-\xff]/g,'?');}
  function hexColor(hex){return PDFLib.rgb(parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255);}
  async function exportPdf() {
    if(!state.pdf||state.busy)return;state.busy=true;$('saveTop').disabled=true;setHint('Preparando o PDF...');
    try{
      const doc=await PDFLib.PDFDocument.load(state.bytes.slice(),{ignoreEncryption:false});
      const font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      for(let p=0;p<doc.getPageCount();p++){
        const page=doc.getPage(p),{width:W,height:H}=page.getSize(), data=state.ocr[p];
        if(data?.scanned&&data.modified){
          const lines=data.text.split('\n').filter(Boolean);
          lines.forEach((line,i)=>page.drawText(cleanPdfText(line),{x:12,y:Math.max(12,H-20-i*11),size:9,font,opacity:0,maxWidth:W-24}));
        } else if(data?.scanned&&data.words.length){
          for(const [i,w] of data.words.entries()){
            if(state.notes.some(n=>n.page===p+1&&n.sourceKey===`scan-${i}`))continue;
            const text=cleanPdfText(w.text);if(!text.trim())continue;
            const size=Math.max(3,Math.min(60,w.h*H*.86));
            page.drawText(text,{x:w.x*W,y:H-(w.y+w.h)*H,size,font,opacity:0,maxWidth:Math.max(1,w.w*W*1.2)});
          }
        }
        for(const note of state.notes.filter(n=>n.page===p+1)){
          if(note.type==='text'||note.type==='correction'){
            const size=Math.max(6,Math.min(96,+note.size||18));
            if(note.type==='correction')page.drawRectangle({x:note.x*W,y:H-(note.y+note.h)*H,width:Math.min(W-note.x*W,note.w*W+3),height:note.h*H,color:PDFLib.rgb(1,1,1)});
            note.text.split('\n').forEach((line,i)=>{if(line)page.drawText(cleanPdfText(line),{x:note.x*W,y:H-note.y*H-size-i*size*1.25,size,font,color:hexColor(note.color)});});
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
    }catch(error){console.error(error);toast('Não foi possível salvar o PDF. Confira as imagens e tente novamente.');}
    finally{state.busy=false;updateControls();setHint('Arraste textos e imagens para posicionar');}
  }
  $('openTop').onclick=$('openEmpty').onclick=()=>$('pdfInput').click();
  $('pdfInput').onchange=e=>{openPdf(e.target.files[0]);e.target.value='';};
  $('saveTop').onclick=exportPdf;
  $('prevPage').onclick=async()=>{if(state.page>1){state.page--;select(null);await render();}};
  $('nextPage').onclick=async()=>{if(state.page<state.pdf.numPages){state.page++;select(null);await render();}};
  $('zoomIn').onclick=()=>{state.zoom=Math.min(1.75,Math.round((state.zoom+.15)*100)/100);render();};
  $('zoomOut').onclick=()=>{state.zoom=Math.max(.55,Math.round((state.zoom-.15)*100)/100);render();};
  document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{if(!state.pdf){toast('Abra um PDF primeiro.');return;}if(b.dataset.tool==='image'){$('imageInput').click();return;}setTool(b.dataset.tool);});
  $('ocrTab').onclick=()=>{showPanel('ocr');if(!state.pdf)toast('Abra um PDF para iniciar o OCR.');};
  layer.onclick=e=>{if(e.target!==layer)return;if(state.tool==='text'){const r=layer.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;setTool('select');beginInlineEdit(addNote('text',{x,y}));}else if(state.tool==='correct')toast('Clique diretamente em uma linha de texto para corrigir.');else select(null);};
  $('imageInput').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file||!state.pdf)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('Use uma imagem PNG, JPG ou WebP.');return;}
    try{let src,mime=file.type;const url=URL.createObjectURL(file);const img=new Image();img.src=url;await img.decode();
      if(file.type==='image/webp'){const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);src=c.toDataURL('image/png');mime='image/png';}else src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
      URL.revokeObjectURL(url);addNote('image',{src,mime,width:.35});setTool('select');
    }catch(error){console.error(error);toast('Não foi possível inserir esta imagem.');}
  };
  $('textInput').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){n.text=e.target.value;renderNotes();}};
  $('fontSize').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){n.size=+e.target.value;renderNotes();}};
  $('textColor').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){n.color=e.target.value;renderNotes();}};
  $('imageWidth').oninput=e=>{const n=state.notes.find(n=>n.id===state.selected);if(n){n.width=+e.target.value/100;renderNotes();}};
  $('deleteItem').onclick=()=>{state.notes=state.notes.filter(n=>n.id!==state.selected);select(null);toast('Elemento removido.');};
  $('ocrText').oninput=e=>{const n=state.ocr[state.page-1];if(n){n.text=e.target.value;n.modified=true;}};
  $('copyOcr').onclick=async()=>{try{await navigator.clipboard.writeText($('ocrText').value);toast('Texto copiado.');}catch{toast('Não foi possível copiar. Selecione o texto manualmente.');}};
  $('downloadTxt').onclick=()=>{if(!state.pdf)return toast('Abra um PDF primeiro.');const text=state.ocr.map((p,i)=>`--- Página ${i+1} ---\n${p.text}`).join('\n\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=state.name.replace(/\.pdf$/i,'')+'-ocr.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);};
  document.addEventListener('keydown',e=>{if((e.key==='Delete'||e.key==='Backspace')&&state.selected&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName))$('deleteItem').click();});
  let depth=0;document.addEventListener('dragenter',e=>{if([...e.dataTransfer?.types||[]].includes('Files')){e.preventDefault();depth++;$('dropOverlay').classList.remove('hidden');}});
  document.addEventListener('dragover',e=>{if([...e.dataTransfer?.types||[]].includes('Files'))e.preventDefault();});
  document.addEventListener('dragleave',e=>{e.preventDefault();if(--depth<=0){depth=0;$('dropOverlay').classList.add('hidden');}});
  document.addEventListener('drop',e=>{e.preventDefault();depth=0;$('dropOverlay').classList.add('hidden');openPdf([...e.dataTransfer.files].find(f=>/\.pdf$/i.test(f.name)||f.type==='application/pdf'));});
  if(!window.pdfjsLib||!window.PDFLib||!window.Tesseract){setHint('Falha ao carregar bibliotecas. Verifique a conexão e recarregue.');toast('Não foi possível iniciar o editor. Verifique sua conexão.');}
  else pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  updateControls();
})();
