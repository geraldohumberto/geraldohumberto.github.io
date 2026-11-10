/* Conservative editing of an existing PDF text-show operator. No redaction or overlay. */
window.PDFStudioStructural=(()=>{
  const decoder=new TextDecoder('windows-1252');
  const charBytes=new Map();
  for(let b=0;b<256;b++)charBytes.set(decoder.decode(Uint8Array.of(b)),b);
  const space=c=>/\s/.test(c)||c==='\0';
  function literalBytes(raw){
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
    return Uint8Array.from(bytes);
  }
  function hexBytes(raw){
    let hex=raw.slice(1,-1).replace(/\s/g,'');if(hex.length%2)hex+='0';
    const bytes=new Uint8Array(hex.length/2);
    for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);
    return bytes;
  }
  const textBytes=value=>value.type==='hex'?hexBytes(value.raw):literalBytes(value.raw);
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
  const named=(object,name)=>object.isName()&&object.asName()===name;
  const cidHex=code=>code.toString(16).toUpperCase().padStart(4,'0');
  const canonical=text=>text.normalize('NFC').replace(/\s+/g,'');
  const identity=[1,0,0,1,0,0];

  function glyphCount(stream){
    const bytes=stream.readStream().asUint8Array();
    if(bytes.length<12)return 0;
    const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const tables=data.getUint16(4);
    for(let i=12;i<12+tables*16&&i+16<=bytes.length;i+=16){
      if(data.getUint32(i)!==0x6d617870)continue; // TrueType maxp table.
      const offset=data.getUint32(i+8);
      return offset+6<=bytes.length?data.getUint16(offset+4):0;
    }
    return 0;
  }
  function unicodeMap(source,count){
    const map=new Map(),unicode=new TextDecoder('utf-16be',{fatal:true});
    const sourceCode=token=>/^<[0-9a-f]{4}>$/i.test(token?.raw)?parseInt(token.raw.slice(1,-1),16):NaN;
    const add=(code,raw)=>{
      if(code<=0||code>=count)return;
      if(!/^<(?:[0-9a-f]{4})+>$/i.test(raw))throw new Error('Mapeamento de fonte inválido.');
      const value=unicode.decode(hexBytes(raw)).normalize('NFC');
      if(value&&!value.includes('\0'))map.set(code,value);
    };
    for(const [,kind,body] of source.matchAll(/\bbegin(bfchar|bfrange)\b([\s\S]*?)\bend\1\b/g)){
      const values=tokens(body);
      for(let i=0;i<values.length;){
        const first=sourceCode(values[i++]);
        if(!Number.isFinite(first))return null;
        if(kind==='bfchar'){
          const to=values[i++];
          if(to?.type!=='hex')return null;
          add(first,to.raw);
          continue;
        }
        const last=sourceCode(values[i++]),to=values[i++];
        if(!Number.isFinite(last)||last<first||!to)return null;
        if(to.raw==='['){
          for(let code=first;code<=last;code++){
            const entry=values[i++];
            if(entry?.type!=='hex')return null;
            add(code,entry.raw);
          }
          if(values[i++]?.raw!==']')return null;
        }else{
          const start=sourceCode(to);
          if(!Number.isFinite(start)||start+last-first>0xffff)return null;
          for(let code=first;code<=Math.min(last,count-1);code++)add(code,'<'+cidHex(start+code-first)+'>');
        }
      }
    }
    return map.size?map:null;
  }
  function readCidFont(font){
    if(!named(font.get('Subtype'),'Type0')||!named(font.get('Encoding'),'Identity-H'))return null;
    const descendant=font.get('DescendantFonts').get(0).resolve();
    if(!named(descendant.get('Subtype'),'CIDFontType2'))return null;
    const gidMap=descendant.get('CIDToGIDMap');
    if(!gidMap.isNull()&&!named(gidMap,'Identity'))return null;
    const embedded=descendant.get('FontDescriptor').get('FontFile2'),cmap=font.get('ToUnicode');
    if(!embedded.isStream()||!cmap.isStream()||!cmap.get('UseCMap').isNull())return null;
    const count=glyphCount(embedded);
    const source=streamText(cmap.readStream().asUint8Array());
    if(!count||/\busecmap\b/.test(source))return null;
    const fromCode=unicodeMap(source,count);
    if(!fromCode)return null;
    const toCode=new Map();
    for(const [code,char] of fromCode)if(!toCode.has(char))toCode.set(char,code);

    const widths=new Map(),array=descendant.get('W');
    if(!array.isNull()&&!array.isArray())return null;
    for(let i=0;array.isArray()&&i<array.length;){
      const start=array.get(i++),entry=array.get(i++);
      if(!start.isInteger()||start.asNumber()<0)return null;
      const first=start.asNumber();
      if(entry.isArray()){
        for(let j=0;j<entry.length;j++)widths.set(first+j,entry.get(j).asNumber());
      }else{
        if(!entry.isInteger()||!array.get(i).isNumber())return null;
        const last=entry.asNumber(),width=array.get(i++).asNumber();
        for(let code=first;code<=Math.min(last,count-1);code++)widths.set(code,width);
      }
    }
    const dw=descendant.get('DW'),defaultWidth=dw.isNumber()?dw.asNumber():1000;
    return {fromCode,toCode,width:code=>widths.get(code)??defaultWidth};
  }
  function operands(items,end,count){
    const args=items.slice(end-count,end);
    if(args.length!==count||args.some(t=>t.type!=='word'||!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t.raw)))return null;
    const values=args.map(t=>Number(t.raw));
    return values.every(Number.isFinite)?values:null;
  }
  function multiply(a,b){
    return [
      a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],
      a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],
      a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]
    ];
  }
  function positionedRun(items,ctm,getFont){
    // One font and one horizontal line, with explicitly positioned Tj fragments.
    if(items[0]?.type!=='name'||items[2]?.raw!=='Tf'||items[9]?.raw!=='Tm'||items.at(-1)?.raw!=='Tj')return null;
    const fontSize=operands(items,2,1)?.[0],matrix=operands(items,9,6);
    if(!(fontSize>0)||!matrix)return null;
    const transform=multiply(ctm,matrix);
    if(transform[0]<=0||Math.abs(transform[1])>1e-6||Math.abs(transform[2])>1e-6)return null;
    const codec=getFont(items[0].raw.slice(1));
    if(!codec)return null;
    const glyphs=[];
    const width=code=>codec.width(code)*fontSize/1000;
    let lineX=0,i=10;
    while(i<items.length){
      const value=items[i++];
      if(!['string','hex'].includes(value.type)||items[i++]?.raw!=='Tj')return null;
      const bytes=textBytes(value);
      if(bytes.length%2)return null;
      let x=lineX;
      for(let j=0;j<bytes.length;j+=2){
        const code=bytes[j]*256+bytes[j+1],char=codec.fromCode.get(code),advance=width(code);
        if(!char||!Number.isFinite(advance)||advance<0)return null;
        glyphs.push({code,char,x,advance});
        x+=advance;
      }
      if(i===items.length)break;
      const offset=operands(items,i+2,2);
      if(!offset||offset[1]!==0||items[i+2]?.raw!=='Td')return null;
      lineX+=offset[0];i+=3;
    }
    if(!glyphs.length)return null;
    return {
      glyphs,codec,width,original:glyphs.map(glyph=>glyph.char).join(''),
      start:items[10].start,end:items.at(-1).end,origin:transform.slice(4),scale:transform[0]
    };
  }
  function candidates(page,original,origin){
    const found=[],runs=[],fontCache=new Map(),graphics=[];
    const fonts=page.getObject().getInheritable('Resources').get('Font');
    const getFont=name=>{
      if(!fontCache.has(name)){
        try{fontCache.set(name,readCidFont(fonts.get(name).resolve()));}
        catch{fontCache.set(name,null);}
      }
      return fontCache.get(name);
    };
    let ctm=identity;
    for(const stream of streams(page)){
      const src=streamText(stream.readStream().asUint8Array()),items=tokens(src);
      if(items.some(t=>t.type==='word'&&t.raw==='BI'))continue;
      const positioned=!items.some(t=>t.type==='word'&&['Tc','Tw','Tz','Ts','Tr'].includes(t.raw));
      let block=-1,font=null;
      for(let i=0;i<items.length;i++){
        const t=items[i];
        if(t.type!=='word')continue;
        if(t.raw==='BT'){block=i;font=null;continue;}
        if(t.raw==='ET'){
          if(block>=0&&positioned){
            const run=positionedRun(items.slice(block+1,i),ctm,getFont);
            if(run)runs.push({...run,stream,src});
          }
          block=-1;
          continue;
        }
        if(block<0){
          if(t.raw==='q')graphics.push(ctm);
          if(t.raw==='Q')ctm=graphics.pop()||identity;
          if(t.raw==='cm'){
            const matrix=operands(items,i,6);
            if(matrix)ctm=multiply(ctm,matrix);
          }
          continue;
        }
        if(t.raw==='Tf'){font=items[i-2]?.type==='name'?items[i-2].raw.slice(1):null;continue;}
        if(t.raw!=='Tj')continue;
        const value=items[i-1];if(!value||!['string','hex'].includes(value.type))continue;
        if(decoder.decode(textBytes(value))===original)found.push({stream,src,start:value.start,end:value.end,font});
      }
    }
    const normalized=canonical(original);
    for(const run of runs){
      if(canonical(run.original)!==normalized)continue;
      if(origin){
        const [x,y]=run.origin;
        const visibleX=x+(run.glyphs.find(glyph=>glyph.char.trim())?.x??0)*run.scale;
        if(Math.min(Math.hypot(x-origin[0],y-origin[1]),Math.hypot(visibleX-origin[0],y-origin[1]))>1.5)continue;
      }
      const next=runs.filter(other=>other.origin[0]>run.origin[0]&&Math.abs(other.origin[1]-run.origin[1])<1.5);
      const limit=Math.min(Infinity,...next.map(other=>(other.origin[0]-run.origin[0])/run.scale));
      const leading=original===original.trimStart()?run.original.match(/^\s*/)[0]:'';
      const trailing=original===original.trimEnd()?run.original.match(/\s*$/)[0]:'';
      found.push({...run,limit,leading,trailing});
    }
    return found;
  }
  function validate(page,original,origin){
    const matches=candidates(page,original,origin);
    if(matches.length!==1)throw new Error(matches.length?'Este texto aparece mais de uma vez na página; não consigo identificar o trecho com segurança.':'Este trecho usa uma codificação ou composição de texto que ainda não permite edição original.');
    const match=matches[0];
    if(match.codec)return match;
    if(!match.font)throw new Error('Não foi possível identificar a fonte original deste trecho.');
    const fontRef=page.getObject().getInheritable('Resources').get('Font').get(match.font);
    const font=fontRef.resolve(),base=font.get('BaseFont'),subtype=font.get('Subtype'),encoding=font.get('Encoding');
    const standard=/^(Helvetica|Times-Roman|Courier)(-Bold|-Oblique|-BoldOblique|-Italic|-BoldItalic)?$/;
    if(!base.isName()||!standard.test(base.asName())||!subtype.isName()||subtype.asName()!=='Type1'||!encoding.isName()||encoding.asName()!=='WinAnsiEncoding'||!font.get('ToUnicode').isNull()){
      throw new Error('A fonte incorporada ou a codificação deste trecho não permite a alteração original com segurança.');
    }
    return match;
  }
  function rewriteRun(match,text){
    if(!text)return '<> Tj';
    const {glyphs,codec,width,limit,leading,trailing}=match;
    const characters=[...(leading+text+trailing).normalize('NFC')];
    let prefix=0,oldTail=glyphs.length,newTail=characters.length;
    while(prefix<oldTail&&prefix<newTail&&glyphs[prefix].char===characters[prefix])prefix++;
    while(oldTail>prefix&&newTail>prefix&&glyphs[oldTail-1].char===characters[newTail-1]){
      oldTail--;newTail--;
    }
    const originalEnd=Math.max(...glyphs.map(glyph=>glyph.x+glyph.advance));
    let x=glyphs[prefix]?.x??originalEnd;
    const next=glyphs.slice(0,prefix);
    for(const char of characters.slice(prefix,newTail)){
      const code=codec.toCode.get(char);
      if(code===undefined)throw new Error(`A fonte incorporada não contém o caractere ${JSON.stringify(char)}.`);
      const advance=width(code);
      if(!Number.isFinite(advance)||advance<0)throw new Error('A largura de um caractere não pôde ser lida na fonte.');
      next.push({code,x,advance});
      x+=advance;
    }
    if(oldTail<glyphs.length){
      const before=glyphs[oldTail-1];
      const gap=oldTail>prefix?glyphs[oldTail].x-before.x-before.advance:0;
      const shift=x+gap-glyphs[oldTail].x;
      for(const glyph of glyphs.slice(oldTail))next.push({...glyph,x:glyph.x+shift});
    }
    if(next.some(glyph=>glyph.x+glyph.advance>Math.max(limit,originalEnd)+.05)){
      throw new Error('O novo texto é comprido demais para o espaço antes do próximo trecho.');
    }
    const commands=[];
    let hex='',lineX=0,cursor=0;
    for(const glyph of next){
      if(Math.abs(cursor-glyph.x)>.00001){
        commands.push('<'+hex+'> Tj');
        commands.push((glyph.x-lineX).toFixed(6)+' 0 Td');
        hex='';lineX=glyph.x;
      }
      hex+=cidHex(glyph.code);
      cursor=glyph.x+glyph.advance;
    }
    commands.push('<'+hex+'> Tj');
    return commands.join('\n');
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
    try{
      for(const change of changes){
        if(typeof change.text!=='string'||!change.original)throw new Error('Não foi possível identificar o texto a editar.');
        if(/[\r\n]/.test(change.text))throw new Error('Esta edição original aceita somente uma linha por trecho.');
        const page=doc.loadPage(change.page-1);
        const match=validate(page,change.original,change.origin);
        ensureExclusive(doc,change.page-1,match);
        const replacement=match.codec?rewriteRun(match,change.text):encodeHex(change.text);
        const key=match.stream.asIndirect();
        const patches=byStream.get(key)||{stream:match.stream,src:match.src,edits:[]};
        if(patches.edits.some(e=>match.start<e.end&&match.end>e.start))throw new Error('O mesmo trecho foi selecionado duas vezes.');
        patches.edits.push({start:match.start,end:match.end,replacement});
        byStream.set(key,patches);
      }
      for(const group of byStream.values()){
        let src=group.src;
        for(const e of group.edits.sort((a,b)=>b.start-a.start))src=src.slice(0,e.start)+e.replacement+src.slice(e.end);
        group.stream.writeStream(streamBytes(src));
      }
      return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    }finally{
      doc.destroy();
    }
  }
  function inspect(mupdf,bytes,pageIndex,original,origin){
    const doc=mupdf.Document.openDocument(bytes,'application/pdf');
    try{
      const match=validate(doc.loadPage(pageIndex),original,origin);
      ensureExclusive(doc,pageIndex,match);
      return true;
    }finally{
      doc.destroy();
    }
  }
  return {inspect,edit};
})();
