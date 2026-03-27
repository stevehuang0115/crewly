/**
 * FactoryScene - Main React Three Fiber canvas and scene setup.
 *
 * This is the entry point for the 3D factory visualization.
 * It sets up the Canvas, providers, and renders all 3D components.
 */

import React, { Suspense, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { Stats, Preload, AdaptiveDpr, AdaptiveEvents } from '@react-three/drei';
import * as THREE from 'three';
import { FactoryProvider, useFactory } from '../../contexts/FactoryContext';
import { FACTORY_CONSTANTS, LIGHTING_CONFIGS } from '../../types/factory.types';

// Environment components
import { Lighting } from './Environment/Lighting';
import { Floor } from './Environment/Floor';
import { Walls } from './Environment/Walls';
import { OutdoorScenery } from './Environment/OutdoorScenery';

// Office components
import { OfficeZones } from './Office/OfficeZone';
import { Decorations } from './Office/Decorations';
import { ConveyorBelt } from './Office/ConveyorBelt';

// Interaction zones
import { BreakRoom } from './InteractionZones/BreakRoom';
import { PokerTable } from './InteractionZones/PokerTable';
import { Stage } from './InteractionZones/Stage';
import { Lounge } from './InteractionZones/Lounge';
import { MiniKitchen } from './InteractionZones/MiniKitchen';

// Agent components
import { Agents } from './Agents/RobotAgent';
import { FakeAudience } from './Agents/FakeAudience';
import { SteveJobsNPC } from './Agents/SteveJobsNPC';
import { SundarPichaiNPC } from './Agents/SundarPichaiNPC';
import { ElonMuskNPC } from './Agents/ElonMuskNPC';
import { MarkZuckerbergNPC } from './Agents/MarkZuckerbergNPC';
import { JensenHuangNPC } from './Agents/JensenHuangNPC';
import { SteveHuangNPC } from './Agents/SteveHuangNPC';

// Camera components
import { CameraController } from './Camera/CameraController';

// UI components (overlay)
import { InfoPanel } from './UI/InfoPanel';
import { ProjectButtons } from './UI/ProjectButtons';
import { LightingToggle } from './UI/LightingToggle';
import { EntityActionPanel } from './UI/EntityActionPanel';

// ====== ERROR BOUNDARY ======

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

/**
 * SceneErrorBoundary - Catches errors in 3D scene and shows fallback UI.
 *
 * Prevents the entire application from crashing if a 3D component
 * throws an error during render.
 */
class SceneErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('3D Scene Error:', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="flex items-center justify-center h-full bg-gray-900 text-white">
            <div className="text-center p-8">
              <h2 className="text-xl font-bold mb-2">3D Scene Error</h2>
              <p className="text-gray-400 mb-4">
                Unable to load the factory visualization.
              </p>
              {this.state.error && (
                <p className="text-red-400 text-sm mb-4 max-w-md break-words">
                  {this.state.error.message}
                </p>
              )}
              <button
                className="px-4 py-2 bg-primary rounded hover:bg-primary/90"
                onClick={() => this.setState((prev) => ({
                  hasError: false,
                  error: null,
                  retryCount: prev.retryCount + 1,
                }))}
              >
                Retry
              </button>
            </div>
          </div>
        )
      );
    }

    // Use retryCount as key to force full remount of Canvas on retry
    // This ensures a fresh WebGL context is created
    return (
      <div key={this.state.retryCount} className="w-full h-full">
        {this.props.children}
      </div>
    );
  }
}

// ====== SCENE SETUP ======

/**
 * SceneSetup - Configures the scene environment (fog, background, etc.)
 *
 * This component runs inside the Canvas and updates scene properties
 * based on the current lighting mode.
 */
const SceneSetup: React.FC = () => {
  const { scene, gl } = useThree();
  const { isNightMode } = useFactory();

  useEffect(() => {
    // Configure renderer
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.2;
  }, [gl]);

  useEffect(() => {
    const config = isNightMode ? LIGHTING_CONFIGS.night : LIGHTING_CONFIGS.day;

    // Update scene background and fog
    scene.background = new THREE.Color(config.background);
    scene.fog = new THREE.Fog(config.fog, 30, 80);
  }, [scene, isNightMode]);

  return null;
};

// ====== LOADING FALLBACK ======

/**
 * LoadingFallback - 3D loading indicator while assets load
 */
