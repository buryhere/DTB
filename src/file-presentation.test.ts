import { expect, it } from 'vitest';
import { filePresentation } from './file-presentation';
import type { Item } from './model';
const item: Item = {id:'file',boardId:'main',type:'file',path:'C:/dir.pptx/报告.PPTX',title:'报告.PPTX',createdAt:''};
it('recognizes legacy, macro and template documents, case-insensitively, including records without ext',()=>{
  for(const ext of ['doc','docm','dotx','xlsx','xltm','xlsb','ppt','ppsx','potm','onepkg','accdb','vsdx','mpp','pub','pdf']) expect(filePresentation({...item,ext:ext.toUpperCase()},24).named).toBe(true);
  expect(filePresentation(item,24)).toMatchObject({ext:'pptx',compact:true,label:'报告'});
  expect(filePresentation({...item,type:'folder'},24).named).toBe(false);
  expect(filePresentation({...item,ext:'lnk'},24).named).toBe(false);
  expect(filePresentation({...item,path:'C:/dir.pptx/archive.zip',title:'archive.zip'},24).named).toBe(false);
});
it('switches names below icons only when the row has room and keeps document width stable',()=>{
  for(const spacing of [16,24,39,40,48,64])expect(filePresentation(item,spacing).width).toBe(112);
  expect(filePresentation(item,39).compact).toBe(true);expect(filePresentation(item,40).below).toBe(true);
  expect(filePresentation(item,48,24).compact).toBe(true);expect(filePresentation(item,64)).toMatchObject({below:true,labelLines:2,label:'报告.PPTX'});
});
