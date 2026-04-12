import React from 'react';
import { Button, useConfirm } from '../UI';
import { MessageDeliveryLog } from './types';
import { EmptyState } from './EmptyState';

interface DeliveryLogsTableProps {
  deliveryLogs: MessageDeliveryLog[];
  formatDate: (dateString: string) => string;
  onClearLogs: () => Promise<void>;
}

export const DeliveryLogsTable: React.FC<DeliveryLogsTableProps> = ({
  deliveryLogs = [],
  formatDate,
  onClearLogs
}) => {  const { showConfirm, ConfirmComponent } = useConfirm();
  const handleClearLogs = async () => {
    showConfirm('This will permanently clear all message delivery logs.\nThis action cannot be undone.', async () => { await onClearLogs(); }, { title: 'Clear Delivery Logs', confirmText: 'Clear Logs', type: 'warning' });
  };
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Message Delivery Logs</h3>
        <Button variant="outline" size="sm" onClick={handleClearLogs}>
          Clear Logs
        </Button>
      </div>

      {deliveryLogs.length > 0 ? (
        <div className="bg-surface-dark border border-border-dark rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-background-dark/60 border-b border-border-dark">
                <tr>
                  <th scope="col" className="py-2 px-3 text-left font-medium text-text-primary-dark">Time</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-text-primary-dark">Message</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-text-primary-dark">Target</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-text-primary-dark">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-dark">
                {deliveryLogs.slice(0, 50).map((log) => (
                  <tr key={log.id} className="border-t border-border-dark hover:bg-background-dark/50">
                    <td className="whitespace-nowrap py-2 pl-3 pr-2 text-xs font-medium text-text-secondary-dark">{formatDate(log.sentAt)}</td>
                    <td className="px-3 py-2 text-sm text-text-primary-dark max-w-[520px]">
                      <div className="font-medium truncate" title={log.messageName}>{log.messageName}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-sm text-text-secondary-dark">
                      <div className="truncate" title={log.targetTeam}>{log.targetTeam}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-sm">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${log.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                        {log.success ? 'Delivered' : 'Failed'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <EmptyState type="logs" />
      )}
    
      <ConfirmComponent />
    </section>
  );
};
