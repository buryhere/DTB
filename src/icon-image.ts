export function alphaBounds(rgba:ArrayLike<number>,width:number,height:number) {
  let left=width,right=-1,top=height,bottom=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(rgba[(y*width+x)*4+3]>24){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  return right<left?{x:0,y:0,w:width,h:height}:{x:left,y:top,w:right-left+1,h:bottom-top+1};
}
export function desktopBitmap(img:HTMLImageElement,size:number,reference?:HTMLImageElement):HTMLCanvasElement {
  const raw=document.createElement('canvas');raw.width=img.naturalWidth;raw.height=img.naturalHeight;
  const rc=raw.getContext('2d',{willReadFrequently:true})!;rc.drawImage(img,0,0);
  const box=alphaBounds(rc.getImageData(0,0,raw.width,raw.height).data,raw.width,raw.height);
  const result=document.createElement('canvas');result.width=result.height=Math.max(Math.ceil(size*2),Math.min(256,Math.max(box.w,box.h)));
  const context=result.getContext('2d')!;context.imageSmoothingQuality='high';
  if(reference){
    const native=document.createElement('canvas');native.width=reference.naturalWidth;native.height=reference.naturalHeight;
    const nc=native.getContext('2d',{willReadFrequently:true})!;nc.drawImage(reference,0,0);
    const visible=alphaBounds(nc.getImageData(0,0,native.width,native.height).data,native.width,native.height),scale=result.width/Math.max(native.width,native.height);
    const x=(result.width-native.width*scale)/2+visible.x*scale,y=(result.height-native.height*scale)/2+visible.y*scale;
    context.drawImage(img,box.x,box.y,box.w,box.h,x,y,visible.w*scale,visible.h*scale);
    // Large cached icon resources sometimes have a different drawing (or a
    // much smaller core inside an opaque/faint frame). Use the desktop-size
    // resource when the calibrated silhouette/colours still disagree.
    const check=document.createElement('canvas');check.width=check.height=32;const cc=check.getContext('2d',{willReadFrequently:true})!;cc.drawImage(result,0,0,32,32);const high=cc.getImageData(0,0,32,32).data;
    cc.clearRect(0,0,32,32);const fit=32/Math.max(native.width,native.height);cc.drawImage(reference,(32-native.width*fit)/2,(32-native.height*fit)/2,native.width*fit,native.height*fit);const small=cc.getImageData(0,0,32,32).data;
    let intersection=0,union=0,difference=0,weight=0;for(let i=0;i<small.length;i+=4){const a=high[i+3]>96,b=small[i+3]>96;if(a||b)union++;if(a&&b){intersection++;difference+=Math.abs(high[i]-small[i])+Math.abs(high[i+1]-small[i+1])+Math.abs(high[i+2]-small[i+2]);weight+=3*255;}}
    const similarity=union?intersection/union:1;result.dataset.similarity=String(similarity);
    const fallback=similarity<.82||(weight>0&&difference/weight>.22);
    result.dataset.source=fallback?'desktop-size':'high-resolution';
    if(fallback){context.clearRect(0,0,result.width,result.height);context.drawImage(reference,(result.width-native.width*scale)/2,(result.height-native.height*scale)/2,native.width*scale,native.height*scale);}
  }else {const scale=result.width*.96/Math.max(box.w,box.h),w=box.w*scale,h=box.h*scale;context.drawImage(img,box.x,box.y,box.w,box.h,(result.width-w)/2,(result.height-h)/2,w,h);}
  return result;
}
