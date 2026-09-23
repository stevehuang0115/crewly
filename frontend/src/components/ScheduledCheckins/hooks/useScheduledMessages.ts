import { useState, useEffect } from 'react';
import { useAlert, useConfirm } from '@crewly/ui/Dialog';
import { ScheduledMessage, ScheduledMessageFormData, MessageDeliveryLog, TeamOption, ScheduledCheck, DEFAULT_FORM_DATA } from '../types';

export const useScheduledMessages = () => {
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [scheduledChecks, setScheduledChecks] = useState<ScheduledCheck[]>([]);
  const [deliveryLogs, setDeliveryLogs] = useState<MessageDeliveryLog[]>([]);
  const [teamOptions, setTeamOptions] = useState<TeamOption[]>([{ value: 'orchestrator', label: 'Orchestrator' }]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingMessage, setEditingMessage] = useState<ScheduledMessage | null>(null);
  const [formData, setFormData] = useState<ScheduledMessageFormData>(DEFAULT_FORM_DATA);
  const { showError, showSuccess, AlertComponent } = useAlert();
  const { showConfirm, ConfirmComponent } = useConfirm();

  useEffect(() => {
    loadScheduledMessages();
    loadScheduledChecks();
    loadDeliveryLogs();
    loadTeamOptions();
  }, []);

  const loadScheduledMessages = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/scheduled-messages');
      if (response.ok) {
        const result = await response.json();
        setScheduledMessages(result.data || []);
      }
    } catch (error) {
      console.error('Error loading scheduled messages:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Loads scheduled checks from the SchedulerService (/api/schedule).
   * These are orchestrator-created check-ins (recurring or one-time).
   */
  const loadScheduledChecks = async () => {
    try {
      const response = await fetch('/api/schedule');
      if (response.ok) {
        const result = await response.json();
        setScheduledChecks(result.data || []);
      }
    } catch (error) {
      console.error('Error loading scheduled checks:', error);
    }
  };

  /**
   * Cancel a scheduled check by ID via DELETE /api/schedule/:id,
   * then refresh the list.
   */
  const handleCancelCheck = async (id: string, message: string) => {
    const doCancel = async () => {
      try {
        const response = await fetch(`/api/schedule/${id}`, { method: 'DELETE' });
        if (response.ok) {
          showSuccess('Scheduled check cancelled');
          await loadScheduledChecks();
        } else {
          const error = await response.text();
          showError('Failed to cancel scheduled check: ' + error);
        }
      } catch (error) {
        console.error('Error cancelling scheduled check:', error);
        showError('Failed to cancel scheduled check: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    };
    const preview = message.length > 60 ? message.slice(0, 60) + '...' : message;
    showConfirm(
      `Cancel this scheduled check?\n\n"${preview}"`,
      doCancel,
      { type: 'warning', title: 'Cancel Scheduled Check', confirmText: 'Cancel Check' }
    );
  };

  const loadDeliveryLogs = async () => {
    try {
      const response = await fetch('/api/message-delivery-logs');
      if (response.ok) {
        const result = await response.json();
        setDeliveryLogs(result.data || []);
      }
    } catch (error) {
      console.error('Error loading delivery logs:', error);
    }
  };

  /**
   * Load team options from the API - combines orchestrator with actual team members
   */
  const loadTeamOptions = async () => {
    try {
      const response = await fetch('/api/teams');
      if (response.ok) {
        const result = await response.json();
        const teams = result.data || result || [];

        // Build options from actual team members
        const options: TeamOption[] = [{ value: 'orchestrator', label: 'Orchestrator' }];

        for (const team of teams) {
          for (const member of team.members || []) {
            options.push({
              value: member.sessionName || `${team.id}-${member.id}`,
              label: `${team.name} ${member.name}`
            });
          }
        }

        setTeamOptions(options);
      }
    } catch (error) {
      console.error('Error loading team options:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const url = editingMessage 
        ? `/api/scheduled-messages/${editingMessage.id}`
        : '/api/scheduled-messages';
      
      const method = editingMessage ? 'PUT' : 'POST';
      
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      if (response.ok) {
        await loadScheduledMessages();
        await loadDeliveryLogs();
        handleCloseModal();
      } else {
        const error = await response.text();
        showError('Failed to save scheduled message: ' + error);
      }
    } catch (error) {
      console.error('Error saving scheduled message:', error);
      showError('Failed to save scheduled message: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    
    const doDelete = async () => {
      try {

      const response = await fetch(`/api/scheduled-messages/${id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        await loadScheduledMessages();
      } else {
        const error = await response.text();
        showError('Failed to delete scheduled message: ' + error);
      }
    
      } catch (error) {
        console.error('Error deleting scheduled message:', error);
        showError('Failed to delete scheduled message: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    };
    showConfirm(
      `Are you sure you want to delete "${name}"?`,
      doDelete,
      { type: 'error', title: 'Delete Scheduled Message', confirmText: 'Delete' }
    );

  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      const response = await fetch(`/api/scheduled-messages/${id}/toggle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isActive: !isActive }),
      });

      if (response.ok) {
        await loadScheduledMessages();
      } else {
        const error = await response.text();
        showError('Failed to toggle scheduled message: ' + error);
      }
    } catch (error) {
      console.error('Error toggling scheduled message:', error);
      showError('Failed to toggle scheduled message: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  
  const handleRunNow = async (id: string, name: string) => {
    const doRun = async () => {
      try {

      const response = await fetch(`/api/scheduled-messages/${id}/run`, {
        method: 'POST',
      });

      if (response.ok) {
        showSuccess('Scheduled message executed successfully!');
        await loadScheduledMessages();
        await loadDeliveryLogs();
      } else {
        const error = await response.text();
        alert('Failed to run scheduled message: ' + error);
      }
    
      } catch (error) {
        console.error('Error running scheduled message:', error);
        showError('Failed to run scheduled message: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    };
    showConfirm(
      `Run "${name}" now?`,
      doRun,
      { title: 'Run Scheduled Message', confirmText: 'Run Now', type: 'warning' }
    );

  };

  const handleEdit = (message: ScheduledMessage) => {
    setEditingMessage(message);
    setFormData({
      name: message.name,
      targetTeam: message.targetTeam,
      targetProject: message.targetProject || '',
      message: message.message,
      delayAmount: message.delayAmount.toString(),
      delayUnit: message.delayUnit,
      isRecurring: message.isRecurring
    });
    setShowCreateModal(true);
  };

  const handleCreate = () => {
    setEditingMessage(null);
    setFormData(DEFAULT_FORM_DATA);
    setShowCreateModal(true);
  };

  const handleCloseModal = () => {
    setShowCreateModal(false);
    setEditingMessage(null);
    setFormData(DEFAULT_FORM_DATA);
  };

  const clearDeliveryLogs = async () => {
    try {
      const response = await fetch('/api/message-delivery-logs', { method: 'DELETE' });
      if (response.ok) {
        setDeliveryLogs([]);
      }
    } catch (error) {
      console.error('Error clearing logs:', error);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  return {
    // State
    scheduledMessages,
    scheduledChecks,
    deliveryLogs,
    teamOptions,
    loading,
    showCreateModal,
    editingMessage,
    formData,
    setFormData,
    // Actions
    handleSubmit,
    handleDelete,
    handleToggleActive,
    handleRunNow,
    handleEdit,
    handleCreate,
    handleCloseModal,
    handleCancelCheck,
    clearDeliveryLogs,
    // Utils
    formatDate,
    // Dialog components for mounting at page-level
    AlertComponent,
    ConfirmComponent
  };
};