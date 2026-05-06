import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownPreviewProps {
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div className="markdown-body" style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content || '*No content*'}
      </ReactMarkdown>
    </div>
  );
}
