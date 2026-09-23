import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { AddMemberFormProps, NewMember } from './types';

export const AddMemberForm: React.FC<AddMemberFormProps> = ({
  isVisible,
  onToggle,
  onAdd,
  onCancel,
  isOrchestratorTeam,
}) => {
  const [newMember, setNewMember] = useState<NewMember>({ name: '', role: '' });
  const [avatar, setAvatar] = useState<string>('');

  const handleAdd = () => {
    if (!newMember.name.trim() || !newMember.role.trim()) {
      alert('Please fill in both name and role');
      return;
    }
    const payload: any = { ...newMember };
    if (avatar.trim()) payload.avatar = avatar.trim();
    onAdd(payload);
    setNewMember({ name: '', role: '' });
    setAvatar('');
  };

  const handleCancel = () => {
    setNewMember({ name: '', role: '' });
    setAvatar('');
    onCancel();
  };

  return (
    <div className="members-header">
      <h3>Team Members</h3>
      {!isOrchestratorTeam && (
        <Button variant="primary" onClick={onToggle} icon={Plus} aria-label="Toggle add member" />
      )}

      {isVisible && (
        <div className="add-member-form">
          <div className="form-row">
            <input
              type="text"
              placeholder="Member name"
              value={newMember.name}
              onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
              className="form-input"
            />
            <input
              type="text"
              placeholder="Role (e.g., Developer, PM, QA)"
              value={newMember.role}
              onChange={(e) => setNewMember({ ...newMember, role: e.target.value })}
              className="form-input"
            />
            <input
              type="text"
              placeholder="Avatar URL or emoji (optional)"
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              className="form-input"
            />
            <Button 
              variant="success"
              onClick={handleAdd}
            >
              Add
            </Button>
            <Button 
              variant="secondary"
              onClick={handleCancel}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
