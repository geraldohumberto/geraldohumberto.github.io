/* Conservative editing of an existing PDF text-show operator. No redaction or overlay. */
window.PDFStudioStructural=(()=>{
  const decoder=new TextDecoder('windows-1252');
  const charBytes=new Map();
  for(let b=0;b<256;b++)charBytes.set(decoder.decode(Uint8Array.of(b)),b);
  const space=c=>/\s/.test(c)||c==='\0';
  function decodeLiteral(raw){
    const bytes=[];
    for(let i=1;i<raw.length-1;i++){
      let c=raw[i];
      if(c==='\\'){
        c=raw[++i];
        if(c==='\r'){if(raw[i+1]==='\n')i++;continue;}
        if(c==='\n')continue;
        if(/[0-7]/.test(c)){let oct=c;for(let k=0;k<2&&/[0-7]/.test(raw[i+1]||'');k++)oct+=raw[++i];bytes.push(parseInt(oct,8)&255);continue;}
        c=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'})[c]||c;
      }
      bytes.push(c.charCodeAt(0)&255);
    }
    return decoder.decode(Uint8Array.from(bytes));
  }
  function decodeHex(raw){
    let hex=raw.slice(1,-1).replace(/\s/g,'');if(hex.length%2)hex+='0';
    const bytes=new Uint8Array(hex.length/2);
    for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);
    return decoder.decode(bytes);
  }
  function encodeHex(text){
    let hex='';
    for(const c of text){const b=charBytes.get(c);if(b===undefined)throw new Error('A fonte original não codifica um dos novos caracteres.');hex+=b.toString(16).padStart(2,'0');}
    return '<'+hex.toUpperCase()+'>';
  }
  function tokens(src){
    const out=[];let i=0;
    while(i<src.length){
      if(space(src[i])){i++;continue;}
      if(src[i]==='%'){while(i<src.length&&src[i]!=='\n'&&src[i]!=='\r')i++;continue;}
      const start=i,c=src[i++];
      if(c==='('){let depth=1;while(i<src.length&&depth){if(src[i]==='\\'){i+=2;continue;}if(src[i]==='(')depth++;else if(src[i]===')')depth--;i++;}if(depth)throw new Error('Fluxo PDF com string incompleta.');out.push({type:'string',start,end:i,raw:src.slice(start,i)});continue;}
      if(c==='<'&&src[i]!=='<'){while(i<src.length&&src[i]!=='>')i++;if(i>=src.length)throw new Error('Fluxo PDF com string hexadecimal incompleta.');i++;out.push({type:'hex',start,end:i,raw:src.slice(start,i)});continue;}
      if((c==='<'&&src[i]==='<')||(c==='>'&&src[i]==='>')){i++;out.push({type:'other',start,end:i,raw:src.slice(start,i)});continue;}
      if(c==='['||c===']'||c==='{'||c==='}') {out.push({type:'other',start,end:i,raw:c});continue;}
      if(c==='/'){while(i<src.length&&!space(src[i])&&!/[\[\]()<>\/{%}]/.test(src[i]))i++;out.push({type:'name',start,end:i,raw:src.slice(start,i)});continue;}
      while(i<src.length&&!space(src[i])&&!/[\[\]()<>\/{%}]/.test(src[i]))i++;
      out.push({type:'word',start,end:i,raw:src.slice(start,i)});
    }
    return out;
  }
  function streamText(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return text;}
  function streamBytes(text){const out=new Uint8Array(text.length);for(let i=0;i<text.length;i++)out[i]=text.charCodeAt(i)&255;return out;}
  function streams(page){const o=page.getObject().get('Contents');return o.isArray()?Array.from({length:o.length},(_,i)=>o.get(i)):o.isStream()?[o]:[];}
  function candidates(page,original){
    const found=[];
    for(const stream of streams(page)){
      const src=streamText(stream.readStream().asUint8Array()),items=tokens(src);let inText=false,font=null;
      if(items.some(t=>t.type==='word'&&t.raw==='BI'))continue;
      for(let i=0;i<items.length;i++){
        const t=items[i];
        if(t.raw==='BT'&&t.type==='word'){inText=true;font=null;continue;}
        if(t.raw==='ET'&&t.type==='word'){inText=false;continue;}
        if(!inText)continue;
        if(t.raw==='Tf'&&t.type==='word'){font=items[i-2]?.type==='name'?items[i-2].raw.slice(1):null;continue;}
        if(t.raw!=='Tj'||t.type!=='word')continue;
        const value=items[i-1];if(!value||!['string','hex'].includes(value.type))continue;
        const decoded=value.type==='hex'?decodeHex(value.raw):decodeLiteral(value.raw);
        if(decoded===original)found.push({stream,src,value,font});
      }
    }
    return found;
  }
  function validate(page,original){
    const matches=candidates(page,original);
    if(matches.length!==1)throw new Error(matches.length?'Este texto aparece mais de uma vez na página; não consigo identificar o trecho com segurança.':'Este trecho usa uma codificação ou composição de texto que ainda não permite edição original.');
    const match=matches[0];
    if(!match.font)throw new Error('Não foi possível identificar a fonte original deste trecho.');
    const fontRef=page.getObject().getInheritable('Resources').get('Font').get(match.font);
    const font=fontRef.resolve(),base=font.get('BaseFont'),subtype=font.get('Subtype'),encoding=font.get('Encoding');
    const standard=/^(Helvetica|Times-Roman|Courier)(-Bold|-Oblique|-BoldOblique|-Italic|-BoldItalic)?$/;
    if(!base.isName()||!standard.test(base.asName())||!subtype.isName()||subtype.asName()!=='Type1'||!encoding.isName()||encoding.asName()!=='WinAnsiEncoding'||!font.get('ToUnicode').isNull()){
      throw new Error('A fonte incorporada ou a codificação deste trecho não permite a alteração original com segurança.');
    }
    return match;
  }
  function ensureExclusive(doc,pageIndex,match){
    const id=match.stream.asIndirect();
    for(let i=0;i<doc.countPages();i++){
      if(i===pageIndex)continue;
      if(streams(doc.loadPage(i)).some(s=>s.asIndirect()===id))throw new Error('Este fluxo de texto é compartilhado com outra página; a edição original foi bloqueada para não alterar ambas.');
    }
  }
  function edit(mupdf,bytes,changes){
    const doc=mupdf.Document.openDocument(bytes,'application/pdf'),byStream=new Map();
    for(const change of changes){
      if(typeof change.text!=='string'||!change.original)throw new Error('Não foi possível identificar o texto a editar.');
      if(/[\r\n]/.test(change.text))throw new Error('Esta edição original aceita somente uma linha por trecho.');
      const page=doc.loadPage(change.page-1),match=validate(page,change.original);ensureExclusive(doc,change.page-1,match);
      const replacement=encodeHex(change.text),key=match.stream.asIndirect();
      const patches=byStream.get(key)||{stream:match.stream,src:match.src,edits:[]};
      if(patches.edits.some(e=>e.start===match.value.start))throw new Error('O mesmo trecho foi selecionado duas vezes.');
      patches.edits.push({start:match.value.start,end:match.value.end,replacement});byStream.set(key,patches);
    }
    for(const group of byStream.values()){
      let src=group.src;
      for(const e of group.edits.sort((a,b)=>b.start-a.start))src=src.slice(0,e.start)+e.replacement+src.slice(e.end);
      group.stream.writeStream(streamBytes(src));
    }
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  }
  function inspect(mupdf,bytes,pageIndex,original){const doc=mupdf.Document.openDocument(bytes,'application/pdf');const match=validate(doc.loadPage(pageIndex),original);ensureExclusive(doc,pageIndex,match);return true;}
  return {inspect,edit};
})();
