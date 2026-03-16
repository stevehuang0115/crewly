/**
 * OpenTelemetry Tracing Service
 *
 * Provides distributed tracing for the Crewly backend using OpenTelemetry.
 * Configurable via environment variables:
 *   - OTEL_ENABLED: 'true' to enable tracing (default: disabled)
 *   - OTEL_EXPORTER_ENDPOINT: OTLP HTTP endpoint (default: http://localhost:4318/v1/traces)
 *   - OTEL_SERVICE_NAME: Service name in traces (default: crewly-backend)
 *
 * When disabled, all operations return no-op spans with zero overhead.
 *
 * @module services/core/tracing
 */

import { trace, Tracer, Span, SpanStatusCode, context, SpanOptions } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { TRACING_CONSTANTS } from '../../constants.js';

/**
 * Configuration resolved from environment variables.
 */
export interface TracingConfig {
	/** Whether tracing is enabled */
	enabled: boolean;
	/** OTLP exporter endpoint URL */
	exporterEndpoint: string;
	/** Service name reported in traces */
	serviceName: string;
}

/**
 * Singleton service that manages OpenTelemetry tracing lifecycle.
 *
 * Usage:
 * ```typescript
 * const tracing = TracingService.getInstance();
 * tracing.initialize();
 *
 * // Create a span around an operation
 * const result = await tracing.withSpan('my.operation', { attributes: { key: 'value' } }, async (span) => {
 *   span.setAttribute('custom.attr', 42);
 *   return doWork();
 * });
 *
 * // Or get a tracer for manual instrumentation
 * const tracer = tracing.getTracer();
 * ```
 */
export class TracingService {
	private static instance: TracingService | null = null;
	private provider: NodeTracerProvider | null = null;
	private tracer: Tracer | null = null;
	private config: TracingConfig;
	private initialized = false;

	private constructor() {
		this.config = this.resolveConfig();
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns TracingService instance
	 */
	static getInstance(): TracingService {
		if (!TracingService.instance) {
			TracingService.instance = new TracingService();
		}
		return TracingService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		if (TracingService.instance) {
			TracingService.instance.shutdown().catch(() => {});
		}
		TracingService.instance = null;
	}

	/**
	 * Initialize the tracing provider and register it globally.
	 * Safe to call multiple times — subsequent calls are no-ops.
	 *
	 * When OTEL_ENABLED is not 'true', this registers a no-op provider
	 * so all span creation has zero overhead.
	 */
	initialize(): void {
		if (this.initialized) return;

		if (!this.config.enabled) {
			// Use the default no-op tracer from the API — zero overhead
			this.tracer = trace.getTracer(this.config.serviceName);
			this.initialized = true;
			return;
		}

		const resource = resourceFromAttributes({
			[ATTR_SERVICE_NAME]: this.config.serviceName,
			[ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
		});

		const exporter = new OTLPTraceExporter({
			url: this.config.exporterEndpoint,
		});

		this.provider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		this.provider.register();

		this.tracer = this.provider.getTracer(this.config.serviceName);
		this.initialized = true;
	}

	/**
	 * Initialize with an in-memory exporter for testing.
	 * Returns the exporter so tests can inspect captured spans.
	 *
	 * @returns InMemorySpanExporter instance
	 */
	initializeForTesting(): InMemorySpanExporter {
		if (this.initialized) {
			this.shutdown().catch(() => {});
			this.initialized = false;
		}

		const exporter = new InMemorySpanExporter();

		const resource = resourceFromAttributes({
			[ATTR_SERVICE_NAME]: 'crewly-backend-test',
		});

		this.provider = new NodeTracerProvider({
			resource,
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		this.provider.register();

		// Use provider.getTracer() directly to avoid global tracer provider race conditions
		this.tracer = this.provider.getTracer('crewly-backend-test');
		this.initialized = true;
		this.config = { ...this.config, enabled: true };

		return exporter;
	}

	/**
	 * Shut down the tracing provider, flushing pending spans.
	 */
	async shutdown(): Promise<void> {
		if (this.provider) {
			await this.provider.shutdown();
			this.provider = null;
		}
		this.tracer = null;
		this.initialized = false;
	}

	/**
	 * Get the active tracer instance.
	 *
	 * @returns OpenTelemetry Tracer (no-op if tracing is disabled)
	 */
	getTracer(): Tracer {
		if (!this.initialized) {
			this.initialize();
		}
		return this.tracer || trace.getTracer(this.config.serviceName);
	}

	/**
	 * Execute an async function within a traced span.
	 *
	 * Automatically sets span status to ERROR on exception and records
	 * the error message. The span is ended when the function completes.
	 *
	 * @param name - Span name (use TRACING_CONSTANTS.SPANS values)
	 * @param optionsOrFn - SpanOptions or the function to execute
	 * @param maybeFn - The function to execute (if options were provided)
	 * @returns The return value of the executed function
	 */
	async withSpan<T>(
		name: string,
		optionsOrFn: SpanOptions | ((span: Span) => Promise<T>),
		maybeFn?: (span: Span) => Promise<T>,
	): Promise<T> {
		const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
		const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;

		const tracer = this.getTracer();
		const span = tracer.startSpan(name, options);

		try {
			const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			span.end();
		}
	}

	/**
	 * Execute a synchronous function within a traced span.
	 *
	 * @param name - Span name
	 * @param optionsOrFn - SpanOptions or the function to execute
	 * @param maybeFn - The function to execute (if options were provided)
	 * @returns The return value of the executed function
	 */
	withSpanSync<T>(
		name: string,
		optionsOrFn: SpanOptions | ((span: Span) => T),
		maybeFn?: (span: Span) => T,
	): T {
		const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
		const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;

		const tracer = this.getTracer();
		const span = tracer.startSpan(name, options);

		try {
			const result = context.with(trace.setSpan(context.active(), span), () => fn(span));
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			span.end();
		}
	}

	/**
	 * Get the current tracing configuration.
	 *
	 * @returns Resolved tracing config
	 */
	getConfig(): TracingConfig {
		return { ...this.config };
	}

	/**
	 * Check whether tracing is enabled and initialized.
	 *
	 * @returns True if tracing is active
	 */
	isEnabled(): boolean {
		return this.config.enabled && this.initialized;
	}

	/**
	 * Resolve configuration from environment variables.
	 *
	 * @returns TracingConfig with values from env or defaults
	 */
	private resolveConfig(): TracingConfig {
		return {
			enabled: process.env[TRACING_CONSTANTS.ENV_VARS.ENABLED] === 'true',
			exporterEndpoint:
				process.env[TRACING_CONSTANTS.ENV_VARS.ENDPOINT] ||
				TRACING_CONSTANTS.DEFAULT_EXPORTER_ENDPOINT,
			serviceName:
				process.env[TRACING_CONSTANTS.ENV_VARS.SERVICE_NAME] ||
				TRACING_CONSTANTS.DEFAULT_SERVICE_NAME,
		};
	}
}
