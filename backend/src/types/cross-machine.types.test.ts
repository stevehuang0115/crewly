/**
 * Cross-Machine Types Tests
 *
 * Tests for cross-machine message parsing and serialization utilities.
 *
 * @module types/cross-machine.types.test
 */

import {
  parseCrossMachineMessage,
  serializeCrossMachineMessage,
  CROSS_MACHINE_PREFIX,
  type CrossMachineMessage,
} from './cross-machine.types.js';

describe('cross-machine.types', () => {
  const sampleMessage: CrossMachineMessage = {
    protocol: 'crewly-x-machine',
    version: 1,
    from: 'device-aaa',
    fromName: 'MacBook-Pro',
    to: 'device-bbb',
    type: 'delegate-task',
    payload: { task: 'Run tests', priority: 'high' },
    timestamp: '2026-03-22T12:00:00.000Z',
    messageId: 'msg-123',
  };

  describe('CROSS_MACHINE_PREFIX', () => {
    it('should be a recognizable string prefix', () => {
      expect(CROSS_MACHINE_PREFIX).toBe('🔗 [X-MACHINE]');
    });
  });

  describe('serializeCrossMachineMessage', () => {
    it('should produce a string starting with the prefix', () => {
      const result = serializeCrossMachineMessage(sampleMessage);
      expect(result.startsWith(CROSS_MACHINE_PREFIX)).toBe(true);
    });

    it('should contain valid JSON after the prefix', () => {
      const result = serializeCrossMachineMessage(sampleMessage);
      const jsonPart = result.slice(CROSS_MACHINE_PREFIX.length).trim();
      expect(() => JSON.parse(jsonPart)).not.toThrow();
    });

    it('should roundtrip the message correctly', () => {
      const serialized = serializeCrossMachineMessage(sampleMessage);
      const parsed = parseCrossMachineMessage(serialized);
      expect(parsed).toEqual(sampleMessage);
    });
  });

  describe('parseCrossMachineMessage', () => {
    it('should return null for regular messages', () => {
      expect(parseCrossMachineMessage('Hello, how are you?')).toBeNull();
      expect(parseCrossMachineMessage('status check please')).toBeNull();
      expect(parseCrossMachineMessage('')).toBeNull();
    });

    it('should return null for messages with prefix but invalid JSON', () => {
      expect(parseCrossMachineMessage(`${CROSS_MACHINE_PREFIX} not json`)).toBeNull();
    });

    it('should return null for messages with prefix but missing required fields', () => {
      const incomplete = `${CROSS_MACHINE_PREFIX} {"protocol":"crewly-x-machine","from":"a"}`;
      expect(parseCrossMachineMessage(incomplete)).toBeNull();
    });

    it('should return null for wrong protocol', () => {
      const wrongProto = `${CROSS_MACHINE_PREFIX} ${JSON.stringify({
        ...sampleMessage,
        protocol: 'wrong-protocol',
      })}`;
      expect(parseCrossMachineMessage(wrongProto)).toBeNull();
    });

    it('should parse a valid cross-machine message', () => {
      const serialized = serializeCrossMachineMessage(sampleMessage);
      const parsed = parseCrossMachineMessage(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.protocol).toBe('crewly-x-machine');
      expect(parsed!.from).toBe('device-aaa');
      expect(parsed!.to).toBe('device-bbb');
      expect(parsed!.type).toBe('delegate-task');
      expect(parsed!.payload).toEqual({ task: 'Run tests', priority: 'high' });
      expect(parsed!.messageId).toBe('msg-123');
    });

    it('should parse broadcast messages', () => {
      const broadcast = { ...sampleMessage, to: '*' };
      const serialized = serializeCrossMachineMessage(broadcast);
      const parsed = parseCrossMachineMessage(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.to).toBe('*');
    });

    it('should parse all message types', () => {
      const types = ['delegate-task', 'send-message', 'status-request', 'status-response', 'ping', 'pong'] as const;
      for (const type of types) {
        const msg = { ...sampleMessage, type };
        const serialized = serializeCrossMachineMessage(msg);
        const parsed = parseCrossMachineMessage(serialized);
        expect(parsed).not.toBeNull();
        expect(parsed!.type).toBe(type);
      }
    });
  });
});
