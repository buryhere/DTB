import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Item } from './model';
import { native } from './host';
export function Preview({ item, onClose }: { item: Item; onClose: () => void }) {
  const [text, setText] = useState(''), [image, setImage] = useState(''), [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let disposed = false; let cleanup: (() => void) | undefined;
    const load = async () => {
      if (item.type === 'text') { setText(item.text ?? ''); return; }
      if (item.type === 'link') { setText(item.url ?? ''); return; }
      if (!native) { setError('文件预览请在桌面应用中使用。'); return; }
      const data = await invoke<{ base64: string; ext: string }>('read_preview', { id: item.id });
      if (disposed) return;
      const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(data.ext)) { const url = URL.createObjectURL(new Blob([bytes])); setImage(url); cleanup = () => URL.revokeObjectURL(url); }
      else if (data.ext === 'pdf') {
        const pdfjs = await import('pdfjs-dist'); const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const task = pdfjs.getDocument({ data: bytes }); cleanup = () => { task.destroy(); };
        const pdf = await task.promise; if (disposed || !canvas.current) return;
        const page = await pdf.getPage(1), viewport = page.getViewport({ scale: .8 }), target = canvas.current;
        target.width = viewport.width; target.height = viewport.height;
        await page.render({ canvas: target, canvasContext: target.getContext('2d')!, viewport }).promise;
      } else setText(new TextDecoder('utf-8').decode(bytes));
    }; load().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; cleanup?.(); };
  }, [item]);
  return <div className="modal-backdrop"><section className="modal"><header><h2>{item.title ?? (item.type === 'text' ? '待办内容' : '文件预览')}</h2><button aria-label="关闭预览" onClick={onClose}><X size={18} /></button></header><div className="preview-content">{error ? <p>{error}</p> : image ? <img src={image} alt={item.title ?? '图片预览'} /> : item.ext === 'pdf' ? <canvas ref={canvas} /> : item.ext === 'md' ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(text, { async: false }), { FORBID_TAGS: ['img', 'iframe', 'style'], FORBID_ATTR: ['style'] }) }} /> : <pre>{text}</pre>}</div></section></div>;
}
