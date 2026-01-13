import { useState, useRef, useEffect } from 'react';
import './App.css';

interface EditorPanelProps {
  message: string;
  onMessageChange: (message: string) => void;
  onAnalyze: (message: string) => void;
  isLoading: boolean;
}

export function EditorPanel({
  message,
  onMessageChange,
  onAnalyze,
  isLoading,
}: EditorPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [message]);

  const handleAnalyze = () => {
    if (message.trim() && !isLoading) {
      onAnalyze(message.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Allow Ctrl/Cmd + Enter to trigger analysis
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleAnalyze();
    }
  };

  return (
    <div className="editor-panel">
      <div className="header">
        <div className="logo">
          <div className="logo-text">Communication Mirror</div>
        </div>
        <div className="tagline">
          Understand how your message may be emotionally perceived, before you send it.
        </div>
      </div>

      <div className="editor-container">
        <div className="editor-label">Your Message</div>
        <textarea
          ref={textareaRef}
          className="message-editor"
          placeholder="Type or paste your message here..."
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
        />
        <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
          <button
            className="analyze-button"
            onClick={handleAnalyze}
            disabled={isLoading || !message.trim()}
          >
            {isLoading ? 'Analyzing...' : 'Analyze Communication'}
          </button>
        </div>

        <div className="info-box">
          <strong>Note:</strong> This tool analyzes your message to help you understand its
          emotional impact - it does not rewrite it for you.
        </div>
      </div>
    </div>
  );
}
