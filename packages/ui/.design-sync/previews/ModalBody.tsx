import React from 'react';
import { Modal, ModalBody, ModalFooter, Button } from '@crewly/ui';

export const InsideModal = () => (
  <div className="h-[460px]">
  <Modal isOpen onClose={() => {}} title="Approve publish" closable={false}>
    <ModalBody className="p-0">
      <p className="text-sm text-text-secondary-dark">Leo wants to publish “Five ways agents save you a day” to the blog.</p>
    </ModalBody>
    <ModalFooter align="space-between">
      <Button variant="danger-ghost">Reject</Button>
      <Button variant="success">Approve</Button>
    </ModalFooter>
  </Modal>
  </div>
);
