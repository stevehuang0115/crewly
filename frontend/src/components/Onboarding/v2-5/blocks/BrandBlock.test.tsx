/**
 * Tests for BrandBlock.
 *
 * @module components/Onboarding/v2-5/blocks/BrandBlock.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandBlock } from './BrandBlock';

describe('BrandBlock', () => {
  it('renders empty state when brand is undefined', () => {
    render(<BrandBlock />);
    expect(screen.getByTestId('blueprint-block-brand')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders empty state when all brand fields are empty', () => {
    render(<BrandBlock brand={{ voiceChips: [], tone: '', approvalChannel: '' }} />);
    expect(screen.getByTestId('blueprint-block-brand')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders only voice chips when only voice is populated', () => {
    render(
      <BrandBlock
        brand={{ voiceChips: ['playful', 'crisp'], tone: '', approvalChannel: '' }}
      />
    );
    expect(screen.getByTestId('brand-voice-chips')).toBeInTheDocument();
    expect(screen.getByTestId('brand-voice-chip-0')).toHaveTextContent('playful');
    expect(screen.getByTestId('brand-voice-chip-1')).toHaveTextContent('crisp');
    expect(screen.queryByTestId('brand-tone')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brand-approval-channel')).not.toBeInTheDocument();
  });

  it('renders all brand fields when fully populated', () => {
    render(
      <BrandBlock
        brand={{
          voiceChips: ['playful', 'crisp', 'witty'],
          tone: 'Friendly',
          approvalChannel: 'Slack #ops',
        }}
      />
    );
    expect(screen.getByTestId('brand-voice-chip-0')).toHaveTextContent('playful');
    expect(screen.getByTestId('brand-tone')).toHaveTextContent('Friendly');
    expect(screen.getByTestId('brand-approval-channel')).toHaveTextContent(
      'Slack #ops'
    );
  });

  it('renders only the populated subset (tone-only edge case)', () => {
    render(
      <BrandBlock
        brand={{ voiceChips: [], tone: 'Friendly', approvalChannel: '' }}
      />
    );
    expect(screen.getByTestId('brand-tone')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-voice-chips')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brand-approval-channel')).not.toBeInTheDocument();
  });
});
