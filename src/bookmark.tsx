import { useId } from 'react';
import { bookmarkStyle } from './bookmark-styles';
import type { BookmarkStyle } from './bookmark-styles';
import whale from './assets/bookmarks/whale.png';
import knot from './assets/bookmarks/knot.png';
import pixel from './assets/bookmarks/pixel-v2.png';

export function Bookmark({ armed, hidden, edge, disabled, onClick, style }: {
  armed: boolean; hidden: boolean; edge: 'left' | 'right' | 'top' | 'bottom' | null;
  disabled: boolean; onClick: () => void; style?: BookmarkStyle;
}) {
  const label = armed ? '展开板子并退出贴边收缩' : '书签：开启贴边收缩';
  return <button data-style={bookmarkStyle(style)} className={`bookmark ${armed ? 'armed' : ''} ${hidden ? `bookmark-hidden bookmark-${edge}` : ''}`}
    aria-label={label} aria-pressed={armed} disabled={disabled} onClick={onClick}
    title={armed ? '贴边收缩已开启：贴近屏幕边缘，移开鼠标 1 秒后隐藏。点击书签展开并关闭收缩。' : '点击书签开启贴边收缩，再拖到屏幕边缘；移开鼠标 1 秒后只露出书签。'}>
    <BookmarkArt style={style}/>
  </button>;
}

// The native controller compensates gutter changes to keep the paper on screen.
export function BookmarkArt({style}: {style?: BookmarkStyle}) {
  const id = useId().replace(/:/g, '');
  const selected = bookmarkStyle(style);
  if (selected==='geometric') return <svg className="bookmark-art" viewBox="0 0 44 60" aria-hidden="true"><defs><linearGradient id={`${id}-teal`} x2="1" y2="1"><stop stopColor="#408f96"/><stop offset="1" stopColor="#19626d"/></linearGradient></defs><path className="bookmark-ribbon" d="M2 12H44V36H2L12 24Z" fill={`url(#${id}-teal)`} stroke="#164b56" strokeWidth="1"/><path d="M4 14H44M4 34H44" stroke="#9cd2cf" strokeWidth=".8" opacity=".5"/></svg>;
  if (selected==='pixel') return <svg className="bookmark-art pixel-art" viewBox="198 101 973 1002" preserveAspectRatio="xMaxYMid meet" aria-hidden="true"><image href={pixel} width="1289" height="1220"/></svg>;
  // SVG viewport uses the measured silhouette bounds; the original PNG alpha
  // remains untouched and its intrinsic white details are preserved.
  if (selected==='whale'||selected==='knot') return <svg className="bookmark-art" viewBox={selected==='whale'?'102 20 847 1468':'184 281 732 914'} preserveAspectRatio="xMaxYMid meet" aria-hidden="true"><image href={selected==='whale'?whale:knot} width={selected==='whale'?1024:1070} height={selected==='whale'?1536:1470}/></svg>;
  return <svg className="bookmark-art" viewBox="0 0 48 60" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-rose`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#e3a5b4"/><stop offset=".5" stopColor="#cf8b9e"/><stop offset="1" stopColor="#b86c86"/></linearGradient>
        <linearGradient id={`${id}-heart`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fffafc"/><stop offset="1" stopColor="#f9d5e2"/></linearGradient>
      </defs>
      <path className="bookmark-ribbon" d="M8 3H47V57L25 46L8 57Q3 59 3 53V10Q3 3 8 3Z" fill={`url(#${id}-rose)`} stroke="#a7657e" strokeWidth="1.2"/>
      <path d="M8 6H44V52L25 42L8 52Q6 54 6 50V11Q6 6 8 6Z" fill="none" stroke="#f9d3df" strokeWidth=".9" opacity=".65"/>
      <path d="M10 8H42V48L25 39L10 48V10" fill="none" stroke="#8f536d" strokeWidth=".75" strokeDasharray="1.4 1.6" opacity=".44"/>
      <path className="bookmark-heart" d="M25 33C22 31 15 26 15 21C15 15 22 14 25 19C28 14 35 15 35 21C35 26 28 31 25 33Z" fill={`url(#${id}-heart)`} stroke="#fff3f8" strokeWidth="1.2"/>
    </svg>;
}
