/**
 * Data Sovereignty Report — Storage breakdown table
 *
 * Shows where all data is stored and confirms no external transmission.
 * Per spec section 3.5.
 *
 * @module components/Security/DataSovereigntyReport
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Database, CheckCircle, XCircle } from 'lucide-react';
import type { StorageEntry, DataSovereigntySummary } from '../../hooks/useDataSovereignty';
import { formatBytes } from '../../hooks/useDataSovereignty';
import { Card } from '../UI/Card';
import { Badge } from '../UI/Badge';

/** Props for DataSovereigntyReport */
export interface DataSovereigntyReportProps {
  /** Storage entries to display */
  entries: StorageEntry[];
  /** Summary stats */
  summary: DataSovereigntySummary;
  /** Whether data is still loading */
  loading: boolean;
}

/**
 * Renders the data sovereignty report showing storage locations,
 * sizes, and external connection status.
 *
 * @param props - DataSovereigntyReportProps
 * @returns Data sovereignty report element
 */
export const DataSovereigntyReport: React.FC<DataSovereigntyReportProps> = ({
  entries,
  summary,
  loading,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const toggleExpand = () => setIsExpanded((prev) => !prev);

  return (
    <Card padding="none" aria-labelledby="sovereignty-heading">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <button
          type="button"
          onClick={toggleExpand}
          className="flex items-center gap-2 text-left flex-1"
          aria-expanded={isExpanded}
          aria-controls="sovereignty-content"
        >
          <h2 id="sovereignty-heading" className="text-lg font-semibold text-text-primary-dark flex items-center gap-2">
            <Database size={20} aria-hidden="true" className="text-purple-400" />
            Data Sovereignty Report
          </h2>
          {isExpanded ? (
            <ChevronUp size={20} className="text-text-secondary-dark" aria-hidden="true" />
          ) : (
            <ChevronDown size={20} className="text-text-secondary-dark" aria-hidden="true" />
          )}
        </button>

        {/* Status Badge */}
        <Badge
          variant={summary.status === 'secure' ? 'success' : 'warning'}
          size="sm"
          data-testid="sovereignty-status"
        >
          {summary.status === 'secure' ? 'SECURE' : 'WARNING'}
        </Badge>
      </div>

      {/* Content */}
      {isExpanded && (
        <div id="sovereignty-content" className="px-6 pb-6">
          {loading ? (
            <div className="text-text-secondary-dark text-sm py-4" role="status">Loading storage data...</div>
          ) : (
            <>
              {/* Storage Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm" role="table">
                  <thead>
                    <tr className="border-b border-border-dark">
                      <th scope="col" className="text-left py-2 pr-4 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
                        Storage Location
                      </th>
                      <th scope="col" className="text-left py-2 pr-4 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
                        Type
                      </th>
                      <th scope="col" className="text-right py-2 pr-4 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
                        Size
                      </th>
                      <th scope="col" className="text-center py-2 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
                        External?
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr
                        key={entry.path}
                        className="border-b border-border-dark/50"
                        data-testid={`storage-row-${entry.type.toLowerCase().replace(/\s+/g, '-')}`}
                      >
                        <td className="py-2.5 pr-4 font-mono text-xs text-text-secondary-dark">
                          {entry.path}
                        </td>
                        <td className="py-2.5 pr-4 text-text-primary-dark">
                          {entry.type}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono text-xs text-text-secondary-dark">
                          {formatBytes(entry.sizeBytes)}
                        </td>
                        <td className="py-2.5 text-center">
                          {entry.isExternal ? (
                            <Badge variant="error" size="sm" className="gap-1" aria-label="External: Yes">
                              <span>Yes</span>
                              <XCircle size={12} className="inline" />
                            </Badge>
                          ) : (
                            <Badge variant="success" size="sm" className="gap-1" aria-label="External: No">
                              <span>No</span>
                              <CheckCircle size={12} className="inline" />
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Summary Footer */}
              <div className="mt-4 pt-3 border-t border-border-dark space-y-1 text-sm text-text-secondary-dark">
                <div>
                  Total local storage:{' '}
                  <span className="text-text-primary-dark font-medium">
                    {formatBytes(summary.totalLocalBytes)}
                  </span>
                </div>
                <div>
                  External connections:{' '}
                  <span className="text-text-primary-dark font-medium">
                    {summary.externalConnections}
                  </span>
                </div>
                <div>
                  Cloud sync:{' '}
                  <span className="text-text-primary-dark font-medium capitalize">
                    {summary.cloudSync}
                  </span>
                </div>
                <div className="text-xs text-zinc-500">
                  Last scan: {new Date(summary.lastScan).toLocaleString()}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
};

DataSovereigntyReport.displayName = 'DataSovereigntyReport';
