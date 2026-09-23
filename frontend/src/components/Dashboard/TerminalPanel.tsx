import React from 'react';
import clsx from 'clsx';
import { Card } from '@crewly/ui/Card';
import { TerminalEmulator } from '../TerminalEmulator';
import { TerminalPanelProps } from './types';

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  selectedMember,
  terminalData,
  onTerminalInput
}) => {
  return (
    <div className="space-y-4">
      <Card className="shadow-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-text-primary-dark">
            Terminal: {selectedMember.name}
          </h3>
          <div className="flex items-center space-x-4 text-sm text-text-secondary-dark">
            <span>
              Role: <span className="font-medium">{selectedMember.role}</span>
            </span>
            <span>
              Agent Status: <span className={clsx(
                'font-medium',
                selectedMember.agentStatus === 'active' ? 'text-green-400' :
                selectedMember.agentStatus === 'activating' ? 'text-orange-400' :
                'text-text-secondary-dark'
              )}>{selectedMember.agentStatus}</span>
            </span>
            <span>
              Working Status: <span className={clsx(
                'font-medium',
                selectedMember.workingStatus === 'in_progress' ? 'text-green-400' :
                'text-text-secondary-dark'
              )}>{selectedMember.workingStatus}</span>
            </span>
          </div>
        </div>
        
        <TerminalEmulator
          sessionName={selectedMember.sessionName}
          terminalData={terminalData}
          onInput={onTerminalInput}
          className="w-full"
        />
      </Card>
    </div>
  );
};