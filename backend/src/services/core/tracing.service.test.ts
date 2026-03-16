import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { TracingService } from './tracing.service.js';
import { TRACING_CONSTANTS } from '../../constants.js';

describe('TracingService', () => {
	let service: TracingService;

	beforeEach(() => {
		TracingService.resetInstance();
		service = TracingService.getInstance();
	});

	afterEach(() => {
		TracingService.resetInstance();
	});

	describe('singleton', () => {
		it('should return the same instance', () => {
			const a = TracingService.getInstance();
			const b = TracingService.getInstance();
			expect(a).toBe(b);
		});

		it('should create a new instance after resetInstance', () => {
			const a = TracingService.getInstance();
			TracingService.resetInstance();
			const b = TracingService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('initialize', () => {
		it('should initialize without error when disabled', () => {
			service.initialize();
			expect(service.isEnabled()).toBe(false);
		});

		it('should be idempotent (safe to call multiple times)', () => {
			service.initialize();
			service.initialize();
			expect(service.isEnabled()).toBe(false);
		});

		it('should provide a tracer even when disabled', () => {
			service.initialize();
			const tracer = service.getTracer();
			expect(tracer).toBeDefined();
		});
	});

	describe('initializeForTesting', () => {
		it('should return an InMemorySpanExporter', () => {
			const exporter = service.initializeForTesting();
			expect(exporter).toBeInstanceOf(InMemorySpanExporter);
		});

		it('should mark service as enabled', () => {
			service.initializeForTesting();
			expect(service.isEnabled()).toBe(true);
		});
	});

	describe('getConfig', () => {
		it('should return default config when no env vars set', () => {
			const config = service.getConfig();
			expect(config.enabled).toBe(false);
			expect(config.exporterEndpoint).toBe(TRACING_CONSTANTS.DEFAULT_EXPORTER_ENDPOINT);
			expect(config.serviceName).toBe(TRACING_CONSTANTS.DEFAULT_SERVICE_NAME);
		});
	});

	describe('withSpan', () => {
		let exporter: InMemorySpanExporter;

		beforeEach(() => {
			exporter = service.initializeForTesting();
		});

		it('should create a span around an async operation', async () => {
			const result = await service.withSpan('test.operation', async (span) => {
				span.setAttribute('test.key', 'value');
				return 42;
			});

			expect(result).toBe(42);

			const spans = exporter.getFinishedSpans();
			expect(spans.length).toBe(1);
			expect(spans[0].name).toBe('test.operation');
			expect(spans[0].status.code).toBe(SpanStatusCode.OK);
		});

		it('should set error status on exception', async () => {
			await expect(
				service.withSpan('test.failing', async () => {
					throw new Error('test failure');
				}),
			).rejects.toThrow('test failure');

			const spans = exporter.getFinishedSpans();
			expect(spans.length).toBe(1);
			expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
			expect(spans[0].status.message).toBe('test failure');
		});

		it('should accept SpanOptions as second argument', async () => {
			await service.withSpan(
				'test.with-options',
				{ attributes: { 'init.attr': 'hello' } },
				async (span) => {
					span.setAttribute('extra', true);
				},
			);

			const spans = exporter.getFinishedSpans();
			expect(spans.length).toBe(1);
			expect(spans[0].name).toBe('test.with-options');
			const attrs = spans[0].attributes;
			expect(attrs['init.attr']).toBe('hello');
			expect(attrs['extra']).toBe(true);
		});

		it('should work with TRACING_CONSTANTS span names', async () => {
			await service.withSpan(TRACING_CONSTANTS.SPANS.TASK_CREATE, async (span) => {
				span.setAttribute('task.id', 'task-123');
			});

			const spans = exporter.getFinishedSpans();
			expect(spans[0].name).toBe('task.create');
		});
	});

	describe('withSpanSync', () => {
		let exporter: InMemorySpanExporter;

		beforeEach(() => {
			exporter = service.initializeForTesting();
		});

		it('should create a span around a sync operation', () => {
			const result = service.withSpanSync('test.sync', (span) => {
				span.setAttribute('sync', true);
				return 'done';
			});

			expect(result).toBe('done');

			const spans = exporter.getFinishedSpans();
			expect(spans.length).toBe(1);
			expect(spans[0].name).toBe('test.sync');
			expect(spans[0].status.code).toBe(SpanStatusCode.OK);
		});

		it('should set error status on sync exception', () => {
			expect(() =>
				service.withSpanSync('test.sync-fail', () => {
					throw new Error('sync error');
				}),
			).toThrow('sync error');

			const spans = exporter.getFinishedSpans();
			expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
			expect(spans[0].status.message).toBe('sync error');
		});

		it('should accept SpanOptions as second argument', () => {
			service.withSpanSync(
				'test.sync-options',
				{ attributes: { 'option.key': 99 } },
				(span) => {
					span.setAttribute('run', true);
				},
			);

			const spans = exporter.getFinishedSpans();
			expect(spans[0].attributes['option.key']).toBe(99);
			expect(spans[0].attributes['run']).toBe(true);
		});
	});

	describe('shutdown', () => {
		it('should shut down cleanly', async () => {
			service.initializeForTesting();
			expect(service.isEnabled()).toBe(true);

			await service.shutdown();
			expect(service.isEnabled()).toBe(false);
		});

		it('should be safe to call when not initialized', async () => {
			await expect(service.shutdown()).resolves.toBeUndefined();
		});
	});

	describe('disabled mode', () => {
		it('should return results from withSpan even when disabled', async () => {
			service.initialize(); // disabled by default (no OTEL_ENABLED env var)
			const result = await service.withSpan('noop.span', async () => 'noop-result');
			expect(result).toBe('noop-result');
		});

		it('should return results from withSpanSync even when disabled', () => {
			service.initialize();
			const result = service.withSpanSync('noop.sync', () => 123);
			expect(result).toBe(123);
		});

		it('should propagate errors from withSpan when disabled', async () => {
			service.initialize();
			await expect(
				service.withSpan('noop.error', async () => {
					throw new Error('still throws');
				}),
			).rejects.toThrow('still throws');
		});
	});
});
