import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { TerminalOutput } from '@/types';

interface TerminalEmulatorProps {
  sessionName: string;
  terminalData: TerminalOutput[];
  onInput: (input: string) => void;
  className?: string;
}

export const TerminalEmulator: React.FC<TerminalEmulatorProps> = ({
  sessionName,
  terminalData,
  onInput,
  className = '',
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    if (!terminalRef.current || isInitialized) return;

    // Initialize terminal with new theme
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Fira Code", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#111721', // background-dark
        foreground: '#f6f7f8', // text-primary-dark
        cursor: '#2a73ea', // primary
        black: '#111721',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#2a73ea',
        magenta: '#8b5cf6',
        cyan: '#06b6d4',
        white: '#f6f7f8',
        brightBlack: '#313a48', // border-dark
        brightRed: '#f87171',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#a78bfa',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
      scrollback: 1000,
    });

    // Add addons
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());

    terminalInstance.current = terminal;
    fitAddon.current = fit;

    // Mount terminal
    terminal.open(terminalRef.current);
    fit.fit();

    // Handle input
    terminal.onData((data) => {
      onInput(data);
    });

    // Handle resize
    const handleResize = () => {
      if (fit) {
        fit.fit();
      }
    };

    window.addEventListener('resize', handleResize);
    setIsInitialized(true);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
      terminalInstance.current = null;
      fitAddon.current = null;
      setIsInitialized(false);
    };
  }, [terminalRef.current]);

  // Update terminal content when session changes or new data arrives
  useEffect(() => {
    if (!terminalInstance.current) return;

    const terminal = terminalInstance.current;

    // Clear terminal and display all content for this session
    terminal.clear();

    if (terminalData.length > 0) {
      // Combine all terminal outputs for this session
      const allContent = terminalData
        .map(output => output.content)
        .join('\n')
        .replace(/\n/g, '\r\n');

      terminal.write(allContent);

      // Scroll to bottom
      terminal.scrollToBottom();
    }
  }, [terminalData, sessionName]);

  // Fit terminal when component size changes
  useEffect(() => {
    if (fitAddon.current) {
      const timeoutId = setTimeout(() => {
        fitAddon.current?.fit();
      }, 100);
      
      return () => clearTimeout(timeoutId);
    }
  }, [className]);

  return (
    <div className={`relative bg-background-dark rounded-2xl border border-border-dark overflow-hidden ${className}`}>
      <div className="bg-surface-dark px-4 py-2 border-b border-border-dark">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="flex space-x-1">
              <div className="w-3 h-3 bg-red-500 rounded-full"></div>
              <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
              <div className="w-3 h-3 bg-green-500 rounded-full"></div>
            </div>
            <span className="text-sm font-medium text-text-primary-dark">
              {sessionName}
            </span>
          </div>
          <div className="text-xs text-text-secondary-dark">
            {terminalData.length > 0 && (
              <span>
                Last update: {new Date(terminalData[terminalData.length - 1]?.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>
      
      <div 
        ref={terminalRef} 
        className="h-96 p-2"
        style={{ minHeight: '400px' }}
      />
      
      {!isInitialized && (
        <div className="absolute inset-0 flex items-center justify-center bg-background-dark/50">
          <LoadingSpinner size="sm" inline text="Initializing terminal..." />
        </div>
      )}
    </div>
  );
};