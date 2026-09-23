/**
 * Automations Page (Schedules & Cron)
 *
 * Two-tab layout per Phase 2 UX spec:
 * - Tab 1: Scheduled Messages (with active/completed filter, system checks, delivery logs)
 * - Tab 2: Cron Jobs (CronJobPanel)
 *
 * @module pages/ScheduledCheckins
 */

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Button } from '@crewly/ui/Button';
import { Tabs, TabList, TabTrigger, TabContent } from '@crewly/ui/Tabs';
import { CronJobPanel } from '@/components/Settings/CronJobPanel';
import {
  ScheduledMessageCard,
  ScheduledCheckCard,
  TabNavigation,
  EmptyState,
  MessageForm,
  DeliveryLogsTable,
  useScheduledMessages,
  ActiveTab,
} from '../components/ScheduledCheckins';

/** Top-level page tabs */
type PageTab = 'messages' | 'cron';

/**
 * Inner component for the Messages tab — isolates the useScheduledMessages hook
 * so it only runs when the messages tab is active. This prevents hook failures
 * from crashing the entire page (including the Cron tab).
 */
const ScheduledMessagesTab: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('active');
  const {
    scheduledMessages,
    scheduledChecks,
    deliveryLogs,
    teamOptions,
    loading,
    showCreateModal,
    editingMessage,
    formData,
    setFormData,
    handleSubmit,
    handleDelete,
    handleToggleActive,
    handleRunNow,
    handleEdit,
    handleCreate,
    handleCloseModal,
    handleCancelCheck,
    clearDeliveryLogs,
    formatDate,
    AlertComponent,
    ConfirmComponent,
  } = useScheduledMessages();

  const activeMessages = scheduledMessages.filter((msg) => msg.isActive);
  const completedMessages = scheduledMessages.filter((msg) => !msg.isActive);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <LoadingSpinner text="Loading scheduled messages..." />
      </div>
    );
  }

  return (
    <>
      <TabNavigation
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeMessages={activeMessages}
        completedMessages={completedMessages}
      />
      <div>
        {activeTab === 'active' ? (
          activeMessages.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {activeMessages.map((message) => (
                <ScheduledMessageCard
                  key={message.id}
                  message={message}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onToggleActive={handleToggleActive}
                  onRunNow={handleRunNow}
                  formatDate={formatDate}
                />
              ))}
            </div>
          ) : (
            <EmptyState type="active" onCreateMessage={handleCreate} />
          )
        ) : (
          completedMessages.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {completedMessages.map((message) => (
                <ScheduledMessageCard
                  key={message.id}
                  message={message}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onToggleActive={handleToggleActive}
                  onRunNow={handleRunNow}
                  formatDate={formatDate}
                />
              ))}
            </div>
          ) : (
            <EmptyState type="completed" onCreateMessage={handleCreate} />
          )
        )}
      </div>

      {/* Scheduled Checks */}
      {scheduledChecks.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-semibold mb-4">System Checks</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {scheduledChecks.map((check) => (
              <ScheduledCheckCard key={check.id} check={check} onCancel={handleCancelCheck} formatDate={formatDate} />
            ))}
          </div>
        </div>
      )}

      {/* Delivery Logs */}
      {deliveryLogs.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Delivery Logs</h3>
            <Button variant="ghost" size="sm" onClick={clearDeliveryLogs}>
              Clear Logs
            </Button>
          </div>
          <DeliveryLogsTable deliveryLogs={deliveryLogs} formatDate={formatDate} onClearLogs={clearDeliveryLogs} />
        </div>
      )}

      <MessageForm
        isOpen={showCreateModal}
        editingMessage={editingMessage}
        formData={formData}
        setFormData={setFormData}
        teamOptions={teamOptions}
        onSubmit={handleSubmit}
        onClose={handleCloseModal}
      />

      <AlertComponent />
      <ConfirmComponent />
    </>
  );
};

export const ScheduledCheckins: React.FC = () => {
  const [pageTab, setPageTab] = useState<PageTab>('cron');

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Schedules</h2>
          <p className="text-sm text-text-secondary-dark mt-1">
            Manage scheduled messages, system checks, and automated jobs
          </p>
        </div>
      </div>

      {/* Top-level page tabs: Scheduled Messages | Cron Jobs */}
      <Tabs value={pageTab} onValueChange={(v) => setPageTab(v as PageTab)}>
        <TabList aria-label="Page sections">
          <TabTrigger value="messages">Scheduled Messages</TabTrigger>
          <TabTrigger value="cron">Cron Jobs</TabTrigger>
        </TabList>

        {/* Tab 1: Scheduled Messages (isolated component to prevent hook crash) */}
        <TabContent value="messages">
          <ScheduledMessagesTab />
        </TabContent>

        {/* Tab 2: Cron Jobs */}
        <TabContent value="cron" className="mb-10">
          <CronJobPanel />
        </TabContent>
      </Tabs>
    </div>
  );
};
