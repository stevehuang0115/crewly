/**
 * Tabs Component Tests
 *
 * @module components/UI/Tabs.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Tabs, TabList, TabTrigger, TabContent } from './Tabs';

describe('Tabs', () => {
  const renderTabs = (props = {}) => {
    return render(
      <Tabs defaultValue="tab1" {...props}>
        <TabList>
          <TabTrigger value="tab1">Tab 1</TabTrigger>
          <TabTrigger value="tab2">Tab 2</TabTrigger>
          <TabTrigger value="tab3">Tab 3</TabTrigger>
        </TabList>
        <TabContent value="tab1">Content 1</TabContent>
        <TabContent value="tab2">Content 2</TabContent>
        <TabContent value="tab3">Content 3</TabContent>
      </Tabs>
    );
  };

  describe('Rendering', () => {
    it('should render tab triggers', () => {
      renderTabs();
      expect(screen.getByText('Tab 1')).toBeInTheDocument();
      expect(screen.getByText('Tab 2')).toBeInTheDocument();
      expect(screen.getByText('Tab 3')).toBeInTheDocument();
    });

    it('should render default tab content', () => {
      renderTabs();
      expect(screen.getByText('Content 1')).toBeInTheDocument();
      expect(screen.queryByText('Content 2')).not.toBeInTheDocument();
      expect(screen.queryByText('Content 3')).not.toBeInTheDocument();
    });
  });

  describe('Tab switching', () => {
    it('should switch content when tab is clicked', () => {
      renderTabs();

      fireEvent.click(screen.getByText('Tab 2'));

      expect(screen.queryByText('Content 1')).not.toBeInTheDocument();
      expect(screen.getByText('Content 2')).toBeInTheDocument();
    });

    it('should call onValueChange when tab changes', () => {
      const handleChange = vi.fn();
      renderTabs({ onValueChange: handleChange });

      fireEvent.click(screen.getByText('Tab 2'));

      expect(handleChange).toHaveBeenCalledWith('tab2');
    });

    it('should update active tab styling', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      const tab2 = screen.getByText('Tab 2');

      expect(tab1).toHaveClass('text-primary');
      expect(tab2).toHaveClass('text-text-secondary-dark');

      fireEvent.click(tab2);

      expect(tab1).toHaveClass('text-text-secondary-dark');
      expect(tab2).toHaveClass('text-primary');
    });
  });

  describe('Accessibility', () => {
    it('should have proper tab roles', () => {
      renderTabs();
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(3);
    });

    it('should have tablist role on container', () => {
      renderTabs();
      expect(screen.getByRole('tablist')).toBeInTheDocument();
    });

    it('should have tabpanel role on content', () => {
      renderTabs();
      expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    });

    it('should set aria-selected on active tab', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      const tab2 = screen.getByText('Tab 2');

      expect(tab1).toHaveAttribute('aria-selected', 'true');
      expect(tab2).toHaveAttribute('aria-selected', 'false');
    });

    it('should link tab to panel with aria-controls', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      expect(tab1).toHaveAttribute('aria-controls', 'tabpanel-tab1');
    });

    it('should link panel to tab with aria-labelledby', () => {
      renderTabs();
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-tab1');
    });

    it('should navigate tabs with arrow right key', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      const tab2 = screen.getByText('Tab 2');

      tab1.focus();
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });

      expect(document.activeElement).toBe(tab2);
    });

    it('should navigate tabs with arrow left key', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      const tab2 = screen.getByText('Tab 2');

      tab2.focus();
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });

      expect(document.activeElement).toBe(tab1);
    });

    it('should wrap around with arrow keys', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      const tab3 = screen.getByText('Tab 3');

      tab3.focus();
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });

      expect(document.activeElement).toBe(tab1);
    });

    it('should navigate to first tab with Home key', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      const tab3 = screen.getByText('Tab 3');

      tab3.focus();
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });

      expect(document.activeElement).toBe(tab1);
    });

    it('should navigate to last tab with End key', () => {
      renderTabs();
      const tab1 = screen.getByText('Tab 1');
      const tab3 = screen.getByText('Tab 3');

      tab1.focus();
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });

      expect(document.activeElement).toBe(tab3);
    });
  });

  describe('Disabled tabs', () => {
    it('should not switch to disabled tab', () => {
      render(
        <Tabs defaultValue="tab1">
          <TabList>
            <TabTrigger value="tab1">Tab 1</TabTrigger>
            <TabTrigger value="tab2" disabled>Tab 2</TabTrigger>
          </TabList>
          <TabContent value="tab1">Content 1</TabContent>
          <TabContent value="tab2">Content 2</TabContent>
        </Tabs>
      );

      fireEvent.click(screen.getByText('Tab 2'));

      expect(screen.getByText('Content 1')).toBeInTheDocument();
      expect(screen.queryByText('Content 2')).not.toBeInTheDocument();
    });

    it('should apply disabled styling', () => {
      render(
        <Tabs defaultValue="tab1">
          <TabList>
            <TabTrigger value="tab1">Tab 1</TabTrigger>
            <TabTrigger value="tab2" disabled>Tab 2</TabTrigger>
          </TabList>
          <TabContent value="tab1">Content 1</TabContent>
          <TabContent value="tab2">Content 2</TabContent>
        </Tabs>
      );

      const disabledTab = screen.getByText('Tab 2');
      expect(disabledTab).toHaveClass('opacity-50');
      expect(disabledTab).toBeDisabled();
    });
  });

  describe('Icon support', () => {
    it('should render icon in tab trigger', () => {
      render(
        <Tabs defaultValue="tab1">
          <TabList>
            <TabTrigger value="tab1" icon={<span data-testid="icon">*</span>}>
              Tab 1
            </TabTrigger>
          </TabList>
          <TabContent value="tab1">Content 1</TabContent>
        </Tabs>
      );

      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });
  });

  describe('Custom className', () => {
    it('should apply custom className to Tabs', () => {
      const { container } = render(
        <Tabs defaultValue="tab1" className="custom-tabs">
          <TabList>
            <TabTrigger value="tab1">Tab 1</TabTrigger>
          </TabList>
          <TabContent value="tab1">Content</TabContent>
        </Tabs>
      );

      expect(container.firstChild).toHaveClass('custom-tabs');
    });

    it('should apply custom className to TabList', () => {
      render(
        <Tabs defaultValue="tab1">
          <TabList className="custom-tablist">
            <TabTrigger value="tab1">Tab 1</TabTrigger>
          </TabList>
          <TabContent value="tab1">Content</TabContent>
        </Tabs>
      );

      expect(screen.getByRole('tablist')).toHaveClass('custom-tablist');
    });

    it('should apply custom className to TabContent', () => {
      render(
        <Tabs defaultValue="tab1">
          <TabList>
            <TabTrigger value="tab1">Tab 1</TabTrigger>
          </TabList>
          <TabContent value="tab1" className="custom-content">
            Content
          </TabContent>
        </Tabs>
      );

      expect(screen.getByRole('tabpanel')).toHaveClass('custom-content');
    });
  });

  describe('Error handling', () => {
    it('should throw error if TabTrigger used outside Tabs', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TabTrigger value="tab1">Tab 1</TabTrigger>);
      }).toThrow('Tabs compound components must be used within a Tabs component');

      consoleError.mockRestore();
    });

    it('should throw error if TabContent used outside Tabs', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TabContent value="tab1">Content</TabContent>);
      }).toThrow('Tabs compound components must be used within a Tabs component');

      consoleError.mockRestore();
    });
  });
});
