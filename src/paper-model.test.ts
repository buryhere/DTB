import {expect,it} from 'vitest';
import {compact,preserveBuffers,preserveInlineBuffers,emptyRow,migrateRows,mirrorItems,sliceParts} from './paper-model';
import type {PaperRow,PaperPart} from './paper-model';
import {alphaBounds} from './icon-image';
const row=(id:string,text:string,height=1):PaperRow=>({id,parts:[{text}],height});
it('keeps different per-character gap widths so saved caret positions do not drift',()=>{
 const parts:PaperPart[]=[{text:'  ',width:20},{text:' ',width:5}];expect(compact(parts)).toEqual(parts);expect(sliceParts(parts,1,3)).toEqual([{text:' ',width:10},{text:' ',width:5}]);
 expect(compact([{text:' ',width:10},{text:'  ',width:20}])).toEqual([{text:'   ',width:30}]);
});
it('new lines consume the empty buffer before moving a later note',()=>{
 const before=[row('a','first'),{...emptyRow(),id:'gap1'},{...emptyRow(),id:'gap2'},row('b','later')];
 const after=[row('a','first changed'),row('new','extra line'),...before.slice(1)];
 const next=preserveBuffers(before,after,'new');expect(next.findIndex(r=>r.id==='b')).toBe(3);expect(next.some(r=>r.id==='new')).toBe(true);
 const crowded=preserveBuffers([row('a','a'),row('b','b')],[row('a','edited'),row('new','more'),row('b','b')]);expect(crowded.findIndex(r=>r.id==='b')).toBe(2);
});
it('deleting earlier lines replenishes the buffer without pulling the later note up',()=>{
 const before=[row('a','a'),row('n','extra'),row('b','b')];const next=preserveBuffers(before,[row('a','a'),row('b','b')]);expect(next.findIndex(r=>r.id==='b')).toBe(2);
});
it('wrapping a row consumes blank space and preserves embedded file identity',()=>{
 const before=[row('a','short'),{...emptyRow(),id:'gap'},row('b','next')];
 const next=preserveBuffers(before,[row('a','long wrapped',2),before[1],before[2]]);expect(next.slice(0,next.findIndex(r=>r.id==='b')).reduce((n,r)=>n+r.height,0)).toBe(2);
 expect(sliceParts([{text:'abc'},{itemId:'pdf'},{text:'def'}],2,5)).toEqual([{text:'c'},{itemId:'pdf'},{text:'d'}]);
});
it('legacy paragraphs and file references migrate without losing text or IDs',()=>{
 const items=[{id:'a',boardId:'main',type:'text' as const,text:'first\nsecond',position:{x:24,y:48},createdAt:''},{id:'f',boardId:'main',type:'file' as const,path:'C:/doc.pdf',position:{x:24,y:144},createdAt:''}];
 const rows=migrateRows(items,500,24);expect(new Set(rows.map(r=>r.id)).size).toBe(rows.length);const mirrored=mirrorItems(rows,items,'main',24);
 expect(mirrored.filter(i=>i.type==='text').map(i=>i.text)).toEqual(['first','second']);expect(mirrored.find(i=>i.id==='f')?.path).toBe('C:/doc.pdf');
});
it('detects the artwork separately from a large transparent Shell image frame',()=>{
 const data=new Uint8Array(256*256*4);for(let y=100;y<140;y++)for(let x=90;x<150;x++)data[(y*256+x)*4+3]=255;
 expect(alphaBounds(data,256,256)).toEqual({x:90,y:100,w:60,h:40});
});
const measure=(parts:PaperPart[])=>parts.reduce((n,p)=>n+('text'in p?(p.width??Array.from(p.text).reduce((sum,c)=>sum+(c.charCodeAt(0)>255?13:7.2),0)):40),0);
it('inserting before a note consumes leading whitespace without moving the note or caret',()=>{
 const before=[{text:'          later'}];const next=preserveInlineBuffers(before,[{text:'  中文        later'}],measure,4);
 expect(measure(sliceParts(next.parts,0,next.parts.reduce((n,p)=>n+('text'in p?p.text.length:1),0)-5))).toBeCloseTo(72);
 expect(next.caret).toBe(4);expect(sliceParts(next.parts,0,next.caret).map(p=>'text'in p?p.text:'').join('')).toBe('  中文');
 expect(measure(before)).toBeCloseTo(measure(next.parts));
});
it('mixed-width insertions preserve an inline anchor repeatedly and buffer exhaustion allows movement',()=>{
 let parts:PaperPart[]=[{text:'a          later'}];const width=measure(parts);
 for(const c of ['中','a','文','b']){const next=[{text:c},...parts];parts=preserveInlineBuffers(parts,next,measure,1).parts;expect(measure(parts)).toBeCloseTo(width);}
 const exhausted=preserveInlineBuffers([{text:'a  later'}],[{text:'aaaaaaaa  later'}],measure,8);
 expect(exhausted.parts).toEqual([{text:'aaaaaaaalater'}]);
 expect(preserveInlineBuffers([{text:'a word'}],[{text:'ab word'}],measure,2).parts).toEqual([{text:'ab word'}]);
});
it('deleting earlier content replenishes an inline gap and file anchors keep their identities',()=>{
 const before:PaperPart[]=[{text:'first'},{text:'    ',width:28.8},{itemId:'pdf'}];
 const after:PaperPart[]=[{text:'fir'},{text:'    ',width:28.8},{itemId:'pdf'}];
 const next=preserveInlineBuffers(before,after,measure,3);expect(measure(next.parts)).toBeCloseTo(measure(before));expect(next.parts[next.parts.length-1]).toEqual({itemId:'pdf'});
 expect(sliceParts([{text:'    ',width:27}],1,3)).toEqual([{text:'  ',width:13.5}]);
 const mirrored=mirrorItems([{id:'note',parts:[{text:'  ',width:20},{text:'later'}],height:1}],[], 'main',24);
 expect(mirrored[0].id).toBe('note');expect(mirrored[0].position?.x).toBe(44);
});
