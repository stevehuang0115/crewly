import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { QrCode, X, Wifi, Copy, Check } from 'lucide-react';
import { Button, IconButton } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Popup } from '@crewly/ui/Popup';
import clsx from 'clsx';
import axios from 'axios';

interface LocalIpResponse {
  success: boolean;
  data: {
    ip: string;
    port: number;
    url: string;
    timestamp: string;
  };
}

interface QRCodeDisplayProps {
  isCollapsed: boolean;
}

/**
 * QRCodeDisplay component shows a QR code for mobile access.
 * When the sidebar is collapsed, shows a small QR icon button.
 * When expanded, shows a more detailed button with text.
 * Clicking opens a modal with the QR code and URL information.
 *
 * @param isCollapsed - Whether the sidebar is in collapsed state
 * @returns React component for QR code display
 */
export const QRCodeDisplay: React.FC<QRCodeDisplayProps> = ({ isCollapsed }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * Fetches the local IP address from the backend API.
   * Uses the current window port (frontend port) instead of backend port.
   */
  const fetchLocalIp = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await axios.get<LocalIpResponse>('/api/system/local-ip');
      if (response.data.success && response.data.data.ip) {
        // Use the current window port (frontend) instead of backend port
        const currentPort = window.location.port || '80';
        const ip = response.data.data.ip;
        const url = `http://${ip}:${currentPort}`;
        setLocalUrl(url);
      } else {
        setError('Failed to get local IP address');
      }
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Opens the modal and fetches the local IP if not already loaded.
   */
  const handleOpenModal = useCallback(() => {
    setIsModalOpen(true);
    if (!localUrl) {
      fetchLocalIp();
    }
  }, [localUrl, fetchLocalIp]);

  /**
   * Closes the modal.
   */
  const handleCloseModal = useCallback(() => {
    setIsModalOpen(false);
    setCopied(false);
  }, []);

  /**
   * Copies the URL to clipboard.
   */
  const handleCopyUrl = useCallback(async () => {
    if (localUrl) {
      try {
        await navigator.clipboard.writeText(localUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = localUrl;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  }, [localUrl]);

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isModalOpen) {
        handleCloseModal();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isModalOpen, handleCloseModal]);

  return (
    <>
      {/* QR Code Button */}
      <button
        onClick={handleOpenModal}
        className={clsx(
          'group flex items-center w-full px-4 py-2 text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark rounded-2xl transition-colors text-sm',
          isCollapsed ? 'md:justify-center' : ''
        )}
        title="Scan QR code for mobile access"
        aria-label="Open QR code for mobile access"
      >
        <QrCode className="h-5 w-5 flex-shrink-0" />
        <span className={clsx('ml-3', isCollapsed ? 'md:hidden' : '')}>Mobile Access</span>
      </button>

      {/* Modal - rendered via portal so the sidebar's layout can't affect centering */}
      {createPortal(
        <Popup
          isOpen={isModalOpen}
          onClose={handleCloseModal}
          title="Mobile Access"
          subtitle="Scan with your phone"
          size="sm"
          footer={
            <p className="text-xs text-text-secondary-dark text-center">
              Make sure your phone is connected to the same WiFi network as this computer
            </p>
          }
          footerAlign="center"
        >
          {isLoading ? (
            <LoadingSpinner size="md" text="Getting network address..." className="py-8" />
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8">
              <div className="p-3 bg-red-500/10 rounded-full mb-3">
                <X className="h-6 w-6 text-red-500" />
              </div>
              <p className="text-sm text-red-400">{error}</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={fetchLocalIp}>
                Retry
              </Button>
            </div>
          ) : localUrl ? (
            <div className="flex flex-col items-center">
              {/* QR Code — needs a white quiet zone to scan */}
              <div className="bg-white p-4 rounded-2xl">
                <QRCodeSVG
                  value={localUrl}
                  size={200}
                  level="M"
                  includeMargin={false}
                />
              </div>

              {/* WiFi Indicator */}
              <div className="flex items-center gap-2 mt-4 text-sm text-text-secondary-dark">
                <Wifi className="h-4 w-4 text-green-500" />
                <span>Same WiFi network required</span>
              </div>

              {/* URL with Copy Button */}
              <div className="mt-4 w-full">
                <div className="flex items-center gap-2 bg-background-dark rounded-2xl p-3">
                  <code className="flex-1 text-sm text-primary truncate">
                    {localUrl}
                  </code>
                  <IconButton
                    icon={copied ? Check : Copy}
                    size="sm"
                    onClick={handleCopyUrl}
                    className={copied ? 'text-green-500' : ''}
                    title={copied ? 'Copied!' : 'Copy URL'}
                    aria-label={copied ? 'URL copied' : 'Copy URL to clipboard'}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </Popup>,
        document.body
      )}
    </>
  );
};

export default QRCodeDisplay;
