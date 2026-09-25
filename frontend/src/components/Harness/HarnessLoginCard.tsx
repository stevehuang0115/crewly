/**
 * HarnessLoginCard
 *
 * The login card for one harness: current login state, a method switch
 * (subscription / device / API key) and the matching login UI. Used in
 * the setup flow and permanently in Settings → Harness, since logins
 * expire and people come back to re-login.
 *
 * @module components/Harness/HarnessLoginCard
 */

import React, { useState } from 'react';
import { Badge, Button, Card, SegmentedControl } from '@crewly/ui';
import type { HarnessLoginMethodId, HarnessStatus } from '../../types/harness.types';
import { LOGIN_STATE_BADGES, loginMethodLabel } from '../../constants/harness.constants';
import { ApiKeyForm } from './ApiKeyForm';
import { BrokerLoginPanel } from './BrokerLoginPanel';

export interface HarnessLoginCardProps {
  /** Harness to log in to */
  harness: HarnessStatus;
  /** Called after a broker login succeeds (refresh status) */
  onLoggedIn?: () => void;
  /** Called with the new status after an API key is saved */
  onHarnessUpdated?: (status: HarnessStatus) => void;
}

/**
 * Login card for a harness.
 *
 * @param props - {@link HarnessLoginCardProps}
 * @returns Card element
 */
export const HarnessLoginCard: React.FC<HarnessLoginCardProps> = ({ harness, onLoggedIn, onHarnessUpdated }) => {
  const methods = harness.loginMethods;
  const [methodId, setMethodId] = useState<HarnessLoginMethodId | null>(methods[0]?.id ?? null);
  const [relogin, setRelogin] = useState(false);
  const badge = LOGIN_STATE_BADGES[harness.loginState];
  const method = methods.find((m) => m.id === methodId) ?? methods[0];
  const showMethods = harness.installed && methods.length > 0 && (harness.loginState !== 'logged_in' || relogin);

  /** Body copy / controls depending on install + method availability. */
  const renderBody = (): React.ReactNode => {
    if (!harness.installed) {
      return <p className="text-sm text-text-secondary-dark">请先安装 {harness.displayName}。Install it first.</p>;
    }
    if (methods.length === 0) {
      return (
        <p className="text-sm text-text-secondary-dark">
          暂不支持在网页登录 {harness.displayName}，请在终端里完成登录。Browser login isn&apos;t available for this harness yet.
        </p>
      );
    }
    if (!showMethods) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-secondary-dark">
            {harness.loginSource ? `已通过 ${harness.loginSource} 登录。` : '已登录。'}登录过期时可以在这里重新登录。
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setRelogin(true)}>
            重新登录 / Re-login
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {methods.length > 1 && (
          <SegmentedControl<HarnessLoginMethodId>
            aria-label="登录方式 / Login method"
            fullWidth
            size="sm"
            value={method.id}
            onChange={setMethodId}
            options={methods.map((m) => ({ value: m.id, label: loginMethodLabel(harness.id, m.id, m.label) }))}
          />
        )}
        {method.kind === 'api_key' ? (
          <ApiKeyForm
            key={`${harness.id}-${method.id}`}
            harnessId={harness.id}
            label={loginMethodLabel(harness.id, method.id, method.label)}
            onSaved={(status) => {
              setRelogin(false);
              onHarnessUpdated?.(status);
            }}
          />
        ) : (
          <BrokerLoginPanel
            key={`${harness.id}-${method.id}`}
            harnessId={harness.id}
            method={method.id === 'device' ? 'device' : 'subscription'}
            label={loginMethodLabel(harness.id, method.id, method.label)}
            onSucceeded={() => onLoggedIn?.()}
          />
        )}
      </div>
    );
  };

  return (
    <Card padding="md" data-testid={`harness-login-card-${harness.id}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-text-primary-dark">登录 {harness.displayName}</h3>
        {harness.installed && <Badge variant={badge.variant}>{badge.label}</Badge>}
      </div>
      {renderBody()}
    </Card>
  );
};
