import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import axios from 'axios';
import { WEB_CONSTANTS, TIMING_CONSTANTS } from '../../../config/index.js';
import { killOrphanedTestProcesses } from '../utils/process-cleanup.js';

const execAsync = promisify(exec);

// Computed URLs using constants - allow environment variable override
const BACKEND_PORT = process.env.WEB_PORT || WEB_CONSTANTS.PORTS.BACKEND;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

interface StopOptions {
  force?: boolean;
}

export async function stopCommand(options: StopOptions) {
  console.log(chalk.yellow('🛑 Stopping Crewly...'));

  try {
    // 1. Try graceful shutdown via API
    if (!options.force) {
      await attemptGracefulShutdown();
    }

    // 2. Kill Crewly tmux sessions
    await killCrewlySessions();

    // 3. Kill backend processes
    await killBackendProcesses(options.force);

    // 4. Clean up orphaned test processes (vitest workers, etc.)
    killOrphanedTestProcesses(process.pid, (msg) => console.log(chalk.gray(msg)));

    console.log(chalk.green('✅ Crewly stopped successfully'));

  } catch (error) {
    console.error(chalk.red('❌ Error stopping Crewly:'), error instanceof Error ? error.message : error);

    if (!options.force) {
      console.log(chalk.yellow('💡 Try running with --force flag for forceful shutdown'));
    }

    process.exit(1);
  }
}

async function attemptGracefulShutdown(): Promise<void> {
  try {
    console.log(chalk.blue('📡 Attempting graceful shutdown...'));

    // Check if server is running
    const response = await axios.get(
      `${BACKEND_URL}${WEB_CONSTANTS.ENDPOINTS.HEALTH}`,
      { timeout: TIMING_CONSTANTS.TIMEOUTS.SHUTDOWN }
    );

    if (response.status === 200) {
      // Server is running, attempt graceful shutdown
      // Note: In a real implementation, you'd have a shutdown endpoint
      console.log(chalk.green('Server is running, proceeding with shutdown'));
    }
  } catch (error) {
    console.log(chalk.gray('Server not responding, proceeding with force shutdown'));
  }
}

async function killCrewlySessions(): Promise<void> {
  try {
    console.log(chalk.blue('🖥️  Terminating Crewly sessions...'));

    // List all tmux sessions
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null || echo ""');
    const sessions = stdout.split('\n').filter(s => s.trim());

    // Kill Crewly sessions
    const agentMuxSessions = sessions.filter(s => s.startsWith('crewly_'));

    if (agentMuxSessions.length > 0) {
      console.log(chalk.gray(`Found ${agentMuxSessions.length} Crewly sessions`));

      for (const session of agentMuxSessions) {
        try {
          await execAsync(`tmux kill-session -t "${session}"`);
          console.log(chalk.gray(`✓ Killed session: ${session}`));
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Session ${session} was already terminated`));
        }
      }
    } else {
      console.log(chalk.gray('No Crewly sessions found'));
    }

  } catch (error) {
    console.log(chalk.yellow('⚠️  tmux not available or no sessions running'));
  }
}

async function killBackendProcesses(force: boolean = false): Promise<void> {
  try {
    console.log(chalk.blue('🔧 Stopping backend processes...'));

    // Find Node.js processes running Crewly
    const { stdout } = await execAsync('ps aux | grep -E "(crewly|backend)" | grep -v grep || echo ""');

    if (stdout.trim()) {
      const lines = stdout.trim().split('\n');
      const pids: string[] = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 1) {
          const pid = parts[1];
          pids.push(pid);
        }
      }

      if (pids.length > 0) {
        console.log(chalk.gray(`Found ${pids.length} backend processes`));

        for (const pid of pids) {
          try {
            const signal = force ? 'SIGKILL' : 'SIGTERM';
            await execAsync(`kill -${signal} ${pid}`);
            console.log(chalk.gray(`✓ Killed process: ${pid}`));
          } catch (error) {
            console.log(chalk.yellow(`⚠️  Process ${pid} was already terminated`));
          }
        }

        // Wait a moment for graceful shutdown
        if (!force) {
          await new Promise(resolve => setTimeout(resolve, TIMING_CONSTANTS.TIMEOUTS.SHUTDOWN));
        }
      }
    } else {
      console.log(chalk.gray('No backend processes found'));
    }

  } catch (error) {
    console.error(chalk.red('Error killing backend processes:'), error);
    throw error;
  }
}

// Alternative approach: Kill processes by port
async function killProcessesByPort(port: number): Promise<void> {
  try {
    // Find processes using the port
    const { stdout } = await execAsync(`lsof -ti :${port} || echo ""`);
    const pids = stdout.trim().split('\n').filter(pid => pid.trim());

    if (pids.length > 0) {
      console.log(chalk.gray(`Killing ${pids.length} processes using port ${port}`));

      for (const pid of pids) {
        try {
          await execAsync(`kill -TERM ${pid}`);
          console.log(chalk.gray(`✓ Killed process: ${pid}`));
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Process ${pid} was already terminated`));
        }
      }
    }
  } catch (error) {
    // lsof might not be available on all systems
    console.log(chalk.gray(`Could not check port ${port} usage`));
  }
}
