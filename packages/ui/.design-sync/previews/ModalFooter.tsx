import React from 'react';
import { ModalFooter, Button } from '@crewly/ui';

export const Alignments = () => (
  <div className="w-[480px] space-y-2 rounded-2xl border border-border-dark bg-surface-dark pt-6">
    <ModalFooter align="right"><Button variant="ghost">Cancel</Button><Button>Save</Button></ModalFooter>
    <ModalFooter align="space-between"><Button variant="danger-ghost">Delete</Button><Button>Save</Button></ModalFooter>
    <ModalFooter align="center"><Button>Got it</Button></ModalFooter>
  </div>
);
