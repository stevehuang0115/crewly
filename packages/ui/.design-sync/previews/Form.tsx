import React from 'react';
import { Form, FormSection, FormGroup, FormRow, FormLabel, FormInput, FormSelect, FormTextarea, FormHelp, Button } from '@crewly/ui';

export const NewTeam = () => (
  <div className="w-[560px]">
    <Form onSubmit={(e) => e.preventDefault()}>
      <FormSection title="New team" description="Agents on a team share a Slack channel and a project.">
        <FormRow>
          <FormGroup>
            <FormLabel htmlFor="name" required>Team name</FormLabel>
            <FormInput id="name" defaultValue="Growth" />
          </FormGroup>
          <FormGroup>
            <FormLabel htmlFor="runtime">Runtime</FormLabel>
            <FormSelect id="runtime" defaultValue="claude">
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </FormSelect>
          </FormGroup>
        </FormRow>
        <FormGroup>
          <FormLabel htmlFor="goal">Goal</FormLabel>
          <FormTextarea id="goal" rows={3} defaultValue="Publish two blog posts a week and grow signups." />
          <FormHelp>The team lead turns this into tasks.</FormHelp>
        </FormGroup>
      </FormSection>
      <div className="flex justify-end gap-2"><Button variant="ghost">Cancel</Button><Button>Create team</Button></div>
    </Form>
  </div>
);
