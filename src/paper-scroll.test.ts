import {expect,it} from 'vitest';
import {caretScroll,horizontalWheel} from './paper-scroll';
const state={left:0,top:0,width:800,height:1000,viewWidth:300,viewHeight:200};
it('keeps vertical wheel scrolling and uses Shift or a boundary to reach columns',()=>{
 expect(horizontalWheel(state,{x:0,y:100,mode:0,shift:false,ctrl:false})).toBe(0);
 expect(horizontalWheel(state,{x:0,y:100,mode:0,shift:true,ctrl:false})).toBe(100);
 expect(horizontalWheel({...state,top:800},{x:0,y:100,mode:0,shift:false,ctrl:false})).toBe(100);
 expect(horizontalWheel({...state,left:480,top:800},{x:0,y:100,mode:0,shift:false,ctrl:false})).toBe(20);
 expect(horizontalWheel({...state,left:100},{x:0,y:-100,mode:0,shift:false,ctrl:false})).toBe(-100);
});
it('preserves trackpad and zoom gestures and converts line/page wheel units',()=>{
 expect(horizontalWheel(state,{x:100,y:100,mode:0,shift:true,ctrl:false})).toBe(0);
 expect(horizontalWheel(state,{x:0,y:100,mode:0,shift:true,ctrl:true})).toBe(0);
 expect(horizontalWheel(state,{x:0,y:2,mode:1,shift:true,ctrl:false})).toBe(48);
 expect(horizontalWheel(state,{x:0,y:1,mode:2,shift:true,ctrl:false})).toBe(300);
});
it('reveals only an offscreen caret and clamps movement to the paper extent',()=>{
 expect(caretScroll(state,{x:290,y:190,w:0,h:15})).toEqual({left:0,top:9});
 expect(caretScroll(state,{x:550,y:410,w:0,h:15})).toEqual({left:254,top:229});
 expect(caretScroll({...state,left:200,top:300},{x:-10,y:-20,w:0,h:15})).toEqual({left:186,top:276});
 expect(caretScroll(state,{x:900,y:2000,w:0,h:15})).toEqual({left:500,top:800});
});
