/**
 * Conversation Group Card — V3 Request list grouping shell.
 *
 * Hosts one or more Request rows that share the same source conversation.
 * Keeps the grouping lightweight and scan-friendly so Request remains the
 * primary trackable object while conversation stays contextual.
 *
 * @module components/RequestTracking/ConversationGroupCard
 */

import React from 'react';
import { MessageSquare } from 'lucide-react';
import { Card } from '../UI/Card';

interface ConversationGroupCardProps {
  /** Source conversation identifier or fallback label */
  conversationLabel: string;
  /** Number of requests in the group */
  requestCount: number;
  /** Group body content */
  children: React.ReactNode;
}

/**
 * Renders a grouped request section keyed by source conversation.
 *
 * @param props - Group metadata and child request rows
 * @returns Group card JSX element
 */
export const ConversationGroupCard: React.FC<ConversationGroupCardProps> = ({
  conversationLabel,
  requestCount,
  children,
}) => {
  return (
    <Card
      variant="default"
      padding="none"
      className="overflow-hidden border-border-dark/80 bg-surface-dark/60"
      data-testid={`conversation-group-${conversationLabel}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-dark px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="h-4 w-4 text-text-secondary-dark flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-text-secondary-dark/70">
              Source Conversation
            </p>
            <p className="truncate text-sm font-medium text-text-primary-dark">
              {conversationLabel}
            </p>
          </div>
        </div>
        <span className="text-xs text-text-secondary-dark whitespace-nowrap">
          {requestCount} request{requestCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-2">{children}</div>
    </Card>
  );
};

ConversationGroupCard.displayName = 'ConversationGroupCard';

export default ConversationGroupCard;
