import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * LLM Logger
 * 
 * Logs LLM requests, responses, and errors to session-specific log files.
 * Each session gets its own log file with timestamps and model information.
 */

export interface LLMLogEntry {
  timestamp: string;
  type: 'request' | 'response' | 'error';
  analysisType?: 'intent' | 'tone' | 'impact' | 'alternatives';
  prompt?: string;
  response?: string;
  error?: string;
  attempt?: number;
  model?: string;
  options?: {
    temperature?: number;
    maxTokens?: number;
  };
}

export class LLMLogger {
  private logDir: string;
  private sessionLogFiles: Map<string, string> = new Map();
  private modelName: string;

  constructor(logDir: string = './logs', modelPath: string = '') {
    this.logDir = logDir;
    // Extract model name from path (e.g., "Qwen3-4B-Instruct-2507-Q6_K.gguf" -> "Qwen3-4B-Instruct-2507-Q6_K")
    this.modelName = modelPath 
      ? path.basename(modelPath, path.extname(modelPath))
      : 'unknown';
  }

  /**
   * Initialize the logger (ensure log directory exists)
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (error) {
      console.error('[LLMLogger] Failed to create log directory:', error);
      throw error;
    }
  }

  /**
   * Get or create log file path for a session
   */
  private getLogFilePath(sessionId: string): string {
    if (!this.sessionLogFiles.has(sessionId)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `session-${sessionId}-${timestamp}.log`;
      const filePath = path.join(this.logDir, filename);
      this.sessionLogFiles.set(sessionId, filePath);
      
      // Write session header
      this.writeLogHeader(sessionId, filePath).catch((error) => {
        console.error(`[LLMLogger] Failed to write header for session ${sessionId}:`, error);
      });
    }
    return this.sessionLogFiles.get(sessionId)!;
  }

  private modelPath: string = '';

  /**
   * Write session header with model information
   */
  private async writeLogHeader(sessionId: string, filePath: string): Promise<void> {
    const header = `================================================================================
LLM Session Log
================================================================================
Session ID: ${sessionId}
Model: ${this.modelName}
Model Path: ${this.modelPath || 'N/A'}
Session Started: ${new Date().toISOString()}
================================================================================

`;
    try {
      await fs.appendFile(filePath, header, 'utf-8');
    } catch (error) {
      console.error(`[LLMLogger] Failed to write header:`, error);
    }
  }

  /**
   * Update model path (called when model is loaded)
   */
  setModelPath(modelPath: string): void {
    this.modelPath = modelPath;
    // Extract model name from path
    this.modelName = path.basename(modelPath, path.extname(modelPath));
  }

  /**
   * Log an LLM request
   */
  async logRequest(
    sessionId: string,
    analysisType: 'intent' | 'tone' | 'impact' | 'alternatives',
    prompt: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<void> {
    const entry: LLMLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'request',
      analysisType,
      prompt,
      model: this.modelName,
      options,
    };
    await this.writeLog(sessionId, entry);
  }

  /**
   * Log an LLM response
   */
  async logResponse(
    sessionId: string,
    analysisType: 'intent' | 'tone' | 'impact' | 'alternatives',
    response: string,
    attempt?: number
  ): Promise<void> {
    const entry: LLMLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'response',
      analysisType,
      response,
      model: this.modelName,
      attempt,
    };
    await this.writeLog(sessionId, entry);
  }

  /**
   * Log an LLM error
   */
  async logError(
    sessionId: string,
    analysisType: 'intent' | 'tone' | 'impact' | 'alternatives',
    error: string,
    attempt?: number
  ): Promise<void> {
    const entry: LLMLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'error',
      analysisType,
      error,
      model: this.modelName,
      attempt,
    };
    await this.writeLog(sessionId, entry);
  }

  /**
   * Write log entry to file
   */
  private async writeLog(sessionId: string, entry: LLMLogEntry): Promise<void> {
    try {
      const filePath = this.getLogFilePath(sessionId);
      const logLine = this.formatLogEntry(entry);
      await fs.appendFile(filePath, logLine + '\n', 'utf-8');
    } catch (error) {
      // Don't throw - logging failures shouldn't break the application
      console.error(`[LLMLogger] Failed to write log for session ${sessionId}:`, error);
    }
  }

  /**
   * Format log entry as readable text
   */
  private formatLogEntry(entry: LLMLogEntry): string {
    const lines: string[] = [];
    lines.push(`[${entry.timestamp}] ${entry.type.toUpperCase()}${entry.analysisType ? ` (${entry.analysisType})` : ''}${entry.attempt ? ` [Attempt ${entry.attempt}]` : ''}`);
    
    if (entry.model) {
      lines.push(`Model: ${entry.model}`);
    }
    
    if (entry.options) {
      const opts = [];
      if (entry.options.temperature !== undefined) opts.push(`temperature=${entry.options.temperature}`);
      if (entry.options.maxTokens !== undefined) opts.push(`maxTokens=${entry.options.maxTokens}`);
      if (opts.length > 0) {
        lines.push(`Options: ${opts.join(', ')}`);
      }
    }
    
    if (entry.prompt) {
      lines.push(`Prompt:`);
      lines.push(entry.prompt.split('\n').map(line => `  ${line}`).join('\n'));
    }
    
    if (entry.response) {
      lines.push(`Response:`);
      // Truncate very long responses for readability
      const response = entry.response.length > 5000 
        ? entry.response.substring(0, 5000) + '\n  ... (truncated)'
        : entry.response;
      lines.push(response.split('\n').map(line => `  ${line}`).join('\n'));
    }
    
    if (entry.error) {
      lines.push(`Error: ${entry.error}`);
    }
    
    lines.push('---');
    
    return lines.join('\n');
  }

  /**
   * Clean up old log files (optional utility)
   */
  async cleanupOldLogs(maxAgeDays: number = 30): Promise<void> {
    try {
      const files = await fs.readdir(this.logDir);
      const now = Date.now();
      const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.endsWith('.log')) {
          const filePath = path.join(this.logDir, file);
          const stats = await fs.stat(filePath);
          if (now - stats.mtime.getTime() > maxAge) {
            await fs.unlink(filePath);
            console.log(`[LLMLogger] Deleted old log file: ${file}`);
          }
        }
      }
    } catch (error) {
      console.error('[LLMLogger] Failed to cleanup old logs:', error);
    }
  }
}

// Singleton instance
let loggerInstance: LLMLogger | null = null;

/**
 * Get or create the LLM logger singleton
 */
export function getLLMLogger(logDir?: string, modelPath?: string): LLMLogger {
  if (!loggerInstance) {
    loggerInstance = new LLMLogger(logDir, modelPath);
  } else if (modelPath) {
    loggerInstance.setModelPath(modelPath);
  }
  return loggerInstance;
}

/**
 * Reset the logger (useful for testing)
 */
export function resetLLMLogger(): void {
  loggerInstance = null;
}
