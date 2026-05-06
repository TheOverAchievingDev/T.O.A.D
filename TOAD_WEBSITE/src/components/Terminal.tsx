import { useState, useEffect } from 'react';
import './Terminal.css';

interface TerminalProps {
  commands: { command: string; response: string | React.ReactNode }[];
}

const Terminal = ({ commands }: TerminalProps) => {
  const [visibleLines, setVisibleLines] = useState<number>(0);

  useEffect(() => {
    if (visibleLines < commands.length) {
      const timer = setTimeout(() => {
        setVisibleLines(prev => prev + 1);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [visibleLines, commands.length]);

  return (
    <div className="terminal-window">
      <div className="terminal-header">
        <div className="terminal-buttons">
          <span className="terminal-button red"></span>
          <span className="terminal-button yellow"></span>
          <span className="terminal-button green"></span>
        </div>
        <div className="terminal-title">bash — portfolio</div>
      </div>
      <div className="terminal-body">
        {commands.slice(0, visibleLines).map((item, index) => (
          <div key={index} className="terminal-line-group">
            <div className="terminal-line command">
              <span className="prompt">$</span> {item.command}
            </div>
            <div className="terminal-line response">{item.response}</div>
          </div>
        ))}
        {visibleLines < commands.length && (
          <div className="terminal-line command">
            <span className="prompt">$</span>
            <span className="cursor">|</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default Terminal;
