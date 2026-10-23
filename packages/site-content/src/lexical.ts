import type { LexicalNode, RichText } from './types';

/** Minimal builders for Lexical editor state, used by the seed and the fallback content. */

const base = { format: '', indent: 0, version: 1, direction: 'ltr' as const };

const text = (value: string): LexicalNode => ({
  type: 'text',
  text: value,
  format: 0,
  detail: 0,
  mode: 'normal',
  style: '',
  version: 1,
});

export type RichBlock = string | { h2: string } | { h3: string } | { ul: string[] };

/** Plain strings become paragraphs; `{ h2 }`, `{ h3 }` headings; `{ ul: [...] }` a bullet list. */
export function richText(...blocks: RichBlock[]): RichText {
  const children = blocks.map((b): LexicalNode => {
    if (typeof b === 'string') {
      return { ...base, type: 'paragraph', textFormat: 0, textStyle: '', children: [text(b)] };
    }
    if ('ul' in b) {
      return {
        ...base,
        type: 'list',
        listType: 'bullet',
        tag: 'ul',
        start: 1,
        children: b.ul.map((item, i) => ({
          ...base,
          type: 'listitem',
          value: i + 1,
          children: [text(item)],
        })),
      };
    }
    const tag = 'h2' in b ? 'h2' : 'h3';
    return { ...base, type: 'heading', tag, children: [text('h2' in b ? b.h2 : b.h3)] };
  });
  return { root: { ...base, type: 'root', children } };
}

/** Plain text of a rich-text value (for excerpts, meta descriptions and tests). */
export function plainText(value: RichText | LexicalNode | null | undefined): string {
  if (!value) return '';
  const node = 'root' in value ? (value as RichText).root : (value as LexicalNode);
  if (typeof node.text === 'string') return node.text;
  const parts = (node.children ?? []).map((c) => plainText(c));
  const blockish = node.type === 'root' || node.type === 'list';
  return parts.join(blockish ? '\n' : '');
}
