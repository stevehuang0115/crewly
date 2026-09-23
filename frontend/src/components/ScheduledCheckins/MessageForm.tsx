import React from 'react';
import { FormLabel, FormInput, FormTextarea, FormSelect } from '@crewly/ui';
import { ScheduledMessage, ScheduledMessageFormData, TeamOption } from './types';

interface MessageFormProps {
  isOpen: boolean;
  editingMessage: ScheduledMessage | null;
  formData: ScheduledMessageFormData;
  setFormData: React.Dispatch<React.SetStateAction<ScheduledMessageFormData>>;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  /** Dynamic team options loaded from the API */
  teamOptions: TeamOption[];
}

export const MessageForm: React.FC<MessageFormProps> = ({
  isOpen,
  editingMessage,
  formData,
  setFormData,
  onClose,
  onSubmit,
  teamOptions
}) => {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(e);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-dark border border-border-dark rounded-xl shadow-lg w-full max-w-2xl m-4" onClick={(e) => e.stopPropagation()}>
        <div className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-xl font-semibold text-text-primary-dark">
                {editingMessage ? 'Edit Scheduled Message' : 'Create New Scheduled Message'}
              </h3>
              <p className="text-sm text-text-secondary-dark mt-1">Configure and schedule a new automated message.</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 -mt-1 -mr-1 rounded-lg hover:bg-background-dark flex items-center justify-center text-text-secondary-dark hover:text-text-primary-dark"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-6 mt-6 max-h-[60vh] overflow-y-auto pr-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <FormLabel htmlFor="message-name">Name</FormLabel>
                <FormInput
                  id="message-name"
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  placeholder="e.g., 'Daily Standup Reminder'"
                  required
                />
              </div>
              <div>
                <FormLabel htmlFor="target-member">Target Team Member</FormLabel>
                <FormSelect
                  id="target-member"
                  value={formData.targetTeam}
                  onChange={(e) => setFormData({...formData, targetTeam: e.target.value})}
                  required
                >
                  <option value="">Select a target</option>
                  {teamOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </FormSelect>
              </div>
            </div>
            <div>
              <FormLabel htmlFor="message-content">Message</FormLabel>
              <FormTextarea
                id="message-content"
                value={formData.message}
                onChange={(e) => setFormData({...formData, message: e.target.value})}
                placeholder="Enter your message content here..."
                rows={4}
                required
              />
            </div>
            <div>
              <FormLabel>Schedule</FormLabel>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="relative">
                  <input
                    className="peer sr-only"
                    id="modal-one-time"
                    name="modal-schedule-type"
                    type="radio"
                    value="one-time"
                    checked={!formData.isRecurring}
                    onChange={() => setFormData({ ...formData, isRecurring: false })}
                  />
                  <label className="block p-4 rounded-lg border border-border-dark bg-background-dark cursor-pointer peer-checked:border-primary peer-checked:ring-1 peer-checked:ring-primary" htmlFor="modal-one-time">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">One-time</span>
                      {!formData.isRecurring && (
                        <svg className="w-5 h-5 text-primary" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                      )}
                    </div>
                    <p className="text-sm text-text-secondary-dark mt-1">Send a single message after a delay.</p>
                  </label>
                </div>
                <div className="relative">
                  <input
                    className="peer sr-only"
                    id="modal-recurring"
                    name="modal-schedule-type"
                    type="radio"
                    value="recurring"
                    checked={formData.isRecurring}
                    onChange={() => setFormData({ ...formData, isRecurring: true })}
                  />
                  <label className="block p-4 rounded-lg border border-border-dark bg-background-dark cursor-pointer peer-checked:border-primary peer-checked:ring-1 peer-checked:ring-primary" htmlFor="modal-recurring">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">Recurring</span>
                      {formData.isRecurring && (
                        <svg className="w-5 h-5 text-primary" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                      )}
                    </div>
                    <p className="text-sm text-text-secondary-dark mt-1">Send a message on a recurring basis.</p>
                  </label>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <FormLabel htmlFor="delay-value">
                  {formData.isRecurring ? 'Send Every' : 'Send After'}
                </FormLabel>
                <div className="flex gap-4">
                  <div className="flex-grow">
                    <FormInput
                      id="delay-value"
                      type="number"
                      min="1"
                      value={formData.delayAmount}
                      onChange={(e) => setFormData({ ...formData, delayAmount: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex-shrink-0">
                    <FormSelect
                      value={formData.delayUnit}
                      onChange={(e) => setFormData({ ...formData, delayUnit: e.target.value as 'seconds' | 'minutes' | 'hours' })}
                    >
                      <option value="seconds">seconds</option>
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                    </FormSelect>
                  </div>
                </div>
              </div>
            </div>
          </form>
        </div>
        <div className="bg-background-dark px-6 py-4 rounded-b-xl border-t border-border-dark flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="bg-surface-dark border border-border-dark hover:bg-border-dark font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed h-10 px-4 rounded-lg text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            className="bg-primary text-white hover:bg-primary/90 font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed h-10 px-4 rounded-lg text-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            {editingMessage ? 'Update Schedule' : 'Create Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
};
