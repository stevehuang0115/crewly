import React from 'react';

// Form Container
export interface FormProps extends React.FormHTMLAttributes<HTMLFormElement> {
  children: React.ReactNode;
}

export const Form: React.FC<FormProps> = ({ children, className = '', ...props }) => (
  <form className={`form ${className}`} {...props}>
    {children}
  </form>
);

// Form Group
export interface FormGroupProps {
  children: React.ReactNode;
  className?: string;
}

export const FormGroup: React.FC<FormGroupProps> = ({ children, className = '' }) => (
  <div className={`form-group ${className}`}>
    {children}
  </div>
);

// Form Row (for horizontal layouts)
export interface FormRowProps {
  children: React.ReactNode;
  className?: string;
}

export const FormRow: React.FC<FormRowProps> = ({ children, className = '' }) => (
  <div className={`form-row ${className}`}>
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
  <small className={`form-help ${className}`}>
    {children}
  </small>
);

// Form Error Message
export interface FormErrorProps {
  children: React.ReactNode;
  className?: string;
}

export const FormError: React.FC<FormErrorProps> = ({ children, className = '' }) => (
  <div className={`form-error ${className}`}>
    {children}
  </div>
);

// Form Input
export interface FormInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const FormInput: React.FC<FormInputProps> = ({
  error = false,
  className = '',
  ...props
}) => (
  <input
    className={`w-full bg-background-dark border border-border-dark rounded-2xl shadow-sm focus:ring-1 focus:ring-primary focus:border-primary py-2 px-3 text-sm ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''} ${className}`}
    {...props}
  />
);

// Form Textarea
export interface FormTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const FormTextarea: React.FC<FormTextareaProps> = ({
  error = false,
  className = '',
  ...props
}) => (
  <textarea
    className={`w-full bg-background-dark border border-border-dark rounded-2xl shadow-sm focus:ring-1 focus:ring-primary focus:border-primary py-2 px-3 text-sm resize-vertical ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''} ${className}`}
    {...props}
  />
);

// Form Select
export interface FormSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const FormSelect: React.FC<FormSelectProps> = ({
  error = false,
  className = '',
  children,
  ...props
}) => (
  <div className="relative w-full">
    <select
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
);

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
  <div className={`form-section ${className}`}>
    {(title || description) && (
      <div className="form-section-header">
        {title && <h3 className="form-section-title">{title}</h3>}
        {description && <p className="form-section-description">{description}</p>}
      </div>
    )}
    <div className="form-section-content">
      {children}
    </div>
  </div>
);