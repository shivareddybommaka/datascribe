import type { LexicalNode, RichText as RichTextValue } from '@datascribe/site-content';
import type { ReactNode } from 'react';

/**
 * Renders Payload's Lexical JSON as React (paragraphs, headings, lists, quotes, links, bold/italic/
 * underline/code). Unknown nodes render their children, so nothing is ever injected as raw HTML.
 */

const safeHref = (url: string | undefined) =>
  url && /^(https?:\/\/|\/(?!\/)|mailto:)/.test(url) ? url : undefined;

function renderText(node: LexicalNode, key: number): ReactNode {
  const format = typeof node.format === 'number' ? node.format : 0;
  let out: ReactNode = node.text ?? '';
  if (format & 16) out = <code>{out}</code>;
  if (format & 8) out = <u>{out}</u>;
  if (format & 2) out = <em>{out}</em>;
  if (format & 1) out = <strong>{out}</strong>;
  return <span key={key}>{out}</span>;
}

function renderNode(node: LexicalNode, key: number): ReactNode {
  const children = (node.children ?? []).map(renderNode);
  switch (node.type) {
    case 'text':
      return renderText(node, key);
    case 'linebreak':
      return <br key={key} />;
    case 'paragraph':
      return <p key={key}>{children}</p>;
    case 'heading': {
      const Tag = (['h2', 'h3', 'h4'].includes(node.tag ?? '') ? node.tag : 'h2') as
        'h2' | 'h3' | 'h4';
      return <Tag key={key}>{children}</Tag>;
    }
    case 'list':
      return node.listType === 'number' ? (
        <ol key={key}>{children}</ol>
      ) : (
        <ul key={key}>{children}</ul>
      );
    case 'listitem':
      return <li key={key}>{children}</li>;
    case 'quote':
      return <blockquote key={key}>{children}</blockquote>;
    case 'link':
    case 'autolink': {
      const href = safeHref(node.fields?.url ?? node.url);
      if (!href) return <span key={key}>{children}</span>;
      const external = /^https?:\/\//.test(href);
      return (
        <a key={key} href={href} {...(external ? { rel: 'noopener noreferrer' } : {})}>
          {children}
        </a>
      );
    }
    default:
      return <span key={key}>{children}</span>;
  }
}

export function RichText({
  value,
  className,
}: {
  value: RichTextValue | null | undefined;
  className?: string;
}) {
  if (!value?.root) return null;
  return (
    <div className={className ?? 'prose-ds'}>{(value.root.children ?? []).map(renderNode)}</div>
  );
}
