import { spawn } from 'child_process';
import { followCommand, tailFile } from '../utils/tail-file.js';
import chalk from 'chalk';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';


interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

export async function logsCommand(options: LogsOptions) {
  const numLines = parseInt(options.lines || '50');
  
  console.log(chalk.blue(`📄 Crewly Logs (last ${numLines} lines)`));
  console.log(chalk.gray('='.repeat(60)));

  try {
    const crewlyHome = path.join(os.homedir(), '.crewly');
    
    // Show different types of logs
    await showProjectLogs(crewlyHome, numLines);
    await showCommunicationLogs(crewlyHome, numLines);
    await showSchedulerLogs(crewlyHome, numLines);
    
    // If follow mode, tail the logs
    if (options.follow) {
      console.log(chalk.yellow('\n👁️  Following logs (Ctrl+C to stop)...'));
      await followLogs(crewlyHome);
    }
    
  } catch (error) {
    console.error(chalk.red('❌ Error reading logs:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function showProjectLogs(crewlyHome: string, lines: number): Promise<void> {
  try {
    // Find all project communication logs
    const projects = await findProjectDirectories();
    
    for (const projectPath of projects.slice(0, 3)) { // Limit to 3 most recent
      const logPath = path.join(projectPath, '.crewly', 'memory', 'communication.log');
      
      if (fs.existsSync(logPath)) {
        console.log(chalk.cyan(`\n📁 Project: ${path.basename(projectPath)}`));
        
        try {
          const stdout = tailFile(logPath, Math.floor(lines / 2));
          
          if (stdout.trim()) {
            const logLines = stdout.trim().split('\n');
            logLines.forEach(line => {
              if (line.includes('->')) {
                console.log(chalk.gray(`   ${line}`));
              }
            });
          }
        } catch (error) {
          console.log(chalk.gray('   No communication logs'));
        }
      }
    }
  } catch (error) {
    console.log(chalk.gray('No project logs found'));
  }
}

async function showCommunicationLogs(crewlyHome: string, lines: number): Promise<void> {
  console.log(chalk.cyan('\n💬 Recent Communication:'));
  
  try {
    // Look for global communication logs
    const globalLogPath = path.join(crewlyHome, 'communication.log');
    
    if (fs.existsSync(globalLogPath)) {
      const stdout = tailFile(globalLogPath, lines);
      
      if (stdout.trim()) {
        const logLines = stdout.trim().split('\n');
        logLines.forEach(line => {
          if (line.includes('STATUS UPDATE')) {
            console.log(chalk.green(`   ${line}`));
          } else if (line.includes('ERROR') || line.includes('FAILED')) {
            console.log(chalk.red(`   ${line}`));
          } else {
            console.log(chalk.gray(`   ${line}`));
          }
        });
      } else {
        console.log(chalk.gray('   No communication logs'));
      }
    } else {
      console.log(chalk.gray('   No global communication logs'));
    }
  } catch (error) {
    console.log(chalk.gray('   Unable to read communication logs'));
  }
}

async function showSchedulerLogs(crewlyHome: string, lines: number): Promise<void> {
  console.log(chalk.cyan('\n⏰ Scheduler Activity:'));
  
  try {
    // Look for scheduler logs
    const schedulerLogPath = path.join(crewlyHome, 'scheduler.log');
    
    if (fs.existsSync(schedulerLogPath)) {
      const stdout = tailFile(schedulerLogPath, Math.floor(lines / 2));
      
      if (stdout.trim()) {
        const logLines = stdout.trim().split('\n');
        logLines.forEach(line => {
          if (line.includes('Scheduled')) {
            console.log(chalk.blue(`   ${line}`));
          } else if (line.includes('Executed')) {
            console.log(chalk.green(`   ${line}`));
          } else {
            console.log(chalk.gray(`   ${line}`));
          }
        });
      } else {
        console.log(chalk.gray('   No scheduler logs'));
      }
    } else {
      console.log(chalk.gray('   No scheduler logs'));
    }
  } catch (error) {
    console.log(chalk.gray('   Unable to read scheduler logs'));
  }
}

async function followLogs(crewlyHome: string): Promise<void> {
  // This would implement log following in a real scenario
  // For now, we'll just show a simulation
  
  const logFiles = [
    path.join(crewlyHome, 'communication.log'),
    path.join(crewlyHome, 'scheduler.log')
  ];
  
  // Find project logs
  const projects = await findProjectDirectories();
  for (const projectPath of projects.slice(0, 2)) {
    const commLogPath = path.join(projectPath, '.crewly', 'memory', 'communication.log');
    if (fs.existsSync(commLogPath)) {
      logFiles.push(commLogPath);
    }
  }
  
  if (logFiles.length === 0) {
    console.log(chalk.yellow('No log files to follow'));
    return;
  }
  
  // Use tail -f to follow multiple files
  const follow = followCommand(logFiles.filter(f => fs.existsSync(f)));
  const tailProcess = spawn(follow.command, follow.args, {
    stdio: 'pipe'
  });
  
  tailProcess.stdout?.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      // Color code the output
      const lines = output.split('\n');
      lines.forEach((line: string) => {
        if (line.includes('ERROR') || line.includes('FAILED')) {
          console.log(chalk.red(line));
        } else if (line.includes('STATUS UPDATE')) {
          console.log(chalk.green(line));
        } else if (line.includes('Scheduled')) {
          console.log(chalk.blue(line));
        } else {
          console.log(chalk.gray(line));
        }
      });
    }
  });
  
  tailProcess.stderr?.on('data', (data) => {
    console.error(chalk.red(`[Tail Error] ${data.toString().trim()}`));
  });
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    tailProcess.kill('SIGTERM');
    console.log(chalk.yellow('\n🛑 Stopped following logs'));
    process.exit(0);
  });
  
  // Wait for tail process
  await new Promise((resolve, reject) => {
    tailProcess.on('close', resolve);
    tailProcess.on('error', reject);
  });
}

async function findProjectDirectories(): Promise<string[]> {
  try {
    const crewlyHome = path.join(os.homedir(), '.crewly');
    const projectsFile = path.join(crewlyHome, 'projects.json');
    
    if (!fs.existsSync(projectsFile)) {
      return [];
    }
    
    const content = fs.readFileSync(projectsFile, 'utf-8');
    const projects = JSON.parse(content);
    
    return projects.map((p: any) => p.path).filter((p: string) => fs.existsSync(p));
  } catch (error) {
    return [];
  }
}