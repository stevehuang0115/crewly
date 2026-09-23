/**
 * Additions made after the Cloud portal migration found gaps: refs on form
 * controls, test-id / rest-prop pass-through, extra statuses and variants,
 * and Modal focusing the first real control instead of its close button.
 */
import React, { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Info } from 'lucide-react';
import { FormInput, FormSelect, FormTextarea } from './Form';
import { StatusDot } from './StatusDot';
import { StatusBadge } from './StatusBadge';
import { Alert } from './Alert';
import { EmptyState } from './EmptyState';
import { FilterPill } from './FilterPill';
import { Button } from './Button';
import { Modal } from './Modal';
import { Drawer } from './Drawer';

describe('@crewly/ui API additions', () => {
  it('forwards refs on FormInput, FormTextarea and FormSelect', () => {
    const input = createRef<HTMLInputElement>();
    const area = createRef<HTMLTextAreaElement>();
    const select = createRef<HTMLSelectElement>();
    render(<><FormInput ref={input} /><FormTextarea ref={area} /><FormSelect ref={select}><option>a</option></FormSelect></>);
    expect(input.current).toBeInstanceOf(HTMLInputElement);
    expect(area.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(select.current).toBeInstanceOf(HTMLSelectElement);
  });

  it('has working/warning dots and custom test ids', () => {
    render(<><StatusDot status="working" data-testid="w" /><StatusDot status="warning" data-testid="o" /></>);
    expect(screen.getByTestId('w')).toHaveClass('bg-blue-400');
    expect(screen.getByTestId('o')).toHaveClass('bg-orange-400');
  });

  it('passes rest props through StatusBadge, Alert and EmptyState', () => {
    render(<>
      <StatusBadge status="pending" data-testid="sb" />
      <Alert data-testid="al" size="sm" icon={Info}>hi</Alert>
      <EmptyState data-testid="es" title="Nothing" />
    </>);
    expect(screen.getByTestId('sb')).toHaveClass('text-text-secondary-dark');
    expect(screen.getByTestId('al')).toHaveClass('px-3');
    expect(screen.getByTestId('es')).toHaveTextContent('Nothing');
  });

  it('renders a display-only FilterPill without onClick', () => {
    render(<FilterPill isActive>Mine</FilterPill>);
    expect(screen.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('has link and xs buttons', () => {
    render(<><Button variant="link">Clear</Button><Button size="xs">Tiny</Button></>);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveClass('text-primary');
    expect(screen.getByRole('button', { name: 'Tiny' })).toHaveClass('h-7');
  });

  it('focuses the first real control in a Modal, labels it by its title, and takes a test id', () => {
    render(
      <Modal isOpen onClose={() => {}} title={<span>Rename</span>} data-testid="m">
        <input aria-label="Name" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    const dialog = screen.getByTestId('m');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('Rename');
  });

  it('prefers an autoFocus element in a Modal', () => {
    render(
      <Modal isOpen onClose={() => {}} title="T">
        <input aria-label="First" />
        <input aria-label="Second" autoFocus />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Second'));
  });

  it('renders a bare Drawer without header or body padding', () => {
    render(<Drawer isOpen bare onClose={() => {}} data-testid="d"><nav>Links</nav></Drawer>);
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.getByTestId('d')).toHaveTextContent('Links');
  });
});

describe('@crewly/ui API additions, round 2', () => {
  it('Popup focuses the first real control too', async () => {
    const { Popup } = await import('./Popup');
    render(<Popup isOpen onClose={() => {}} title="T"><input aria-label="Name" /></Popup>);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('LoadingSpinner takes a test id and FormInput has a small size', async () => {
    const { LoadingSpinner } = await import('./LoadingSpinner');
    render(<><LoadingSpinner data-testid="sp" /><FormInput size="sm" aria-label="filter" /></>);
    expect(screen.getByTestId('sp')).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('filter')).toHaveClass('text-xs');
  });
});

describe('@crewly/ui API additions, round 3', () => {
  it('Button is inline and a link has no box', () => {
    render(<><Button>Go</Button><Button variant="link">Clear</Button></>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('inline-flex');
    expect(screen.getByRole('button', { name: 'Clear' })).not.toHaveClass('h-10');
  });

  it('a caller className wins over Card and Button defaults', async () => {
    const { Card } = await import('./Card');
    render(<><Card data-testid="c" className="border-red-500">x</Card><Button className="h-8">B</Button></>);
    expect(screen.getByTestId('c')).toHaveClass('border-red-500');
    expect(screen.getByTestId('c')).not.toHaveClass('border-border-dark');
    expect(screen.getByRole('button', { name: 'B' })).not.toHaveClass('h-10');
  });

  it('Tabs can be controlled and TabList named', async () => {
    const { Tabs, TabList, TabTrigger, TabContent } = await import('./Tabs');
    const { rerender } = render(
      <Tabs value="b"><TabList aria-label="Sections"><TabTrigger value="a">A</TabTrigger><TabTrigger value="b">B</TabTrigger></TabList><TabContent value="a">AA</TabContent><TabContent value="b">BB</TabContent></Tabs>,
    );
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.getByText('BB')).toBeInTheDocument();
    rerender(
      <Tabs value="a"><TabList><TabTrigger value="a">A</TabTrigger><TabTrigger value="b">B</TabTrigger></TabList><TabContent value="a">AA</TabContent><TabContent value="b">BB</TabContent></Tabs>,
    );
    expect(screen.getByText('AA')).toBeInTheDocument();
  });

  it('SegmentedControl supports icon-only options with test ids', async () => {
    const { SegmentedControl } = await import('./SegmentedControl');
    render(<SegmentedControl value="g" onChange={() => {}} options={[{ value: 'g', label: 'Grid', icon: Info, iconOnly: true, 'data-testid': 'seg-g' }]} />);
    expect(screen.getByTestId('seg-g')).toHaveAttribute('aria-label', 'Grid');
    expect(screen.getByTestId('seg-g')).not.toHaveTextContent('Grid');
  });

  it('Table can drop its border; spinner text can sit inline', async () => {
    const { Table } = await import('./Table');
    const { LoadingSpinner } = await import('./LoadingSpinner');
    const { container } = render(<><Table bordered={false}><tbody /></Table><LoadingSpinner inline text="Loading" data-testid="s" /></>);
    expect(container.querySelector('div')).not.toHaveClass('border');
    expect(screen.getByTestId('s')).toHaveClass('flex-row');
  });
});
