import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { vi } from 'vitest';
import TaskCreateModal from './TaskCreateModal';

// Mock the UI components
vi.mock('@crewly/ui', () => ({
  FormPopup: ({ isOpen, onClose, title, subtitle, onSubmit, submitText, size, children }: any) => (
    <div data-testid="form-popup" data-size={size}>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <form onSubmit={onSubmit}>
        {children}
        <button type="submit">{submitText}</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </form>
    </div>
  ),
  FormGroup: ({ children }: any) => <div data-testid="form-group">{children}</div>,
  FormLabel: ({ htmlFor, required, children }: any) => (
    <label htmlFor={htmlFor} data-required={required}>{children}</label>
  ),
  FormInput: ({ id, value, onChange, placeholder, required, ...props }: any) => (
    <input
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
      data-testid={id}
      {...props}
    />
  ),
  FormTextarea: ({ id, value, onChange, placeholder, rows, ...props }: any) => (
    <textarea
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
      data-testid={id}
      {...props}
    />
  ),
  FormRow: ({ children }: any) => <div data-testid="form-row">{children}</div>,
  Dropdown: ({ id, value, onChange, options }: any) => (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={id}
    >
      {options.map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}));

describe('TaskCreateModal', () => {
  const mockOnClose = vi.fn();
  const mockOnSubmit = vi.fn();
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders modal with correct title and subtitle', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    expect(screen.getByText('Create New Task')).toBeInTheDocument();
    expect(screen.getByText('Add a new task to the project backlog')).toBeInTheDocument();
  });

  it('renders all form fields with correct labels', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    expect(screen.getByLabelText('Task Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Priority')).toBeInTheDocument();
    expect(screen.getByLabelText('Assign To')).toBeInTheDocument();
  });

  it('marks title field as required', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleLabel = screen.getByLabelText('Task Title');
    expect(titleLabel.closest('label')).toHaveAttribute('data-required', 'true');
    expect(screen.getByTestId('title')).toHaveAttribute('required');
  });

  it('renders form fields with correct placeholders', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    expect(screen.getByPlaceholderText('Enter task title...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter task description...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Team member name...')).toBeInTheDocument();
  });

  it('renders priority dropdown with correct options', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const priorityDropdown = screen.getByTestId('priority');
    expect(priorityDropdown).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Low' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Medium' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument();
  });

  it('has medium as default priority', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    expect(screen.getByTestId('priority')).toHaveValue('medium');
  });

  it('calls onClose when cancel button is clicked', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('updates form fields when user types', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleInput = screen.getByTestId('title');
    const descriptionInput = screen.getByTestId('description');
    const assignedToInput = screen.getByTestId('assignedTo');

    await user.type(titleInput, 'Test Task Title');
    await user.type(descriptionInput, 'Test task description');
    await user.type(assignedToInput, 'John Doe');

    expect(titleInput).toHaveValue('Test Task Title');
    expect(descriptionInput).toHaveValue('Test task description');
    expect(assignedToInput).toHaveValue('John Doe');
  });

  it('updates priority when dropdown value changes', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const priorityDropdown = screen.getByTestId('priority');
    await user.selectOptions(priorityDropdown, 'high');

    expect(priorityDropdown).toHaveValue('high');
  });

  it('submits form with correct data when all fields are filled', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleInput = screen.getByTestId('title');
    const descriptionInput = screen.getByTestId('description');
    const priorityDropdown = screen.getByTestId('priority');
    const assignedToInput = screen.getByTestId('assignedTo');
    const submitButton = screen.getByRole('button', { name: 'Create Task' });

    await user.type(titleInput, 'Test Task');
    await user.type(descriptionInput, 'Test description');
    await user.selectOptions(priorityDropdown, 'high');
    await user.type(assignedToInput, 'Jane Smith');

    await user.click(submitButton);

    expect(mockOnSubmit).toHaveBeenCalledWith({
      title: 'Test Task',
      description: 'Test description',
      priority: 'high',
      assignedTo: 'Jane Smith'
    });
  });

  it('submits form with undefined assignedTo when field is empty', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleInput = screen.getByTestId('title');
    const submitButton = screen.getByRole('button', { name: 'Create Task' });

    await user.type(titleInput, 'Test Task');
    await user.click(submitButton);

    expect(mockOnSubmit).toHaveBeenCalledWith({
      title: 'Test Task',
      description: '',
      priority: 'medium',
      assignedTo: undefined
    });
  });

  it('shows alert when trying to submit without title', async () => {
    // Mock window.alert
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const submitButton = screen.getByRole('button', { name: 'Create Task' });
    await user.click(submitButton);

    expect(alertSpy).toHaveBeenCalledWith('Task title is required');
    expect(mockOnSubmit).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('shows alert when trying to submit with whitespace-only title', async () => {
    // Mock window.alert
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleInput = screen.getByTestId('title');
    const submitButton = screen.getByRole('button', { name: 'Create Task' });

    await user.type(titleInput, '   ');
    await user.click(submitButton);

    expect(alertSpy).toHaveBeenCalledWith('Task title is required');
    expect(mockOnSubmit).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('trims whitespace from form fields before submission', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleInput = screen.getByTestId('title');
    const descriptionInput = screen.getByTestId('description');
    const assignedToInput = screen.getByTestId('assignedTo');
    const submitButton = screen.getByRole('button', { name: 'Create Task' });

    await user.type(titleInput, '  Test Task  ');
    await user.type(descriptionInput, '  Test description  ');
    await user.type(assignedToInput, '  John Doe  ');

    await user.click(submitButton);

    expect(mockOnSubmit).toHaveBeenCalledWith({
      title: 'Test Task',
      description: 'Test description',
      priority: 'medium',
      assignedTo: 'John Doe'
    });
  });

  it('handles form submission via Enter key', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleInput = screen.getByTestId('title');
    await user.type(titleInput, 'Test Task');
    await user.keyboard('{Enter}');

    expect(mockOnSubmit).toHaveBeenCalledWith({
      title: 'Test Task',
      description: '',
      priority: 'medium',
      assignedTo: undefined
    });
  });

  it('renders with correct modal size', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    expect(screen.getByTestId('form-popup')).toHaveAttribute('data-size', 'md');
  });

  it('renders textarea with correct rows', () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    expect(screen.getByTestId('description')).toHaveAttribute('rows', '4');
  });

  it('maintains form state during user interaction', async () => {
    render(
      <TaskCreateModal
        onClose={mockOnClose}
        onSubmit={mockOnSubmit}
      />
    );

    const titleInput = screen.getByTestId('title');
    const descriptionInput = screen.getByTestId('description');
    const priorityDropdown = screen.getByTestId('priority');

    // Fill out form
    await user.type(titleInput, 'Test Task');
    await user.type(descriptionInput, 'Description');
    await user.selectOptions(priorityDropdown, 'high');

    // Verify values persist
    expect(titleInput).toHaveValue('Test Task');
    expect(descriptionInput).toHaveValue('Description');
    expect(priorityDropdown).toHaveValue('high');

    // Modify values
    await user.clear(titleInput);
    await user.type(titleInput, 'Updated Task');

    expect(titleInput).toHaveValue('Updated Task');
    expect(descriptionInput).toHaveValue('Description'); // Should remain unchanged
    expect(priorityDropdown).toHaveValue('high'); // Should remain unchanged
  });
});