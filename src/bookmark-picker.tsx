import { X } from 'lucide-react';
import { BookmarkArt } from './bookmark';
import { bookmarkStyle, bookmarkStyles } from './bookmark-styles';
import type { Board } from './model';

export function BookmarkPicker({board,onChange,onClose}: {board:Board;onChange:(patch:Partial<Board>)=>void;onClose:()=>void}) {
  const selected=bookmarkStyle(board.bookmarkStyle), current=bookmarkStyles.find(s=>s.id===selected)!;
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section className="modal bookmark-picker" aria-label="书签样式">
      <header><h2>书签样式</h2><button aria-label="关闭书签样式" onClick={onClose}><X size={18}/></button></header>
      <p>选一枚书签陪伴你的笔记</p>
      <div className="bookmark-choices">{bookmarkStyles.map(s=><button key={s.id} className={`bookmark-choice ${s.id===selected?'selected':''}`} aria-label={`书签样式：${s.name}`} aria-pressed={s.id===selected} onClick={()=>onChange({bookmarkStyle:s.id})}>
        <span className={`bookmark-sample ${s.id==='whale'||s.id==='knot'?'large':''}`}><BookmarkArt style={s.id}/></span><strong>{s.name}</strong><small>{s.description}</small>
      </button>)}</div>
      <h3>推荐背景色 · {current.name}</h3>
      <div className="bookmark-palettes">{current.colors.map(c=><button key={c.paper} aria-label={`应用推荐背景：${c.name}`} onClick={()=>onChange({theme:{...board.theme,paper:c.paper,accent:c.accent}})}><span style={{background:c.paper,borderColor:c.accent}}/>{c.name}</button>)}</div>
      <p className="bookmark-color-note">推荐配色点击后才应用；自定义颜色可在“外观与设置”中调整。</p>
      <button className="primary" onClick={onClose}>完成</button>
    </section>
  </div>;
}