const LoadingFallback: React.FC = () => {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.x = state.clock.elapsedTime;
      meshRef.current.rotation.y = state.clock.elapsedTime * 0.5;
    }
  });

  return (
    <mesh ref={meshRef} position={[0, 2, 0]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#3a5f8a" wireframe />
    </mesh>
  );
};

// ====== SCENE CONTENT ======

/**
 * SceneContent - All 3D content rendered inside the Canvas
 */
const SceneContent: React.FC = () => {
  return (
    <>
      {/* Scene configuration */}
      <SceneSetup />

      {/* Lighting */}
      <Lighting />

      {/* Environment */}
      <Floor />
      <Walls />
      <OutdoorScenery />

      {/* Office content */}
      <OfficeZones />
      <Decorations />
      <ConveyorBelt />

      {/* Interaction zones */}
      <BreakRoom />
      <PokerTable />
      <Stage />
      <Lounge />
      <MiniKitchen />

      {/* Agents */}
      <Agents />

      {/* Fake audience for stage */}
      <FakeAudience />

      {/* Steve Jobs NPC - wanders around checking on agents */}
      <SteveJobsNPC />

      {/* Sundar Pichai NPC - walks around talking to agents */}
      <SundarPichaiNPC />

      {/* Elon Musk NPC - outdoor near cybertruck */}
      <ElonMuskNPC />

      {/* Mark Zuckerberg NPC - near golf court */}
      <MarkZuckerbergNPC />

      {/* Jensen Huang NPC - inside the building */}
      <JensenHuangNPC />

      {/* Steve Huang NPC - builder/architect of Crewly */}
      <SteveHuangNPC />

      {/* Camera controls */}
      <CameraController />

      {/* Preload assets */}
      <Preload all />
    </>
  );
};

// ====== MAIN COMPONENT ======

interface FactorySceneProps {
  /** Show performance stats overlay (dev mode) */
  showStats?: boolean;
  /** CSS class name for container */
  className?: string;
}

/**
 * FactoryScene - Main entry point for the 3D factory visualization.
 *
 * Renders a React Three Fiber Canvas with the complete factory scene
 * including environment, office zones, agents, and UI overlays.
 *
 * @param showStats - Whether to show FPS/performance stats
 * @param className - CSS class for the container div
 * @returns JSX element with Canvas and UI overlays
 *
 * @example
 * ```tsx
 * <FactoryScene showStats={isDev} className="h-screen" />
 * ```
 */
export const FactoryScene: React.FC<FactorySceneProps> = ({
  showStats = false,
  className = '',
}) => {
  const { CAMERA } = FACTORY_CONSTANTS;
  const statsParentRef = useRef<HTMLDivElement>(null);

  return (
    <FactoryProvider>
      <SceneErrorBoundary>
        <div className={`relative w-full h-full ${className}`}>
          {/* 3D Canvas */}
          <Canvas
            shadows
            dpr={[1, 2]}
            camera={{
              fov: CAMERA.FOV,
              near: CAMERA.NEAR,
              far: CAMERA.FAR,
              position: [
                CAMERA.DEFAULT_POSITION.x,
                CAMERA.DEFAULT_POSITION.y,
                CAMERA.DEFAULT_POSITION.z,
              ],
            }}
            gl={{
              antialias: true,
              alpha: false,
              powerPreference: 'high-performance',
              // Enable context restoration for WebGL context loss recovery
              preserveDrawingBuffer: true,
            }}
            onCreated={({ gl }) => {
              // Handle WebGL context loss gracefully
              const canvas = gl.domElement;
              canvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                console.warn('WebGL context lost. Click Retry to restore.');
              });
              canvas.addEventListener('webglcontextrestored', () => {
                console.log('WebGL context restored.');
              });
            }}
          >
            {/* Performance optimizations */}
            <AdaptiveDpr pixelated />
            <AdaptiveEvents />

            {/* Loading boundary */}
            <Suspense fallback={<LoadingFallback />}>
              <SceneContent />
            </Suspense>

            {/* Performance stats (dev only) - mounted into bottom-left container */}
            {showStats && <Stats parent={statsParentRef} />}
          </Canvas>

          {/* UI Overlay */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="pointer-events-auto">
              <InfoPanel />
              <ProjectButtons />
              <LightingToggle />
              <EntityActionPanel />
            </div>
          </div>

          {/* FPS stats container - bottom left */}
          {showStats && <div ref={statsParentRef} className="absolute bottom-0 left-0 z-50" />}
        </div>
      </SceneErrorBoundary>
    </FactoryProvider>
  );
};
