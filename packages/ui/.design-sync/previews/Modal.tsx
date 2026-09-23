import React from 'react';
import { Modal, ModalFooter, Button, Input } from '@crewly/ui';

export const RenameTeam = () => (
  <div className="h-[460px]">
  <Modal isOpen onClose={() => {}} title="Rename team" size="md">
    <Input label="Team name" defaultValue="Growth" />
    <ModalFooter>
      <Button variant="ghost">Cancel</Button>
      <Button>Save</Button>
    </ModalFooter>
  </Modal>
  </div>
);
