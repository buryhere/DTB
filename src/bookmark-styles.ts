export type BookmarkStyle = 'heart' | 'geometric' | 'pixel' | 'whale' | 'knot';
export const bookmarkStyles: {id: BookmarkStyle; name: string; description: string; colors: {name: string; paper: string; accent: string}[]}[] = [
  {id:'heart',name:'爱心缝线',description:'粉色缝线与柔白爱心',colors:[{name:'浅樱粉',paper:'#fff0f5',accent:'#a67585'},{name:'奶油白',paper:'#fff8f0',accent:'#a67585'}]},
  {id:'geometric',name:'极简几何',description:'青绿色横带 · 简洁燕尾',colors:[{name:'暖象牙白',paper:'#faf6ed',accent:'#587e7d'},{name:'浅薄荷绿',paper:'#eaf5ef',accent:'#527b70'}]},
  {id:'pixel',name:'像素科技',description:'亮青色像素带 · 深色轮廓',colors:[{name:'冰蓝色',paper:'#e9f7fc',accent:'#537f94'},{name:'浅蓝灰',paper:'#edf1f7',accent:'#617a91'}]},
  {id:'whale',name:'用户',description:'圆润小鲸鱼 · 海浪垂带',colors:[{name:'浅天蓝',paper:'#e6f1ff',accent:'#6786b0'},{name:'淡蓝白',paper:'#f1f7ff',accent:'#718cad'}]},
  {id:'knot',name:'中国结',description:'珊瑚花结 · 短连接带与流苏',colors:[{name:'暖米白',paper:'#fff7ec',accent:'#a67b6d'},{name:'浅杏桃',paper:'#fff0e8',accent:'#b48075'}]},
];
export function bookmarkStyle(value: unknown): BookmarkStyle {
  return bookmarkStyles.some(s=>s.id===value) ? value as BookmarkStyle : 'heart';
}
export function bookmarkMetrics(value: unknown) {
  const large=['whale','knot'].includes(bookmarkStyle(value));
  return {width:large?66:44,height:large?90:60,gutter:large?50:28};
}
