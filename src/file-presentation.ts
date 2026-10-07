import type { Item } from './model';

const families = [
  { extensions: 'doc docx docm dot dotx dotm rtf odt', color: '#345ea0' },
  { extensions: 'xls xlsx xlsm xlsb xlt xltx xltm xla xlam csv ods', color: '#28734e' },
  { extensions: 'ppt pptx pptm pps ppsx ppsm pot potx potm sldx sldm odp', color: '#ac5034' },
  { extensions: 'one onepkg onetoc2', color: '#795498' },
  { extensions: 'mdb mde accdb accde accdr accdt', color: '#a34b61' },
  { extensions: 'vsd vsdx vsdm vst vstx vstm vss vssx vssm', color: '#4e6297' },
  { extensions: 'mpp mpt pub', color: '#3b776b' },
  { extensions: 'pdf', color: '#a74752' },
];
const documentColors = new Map(families.flatMap(f => f.extensions.split(' ').map(ext => [ext, f.color] as const)));
export function filePresentation(item: Item, lineHeight: number, freeBelow = lineHeight) {
  const title = item.title ?? item.path?.split(/[\\/]/).pop() ?? item.url ?? '';
  const ext = (item.ext?.trim().replace(/^\./, '') || (item.path ?? title).split(/[\\/]/).pop()?.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const color = item.type === 'file' ? documentColors.get(ext) : undefined;
  const named = !!color, below = named && lineHeight >= 40 && freeBelow >= 40;
  const labelSize = Math.max(9, Math.min(14, 11 * lineHeight / 24));
  const labelLines = below && lineHeight >= 56 && freeBelow >= 56 ? 2 : 1;
  const iconSize = Math.max(12, Math.min(32, lineHeight - (below ? labelSize * 1.2 * labelLines + 3 : 4)));
  const compact = named && !below;
  const label = compact && title.toLowerCase().endsWith('.' + ext) ? title.slice(0, -ext.length - 1) || title : title;
  return { title, ext, color, named, below, compact, label, labelSize, labelLines, iconSize, width: named ? 112 : iconSize };
}
