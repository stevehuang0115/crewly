import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@crewly/ui/Button';
import { FormSelect } from '@crewly/ui/Form';

interface CodeEditorProps {
  content: string;
  onChange: (content: string) => void;
  onSave?: () => void;
  language?: string;
  readOnly?: boolean;
  fileName?: string;
  theme?: 'light' | 'dark';
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  content,
  onChange,
  onSave,
  language = 'javascript',
  readOnly = false,
  fileName,
  theme = 'dark'
}) => {
  const [lineNumbers, setLineNumbers] = useState<number[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    updateLineNumbers();
  }, [content]);

  useEffect(() => {
    syncScroll();
  }, []);

  const updateLineNumbers = () => {
    const lines = content.split('\n');
    setLineNumbers(Array.from({ length: lines.length }, (_, i) => i + 1));
  };

  const syncScroll = () => {
    const textarea = textareaRef.current;
    const lineNumbersDiv = lineNumbersRef.current;
    
    if (textarea && lineNumbersDiv) {
      const handleScroll = () => {
        lineNumbersDiv.scrollTop = textarea.scrollTop;
      };
      
      textarea.addEventListener('scroll', handleScroll);
      return () => textarea.removeEventListener('scroll', handleScroll);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle tab for indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const spaces = language === 'python' ? '    ' : '  '; // 4 spaces for Python, 2 for others
      const newContent = content.substring(0, start) + spaces + content.substring(end);
      onChange(newContent);
      
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + spaces.length;
      }, 0);
    }

    // Handle Shift+Tab for unindent
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const lineStart = content.lastIndexOf('\n', start - 1) + 1;
      const lineContent = content.substring(lineStart, start);
      const spaces = language === 'python' ? '    ' : '  ';
      
      if (lineContent.startsWith(spaces)) {
        const newContent = content.substring(0, lineStart) + 
                          lineContent.substring(spaces.length) + 
                          content.substring(start);
        onChange(newContent);
        
        setTimeout(() => {
          target.selectionStart = target.selectionEnd = start - spaces.length;
        }, 0);
      }
    }

    // Handle Enter for auto-indentation
    if (e.key === 'Enter') {
      const target = e.currentTarget;
      const start = target.selectionStart;
      const lineStart = content.lastIndexOf('\n', start - 1) + 1;
      const lineContent = content.substring(lineStart, start);
      const indent = lineContent.match(/^(\s*)/)?.[1] || '';
      
      // Check if we need extra indentation (after {, [, (, :, etc.)
      const lastChar = content.substring(start - 1, start);
      const extraIndent = /[{[(:]/.test(lastChar) ? (language === 'python' ? '    ' : '  ') : '';
      
      setTimeout(() => {
        const newContent = content.substring(0, start) + '\n' + indent + extraIndent + content.substring(start);
        onChange(newContent);
        
        setTimeout(() => {
          target.selectionStart = target.selectionEnd = start + 1 + indent.length + extraIndent.length;
        }, 0);
      }, 0);
    }

    // Handle Ctrl+S for save
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (onSave) {
        onSave();
      }
    }

    // Handle Ctrl+A for select all
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const target = e.currentTarget;
      target.setSelectionRange(0, content.length);
    }

    // Handle Ctrl+Z for undo (basic implementation)
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      // In a real implementation, you'd maintain an undo stack
      console.log('Undo requested - implement undo stack');
    }

    // Handle Ctrl+Shift+Z or Ctrl+Y for redo
    if ((e.key === 'z' && e.ctrlKey && e.shiftKey) || (e.key === 'y' && e.ctrlKey)) {
      e.preventDefault();
      console.log('Redo requested - implement redo stack');
    }
  };

  const getLanguageIcon = (lang: string) => {
    switch (lang.toLowerCase()) {
      case 'javascript':
      case 'js':
        return '📄';
      case 'typescript':
      case 'ts':
        return '📘';
      case 'python':
      case 'py':
        return '🐍';
      case 'java':
        return '☕';
      case 'cpp':
      case 'c++':
      case 'c':
        return '⚙️';
      case 'html':
        return '🌐';
      case 'css':
      case 'scss':
        return '🎨';
      case 'json':
        return '📋';
      case 'yaml':
      case 'yml':
        return '⚙️';
      case 'markdown':
      case 'md':
        return '📝';
      default:
        return '📄';
    }
  };

  const formatCode = () => {
    // Basic code formatting - in a real implementation you'd use prettier or similar
    let formatted = content;
    
    // Basic indentation for common patterns
    if (language === 'javascript' || language === 'typescript') {
      formatted = formatted
        .replace(/{\s*\n/g, '{\n')
        .replace(/\n\s*}/g, '\n}')
        .replace(/;\s*\n/g, ';\n');
    }
    
    onChange(formatted);
  };

  const insertSnippet = (snippet: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newContent = content.substring(0, start) + snippet + content.substring(end);
    onChange(newContent);

    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + snippet.length;
    }, 0);
  };

  const getSnippets = () => {
    switch (language.toLowerCase()) {
      case 'javascript':
      case 'typescript':
        return [
          { label: 'function', code: 'function name() {\n  \n}' },
          { label: 'arrow function', code: 'const name = () => {\n  \n}' },
          { label: 'console.log', code: 'console.log()' },
          { label: 'if/else', code: 'if (condition) {\n  \n} else {\n  \n}' },
          { label: 'for loop', code: 'for (let i = 0; i < length; i++) {\n  \n}' },
          { label: 'try/catch', code: 'try {\n  \n} catch (error) {\n  console.error(error);\n}' }
        ];
      case 'python':
        return [
          { label: 'def', code: 'def function_name():\n    pass' },
          { label: 'class', code: 'class ClassName:\n    def __init__(self):\n        pass' },
          { label: 'if/else', code: 'if condition:\n    pass\nelse:\n    pass' },
          { label: 'for loop', code: 'for item in items:\n    pass' },
          { label: 'try/except', code: 'try:\n    pass\nexcept Exception as e:\n    print(f"Error: {e}")' }
        ];
      default:
        return [];
    }
  };

  return (
    <div className={`code-editor theme-${theme}`}>
      <div className="editor-header">
        <div className="file-info">
          {fileName && (
            <>
              <span className="file-icon">{getLanguageIcon(language)}</span>
              <span className="file-name">{fileName}</span>
            </>
          )}
          <span className="language-badge">{language.toUpperCase()}</span>
        </div>
        
        <div className="editor-actions">
          <Button
            variant="secondary"
            size="xs"
            onClick={formatCode}
            title="Format Code"
            disabled={readOnly}
          >
            Format
          </Button>
          
          {getSnippets().length > 0 && (
            <div className="snippets-dropdown">
              <FormSelect
                aria-label="Insert snippet"
                onChange={(e) => {
                  if (e.target.value) {
                    insertSnippet(e.target.value);
                    e.target.value = '';
                  }
                }}
                disabled={readOnly}
              >
                <option value="">Insert Snippet...</option>
                {getSnippets().map((snippet, index) => (
                  <option key={index} value={snippet.code}>
                    {snippet.label}
                  </option>
                ))}
              </FormSelect>
            </div>
          )}
          
          {onSave && (
            <Button
              size="xs"
              onClick={onSave}
              title="Save (Ctrl+S)"
            >
              Save
            </Button>
          )}
        </div>
      </div>

      <div className="editor-body">
        <div className="line-numbers" ref={lineNumbersRef}>
          {lineNumbers.map((lineNum) => (
            <div key={lineNum} className="line-number">
              {lineNum}
            </div>
          ))}
        </div>

        <textarea
          ref={textareaRef}
          className="code-textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          readOnly={readOnly}
          spellCheck={false}
          wrap="off"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      <div className="editor-footer">
        <div className="cursor-position">
          Line {content.substring(0, textareaRef.current?.selectionStart || 0).split('\n').length}
        </div>
        <div className="file-stats">
          {content.split('\n').length} lines • {content.length} characters
        </div>
        {readOnly && (
          <div className="readonly-indicator">
            Read Only
          </div>
        )}
      </div>
    </div>
  );
};