import React from 'react';
import { Check, Plus } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { FormLabel, FormInput, FormTextarea, FormSelect } from '@crewly/ui/Form';
import { Popup } from '@crewly/ui/Popup';
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

  const footer = (
    <>
      <Button type="button" variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" icon={Plus} onClick={handleSubmit}>
        {editingMessage ? 'Update Schedule' : 'Create Schedule'}
      </Button>
    </>
  );

  return (
    <Popup
      isOpen={isOpen}
      onClose={onClose}
      title={editingMessage ? 'Edit Scheduled Message' : 'Create New Scheduled Message'}
      subtitle="Configure and schedule a new automated message."
      size="xl"
      className="max-w-2xl"
      footer={footer}
    >
      <form onSubmit={handleSubmit} className="space-y-6 max-h-[60vh] overflow-y-auto pr-2">
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
              <label className="block p-4 rounded-2xl border border-border-dark bg-background-dark cursor-pointer peer-checked:border-primary peer-checked:ring-1 peer-checked:ring-primary" htmlFor="modal-one-time">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">One-time</span>
                  {!formData.isRecurring && (
                    <Check className="w-5 h-5 text-primary" />
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
              <label className="block p-4 rounded-2xl border border-border-dark bg-background-dark cursor-pointer peer-checked:border-primary peer-checked:ring-1 peer-checked:ring-primary" htmlFor="modal-recurring">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Recurring</span>
                  {formData.isRecurring && (
                    <Check className="w-5 h-5 text-primary" />
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
    </Popup>
  );
};
