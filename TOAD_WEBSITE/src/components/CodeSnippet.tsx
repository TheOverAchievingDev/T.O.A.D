import './CodeSnippet.css';

interface CodeSnippetProps {
  code: string;
  language?: string;
}

const CodeSnippet = ({ code }: CodeSnippetProps) => {
  return (
    <div className="code-snippet">
      <div className="code-header">
        <span className="code-lang">TypeScript</span>
        <button className="copy-btn" onClick={() => navigator.clipboard.writeText(code)}>Copy</button>
      </div>
      <pre className="code-body">
        <code>{code}</code>
      </pre>
    </div>
  );
};

export default CodeSnippet;
