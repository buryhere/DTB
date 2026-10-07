import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { File, FileText, Folder, Image, Link, ArrowUpRight } from 'lucide-react';
import type { Item } from './model';
import { native } from './host';
import { filePresentation } from './file-presentation';

const cache = new Map<string, string>();
export function FileTile({ item, lineHeight, freeBelow, locked }: { item: Item; lineHeight: number; freeBelow: number; locked: boolean }) {
  const [icon, setIcon] = useState(cache.get(item.path ?? ''));
  const { named, below, compact, title, ext, color, label, labelSize, labelLines, iconSize: size, width } = filePresentation(item, lineHeight, freeBelow);
  useEffect(() => {
    setIcon(cache.get(item.path ?? ''));
    if (compact || !native || !item.path || cache.has(item.path)) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const load = async (attempt: number) => {
      try {
        const value = await invoke<string>('read_item_icon', { id: item.id });
        if (active) { cache.set(item.path!, value); setIcon(value); }
      } catch {
        // Newly dropped items are registered by the next debounced save.
        if (active && attempt < 2) timer = setTimeout(() => { load(attempt + 1); }, 600);
      }
    };
    timer = setTimeout(() => { load(0); }, 50);
    return () => { active = false; clearTimeout(timer); };
  }, [item.id, item.path, compact]);
  const fallback = item.type === 'folder' ? <Folder /> : item.type === 'link' ? <Link /> : named ? <FileText /> : /^(png|jpg|jpeg|webp|gif)$/i.test(item.ext ?? '') ? <Image /> : <File />;
  return <div className={`file-tile ${below ? 'name-below' : compact ? 'document-compact' : 'name-beside'} ${named ? 'named-file' : 'icon-only'}`} title={locked ? undefined : title} aria-label={title} style={{ '--file-icon-size': `${size}px`, '--file-label-lines': labelLines, '--file-label-size':`${labelSize}px`, '--file-width':`${width}px`, '--file-type-color':color, '--file-type-size':`${Math.max(7, labelSize*.65)}px`, '--file-type-top':`${Math.max(0,(lineHeight-labelSize*1.2)/2-5)}px` } as React.CSSProperties}>
    {compact ? <span className="file-type" aria-hidden="true">{ext.toUpperCase()}</span> : <span className="file-icon">{icon ? <img src={icon} alt="" draggable={false} /> : <>{fallback}{ext === 'lnk' && <ArrowUpRight className="badge" />}</>}</span>}
    {named && <strong className="file-name">{label}</strong>}
  </div>;
}
