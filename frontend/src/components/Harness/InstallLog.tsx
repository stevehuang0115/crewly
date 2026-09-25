/**
 * InstallLog
 *
 * Monospace, scrolling view of an install job's output that follows the
 * tail as new lines arrive.
 *
 * @module components/Harness/InstallLog
 */

import React, { useEffect, useRef } from 'react';

export interface InstallLogProps {
  /** Raw log text */
  log: string;
}

/**
 * Auto-scrolling install log.
 *
 * @param props - {@link InstallLogProps}
 * @returns Log block
 */
export const InstallLog: React.FC<InstallLogProps> = ({ log }) => {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);

  return (
    <pre
      ref={ref}
      role="log"
      aria-live="polite"
      aria-label="安装日志 / Install log"
      data-testid="install-log"
      className="mt-3 max-h-48 overflow-auto rounded-2xl border border-border-dark bg-background-dark p-3 font-mono text-xs leading-relaxed text-text-secondary-dark whitespace-pre-wrap break-all"
    >
      {log || '…'}
    </pre>
  );
};
