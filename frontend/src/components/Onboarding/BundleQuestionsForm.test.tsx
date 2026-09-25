/**
 * Tests for BundleQuestionsForm: every question type, defaults, required
 * checks before submitting, and the server's missing answers.
 *
 * @module components/Onboarding/BundleQuestionsForm.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BundleQuestionsForm } from './BundleQuestionsForm';
import type { BundleQuestion } from '../../types/bundle.types';

const QUESTIONS: BundleQuestion[] = [
  { id: 'business_name', label: '公司或品牌叫什么？', type: 'text', required: true, placeholder: '例如：小周咖啡', help: '团队会用这个名字' },
  { id: 'what_you_sell', label: '你卖什么？', type: 'textarea', required: true },
  { id: 'platforms', label: '在哪些平台做内容？', type: 'multiselect', required: true, options: [{ value: '小红书' }, { value: '抖音' }] },
  { id: 'tone', label: '语气', type: 'select', required: false, default: '亲切自然', options: [{ value: '亲切自然' }, { value: '专业可信' }] },
];

describe('BundleQuestionsForm', () => {
  it('renders every question with its label, help and default', () => {
    render(<BundleQuestionsForm questions={QUESTIONS} submitLabel="部署" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/公司或品牌叫什么/)).toHaveAttribute('placeholder', '例如：小周咖啡');
    expect(screen.getByText('团队会用这个名字')).toBeInTheDocument();
    expect(screen.getByLabelText(/你卖什么/).tagName).toBe('TEXTAREA');
    expect(screen.getByRole('group', { name: /在哪些平台/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/语气/)).toHaveValue('亲切自然');
  });

  it('does not submit while a required answer is missing, and marks it', () => {
    const onSubmit = vi.fn();
    render(<BundleQuestionsForm questions={QUESTIONS} submitLabel="部署" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/公司或品牌叫什么/), { target: { value: '小周咖啡' } });
    fireEvent.click(screen.getByTestId('bundle-deploy'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('bundle-missing-what_you_sell')).toHaveTextContent('这一项必填');
    expect(screen.getByTestId('bundle-missing-platforms')).toHaveTextContent('请至少选一个');
    expect(screen.queryByTestId('bundle-missing-business_name')).not.toBeInTheDocument();
  });

  it('submits the answers: text, textarea, toggled chips and the select', () => {
    const onSubmit = vi.fn();
    render(<BundleQuestionsForm questions={QUESTIONS} submitLabel="部署小老板营销团队" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/公司或品牌叫什么/), { target: { value: '小周咖啡' } });
    fireEvent.change(screen.getByLabelText(/你卖什么/), { target: { value: '咖啡' } });
    fireEvent.click(screen.getByTestId('bundle-option-platforms-小红书'));
    fireEvent.click(screen.getByTestId('bundle-option-platforms-抖音'));
    fireEvent.click(screen.getByTestId('bundle-option-platforms-小红书'));
    expect(screen.getByTestId('bundle-option-platforms-抖音')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText(/语气/), { target: { value: '专业可信' } });
    fireEvent.click(screen.getByText('部署小老板营销团队'));
    expect(onSubmit).toHaveBeenCalledWith({ business_name: '小周咖啡', what_you_sell: '咖啡', platforms: ['抖音'], tone: '专业可信' });
  });

  it('shows the server error and the questions the server flagged', () => {
    render(
      <BundleQuestionsForm questions={QUESTIONS} submitLabel="部署" error="还没回答：你卖什么？" serverProblems={['what_you_sell']} onSubmit={vi.fn()} />,
    );
    expect(screen.getByText('还没回答：你卖什么？')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-missing-what_you_sell')).toBeInTheDocument();
  });

  it('a required select starts on 请选择', () => {
    render(
      <BundleQuestionsForm
        questions={[{ id: 'tz', label: '时区', type: 'select', required: true, options: [{ value: 'Asia/Shanghai', label: '北京时间' }] }]}
        submitLabel="部署"
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/时区/)).toHaveValue('');
    expect(screen.getByText('北京时间')).toBeInTheDocument();
  });
});
