export type ScrollState={left:number;top:number;width:number;height:number;viewWidth:number;viewHeight:number};
export type WheelMotion={x:number;y:number;mode:number;shift:boolean;ctrl:boolean};
// Respect normal vertical scrolling. Shift explicitly selects horizontal;
// at a vertical boundary an ordinary wheel can reach the overflowing columns.
export function horizontalWheel(state:ScrollState,wheel:WheelMotion):number {
  if(wheel.ctrl||Math.abs(wheel.x)>.01||!wheel.y)return 0;
  const verticalRoom=wheel.y>0?state.height-state.viewHeight-state.top:state.top;
  if(!wheel.shift&&verticalRoom>1)return 0;
  const amount=wheel.y*(wheel.mode===1?24:wheel.mode===2?state.viewWidth:1);
  const next=Math.max(0,Math.min(state.width-state.viewWidth,state.left+amount));
  return next-state.left;
}
export function caretScroll(state:ScrollState,box:{x:number;y:number;w:number;h:number},margin=4){
  const delta=(start:number,size:number,view:number)=>start<margin?start-margin:start+size>view-margin?start+size-view+margin:0;
  return {left:Math.max(0,Math.min(Math.max(0,state.width-state.viewWidth),state.left+delta(box.x,box.w,state.viewWidth))),
    top:Math.max(0,Math.min(Math.max(0,state.height-state.viewHeight),state.top+delta(box.y,box.h,state.viewHeight)))};
}
