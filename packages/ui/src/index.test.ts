/**
 * UI Component Index Tests
 *
 * Verifies that all UI components are properly exported from the index file.
 *
 * @module components/UI/index.test
 */

import { describe, it, expect } from 'vitest';
import * as UIComponents from './index';

describe('UI Components Index', () => {
  describe('Component exports', () => {
    it('should export Card component', () => {
      expect(UIComponents.Card).toBeDefined();
    });

    it('should export Input component', () => {
      expect(UIComponents.Input).toBeDefined();
    });

    it('should export Badge component', () => {
      expect(UIComponents.Badge).toBeDefined();
    });

    it('should export Tabs components', () => {
      expect(UIComponents.Tabs).toBeDefined();
      expect(UIComponents.TabList).toBeDefined();
      expect(UIComponents.TabTrigger).toBeDefined();
      expect(UIComponents.TabContent).toBeDefined();
    });

    it('should export Alert component', () => {
      expect(UIComponents.Alert).toBeDefined();
    });

    it('should export Button components', () => {
      expect(UIComponents.Button).toBeDefined();
      expect(UIComponents.IconButton).toBeDefined();
    });

    it('should export StatusBadge component', () => {
      expect(UIComponents.StatusBadge).toBeDefined();
    });

    it('should export Modal components', () => {
      expect(UIComponents.Modal).toBeDefined();
      expect(UIComponents.ModalFooter).toBeDefined();
      expect(UIComponents.ModalBody).toBeDefined();
    });

    it('should export Dialog components', () => {
      expect(UIComponents.AlertDialog).toBeDefined();
      expect(UIComponents.ConfirmDialog).toBeDefined();
      expect(UIComponents.useAlert).toBeDefined();
      expect(UIComponents.useConfirm).toBeDefined();
    });

    it('should export Form components', () => {
      expect(UIComponents.Form).toBeDefined();
      expect(UIComponents.FormGroup).toBeDefined();
      expect(UIComponents.FormRow).toBeDefined();
      expect(UIComponents.FormLabel).toBeDefined();
      expect(UIComponents.FormHelp).toBeDefined();
      expect(UIComponents.FormError).toBeDefined();
      expect(UIComponents.FormInput).toBeDefined();
      expect(UIComponents.FormTextarea).toBeDefined();
      expect(UIComponents.FormSelect).toBeDefined();
      expect(UIComponents.FormSection).toBeDefined();
    });

    it('should export Dropdown component', () => {
      expect(UIComponents.Dropdown).toBeDefined();
    });

    it('should export Toggle component', () => {
      expect(UIComponents.Toggle).toBeDefined();
    });

    it('should export Popup components', () => {
      expect(UIComponents.Popup).toBeDefined();
      expect(UIComponents.FormPopup).toBeDefined();
      expect(UIComponents.ConfirmPopup).toBeDefined();
    });

    it('should export Avatar components', () => {
      expect(UIComponents.Avatar).toBeDefined();
      expect(UIComponents.AvatarGroup).toBeDefined();
    });
  });
});
