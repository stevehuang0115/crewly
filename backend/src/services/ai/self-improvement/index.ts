/**
 * Self-Improvement System — Agent metacognitive capabilities.
 *
 * Provides services for agents to track their own growth,
 * recognize patterns in their behavior, calibrate predictions,
 * manage attention, and consolidate memories.
 */

export { GrowthAreasService, GrowthArea, GrowthAreasData } from './growth-areas.service.js';
export { SelfModelService, DecisionPattern, CognitiveBias, BlindSpot, SelfModelData } from './self-model.service.js';
export {
	PredictionCalibrationService,
	Prediction,
	PredictionsData,
} from './prediction-calibration.service.js';
export { AttentionService, AttentionData } from './attention.service.js';
export {
	MemoryConsolidationService,
	ConsolidatedPattern,
	ConsolidatedInsight,
	ConsolidationReport,
	MemoryProvider,
} from './memory-consolidation.service.js';
