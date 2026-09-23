import React from 'react';

// Form Container
export interface FormProps extends React.FormHTMLAttributes<HTMLFormElement> {
  children: React.ReactNode;
}

export const Form: React.FC<FormProps> = ({ children, className = '', ...props }) => (
  <form className={`form space-y-6 ${className}`} {...props}>
    {children}
  </form>
);

// Form Group
export interface FormGroupProps {
  children: React.ReactNode;
  className?: string;
}

export const FormGroup: React.FC<FormGroupProps> = ({ children, className = '' }) => (
  <div className={`form-group flex flex-col ${className}`}>
    {children}
  </div>
);

// Form Row (for horizontal layouts)
export interface FormRowProps {
  children: React.ReactNode;
  className?: string;
}

export const FormRow: React.FC<FormRowProps> = ({ children, className = '' }) => (
  <div className={`form-row grid grid-cols-1 sm:grid-cols-2 gap-4 ${className}`}>
    {children}
  </div>
);

// Form Label
export interface FormLabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  children: React.ReactNode;
  required?: boolean;
}

export const FormLabel: React.FC<FormLabelProps> = ({
  children,
  required = false,
  className = '',
  ...props
}) => (
  <label className={`block text-sm font-medium text-text-primary-dark mb-2 ${className}`} {...props}>
    {children}
    {required && <span className="text-red-500 ml-1">*</span>}
  </label>
);

// Form Help Text
export interface FormHelpProps {
  children: React.ReactNode;
  className?: string;
}

export const FormHelp: React.FC<FormHelpProps> = ({ children, className = '' }) => (
  <small className={`form-help block text-xs text-text-secondary-dark mt-1.5 ${className}`}>
    {children}
  </small>
);

// Form Error Message
export interface FormErrorProps {
  children: React.ReactNode;
  className?: string;
}

export const FormError: React.FC<FormErrorProps> = ({ children, className = '' }) => (
  <div className={`form-error text-xs text-red-400 mt-1.5 ${className}`}>
    {children}
  </div>
);

// Form Input
export interface FormInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  error?: boolean;
  /** `sm` for compact filters and inline fields */
  size?: 'md' | 'sm';
}

export const FormInput = React.forwardRef<HTMLInputElement, FormInputProps>(({
  error = false,
  size = 'md',
  className = '',
  ...props
}, ref) => (
  <input
    ref={ref}
    className={`w-full bg-background-dark border border-border-dark shadow-sm focus:ring-1 focus:ring-primary focus:border-primary ${size === 'sm' ? 'rounded-[0.75rem] py-1 px-2.5 text-xs' : 'rounded-2xl py-2 px-3 text-sm'} ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''} ${className}`}
    {...props}
  />
));
FormInput.displayName = 'FormInput';

// Form Textarea
export interface FormTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const FormTextarea = React.forwardRef<HTMLTextAreaElement, FormTextareaProps>(({
  error = false,
  className = '',
  ...props
}, ref) => (
  <textarea
    ref={ref}
    className={`w-full bg-background-dark border border-border-dark rounded-2xl shadow-sm focus:ring-1 focus:ring-primary focus:border-primary py-2 px-3 text-sm resize-vertical ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''} ${className}`}
    {...props}
  />
));
FormTextarea.displayName = 'FormTextarea';

// Form Select
export interface FormSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const FormSelect = React.forwardRef<HTMLSelectElement, FormSelectProps>(({
  error = false,
  className = '',
  children,
  ...props
}, ref) => (
  <div className="relative w-full">
    <select
      ref={ref}
      className={`w-full appearance-none bg-background-dark border border-border-dark rounded-2xl shadow-sm focus:ring-1 focus:ring-primary focus:border-primary py-2 pl-3 pr-8 text-sm ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''} ${className}`}
      {...props}
    >
      {children}
    </select>
    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-text-secondary-dark">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  </div>
));
FormSelect.displayName = 'FormSelect';

// Form Section (for grouping related form elements)
export interface FormSectionProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export const FormSection: React.FC<FormSectionProps> = ({ 
  title, 
  description, 
  children, 
  className = '' 
}) => (
  <div className={`form-section space-y-4 ${className}`}>
    {(title || description) && (
      <div className="form-section-header">
        {title && <h3 className="form-section-title text-base font-semibold">{title}</h3>}
        {description && <p className="form-section-description text-sm text-text-secondary-dark mt-1">{description}</p>}
      </div>
    )}
    <div className="form-section-content space-y-4">
      {children}
    </div>
  </div>
);