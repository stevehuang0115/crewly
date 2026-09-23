import React from 'react';

export interface CrewlyRootProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The app, screen or fragment to render on Crewly's surface */
  children: React.ReactNode;
}

/**
 * Crewly's page surface: the dark background, Nunito and the primary text
 * color every component here is designed against.
 *
 * Crewly is dark-only. The OSS app and the Cloud portal set this on <body>;
 * anything rendered elsewhere (an embed, a design mock, a preview) wraps its
 * content in CrewlyRoot so the components are not shown on a white page.
 *
 * @param props - Children plus any div attributes (className is appended)
 * @returns A div with the Crewly surface applied
 *
 * @example
 * ```tsx
 * <CrewlyRoot className="min-h-screen p-6">
 *   <Card><Button>Start agent</Button></Card>
 * </CrewlyRoot>
 * ```
 */
export const CrewlyRoot: React.FC<CrewlyRootProps> = ({ children, className = '', ...props }) => (
  <div className={`bg-background-dark text-text-primary-dark font-sans antialiased ${className}`.trim()} {...props}>
    {children}
  </div>
);
