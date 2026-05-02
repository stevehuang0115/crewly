/**
 * Tests for BusinessProfileBlock.
 *
 * @module components/Onboarding/v2-5/blocks/BusinessProfileBlock.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BusinessProfileBlock } from './BusinessProfileBlock';

describe('BusinessProfileBlock', () => {
  it('renders empty state when profile is undefined', () => {
    render(<BusinessProfileBlock />);
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'empty'
    );
    expect(
      screen.getByTestId('blueprint-block-business-profile-empty')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('business-profile-filled')
    ).not.toBeInTheDocument();
  });

  it('renders empty state when profile has no fields', () => {
    render(<BusinessProfileBlock profile={{}} />);
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders only the populated fields when partially filled', () => {
    render(
      <BusinessProfileBlock
        profile={{ industry: 'SaaS', customer: 'SMB' }}
      />
    );
    expect(screen.getByTestId('blueprint-block-business-profile')).toHaveAttribute(
      'data-state',
      'populated'
    );
    expect(screen.getByTestId('business-profile-industry')).toHaveTextContent('SaaS');
    expect(screen.getByTestId('business-profile-customer')).toHaveTextContent('SMB');
    expect(screen.queryByTestId('business-profile-workflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('business-profile-pain')).not.toBeInTheDocument();
  });

  it('renders all six fields when fully populated', () => {
    render(
      <BusinessProfileBlock
        profile={{
          industry: 'SaaS',
          customer: 'SMB',
          workflow: 'newsletter',
          pain: 'no time',
          priorTools: 'Mailchimp',
          guardrails: 'no political topics',
        }}
      />
    );
    expect(screen.getByTestId('business-profile-industry')).toHaveTextContent('SaaS');
    expect(screen.getByTestId('business-profile-customer')).toHaveTextContent('SMB');
    expect(screen.getByTestId('business-profile-workflow')).toHaveTextContent('newsletter');
    expect(screen.getByTestId('business-profile-pain')).toHaveTextContent('no time');
    expect(screen.getByTestId('business-profile-priorTools')).toHaveTextContent('Mailchimp');
    expect(screen.getByTestId('business-profile-guardrails')).toHaveTextContent('no political topics');
  });
});
