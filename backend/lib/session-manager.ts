import { ContextStore, type Session, type Interaction } from './context-store.js';
import type { AnalysisResult } from '@shared';

// =============================================================================
// Session Manager (Singleton)
// =============================================================================

/**
 * DESIGN DECISION: Why Session Management?
 * 
 * Problem: Messages analyzed in isolation miss conversation context
 * - Example: "I'll just handle it myself" means different things:
 *   * First message: Direct statement
 *   * After 3 ignored requests: Passive-aggressive withdrawal
 * 
 * Solution: Store conversation history per session, provide context to LLM
 * 
 * ARCHITECTURAL DECISIONS:
 * 
 * 1. **Singleton Pattern**
 *    - Why: Single source of truth for all sessions
 *    - Alternative: Per-request instances - rejected (would lose state)
 *    - Implementation: getInstance() ensures single instance across app
 * 
 * 2. **In-Memory Storage (ContextStore)**
 *    - Why: Simple, fast, no database overhead
 *    - Trade-off: Sessions lost on server restart (acceptable for educational project)
 *    - Alternative: Database persistence - rejected for complexity (not production-focused)
 * 
 * 3. **Session-Based Context**
 *    - Why: Different conversations need separate context
 *    - How: Each session has its own interaction history
 *    - Format: Context formatted as conversation history for LLM prompts
 * 
 * 4. **Optional Context in Analysis**
 *    - Why: Sometimes analyze in isolation, sometimes with context
 *    - How: Context passed to prompts only if session has history
 *    - Benefit: Flexible - can analyze first message without context
 * 
 * HOW IT RELATES TO OTHER COMPONENTS:
 * - Frontend creates sessions → SessionManager stores them
 * - analyze.ts gets context → Formats it for prompts
 * - Prompts use context → LLM gets conversation history
 * - ContextStore (internal) → Handles actual storage/formatting
 * 
 * CONTEXT FORMATTING:
 * - Context is formatted as conversation history (see context-store.ts)
 * - Format: "Previous messages: [message1] → [message2] → [current]"
 * - Prompts explicitly state context is "for flow only" to prevent over-interpretation
 */

let sessionManagerInstance: SessionManager | null = null;

export class SessionManager {
  private contextStore: ContextStore;

  private constructor(config?: Partial<{ maxInteractionsPerSession: number; sessionTimeoutMs: number }>) {
    this.contextStore = new ContextStore(config);
  }

  // ---------------------------------------------------------------------------
  // Singleton Pattern
  // ---------------------------------------------------------------------------

  static getInstance(config?: Partial<{ maxInteractionsPerSession: number; sessionTimeoutMs: number }>): SessionManager {
    if (!sessionManagerInstance) {
      sessionManagerInstance = new SessionManager(config);
    }
    return sessionManagerInstance;
  }

  static reset(): void {
    if (sessionManagerInstance) {
      sessionManagerInstance.dispose();
      sessionManagerInstance = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Session Operations
  // ---------------------------------------------------------------------------

  createSession(): Session {
    return this.contextStore.createSession();
  }

  getSession(sessionId: string): Session | null {
    return this.contextStore.getSession(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.contextStore.deleteSession(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Interaction Operations
  // ---------------------------------------------------------------------------

  addInteraction(sessionId: string, message: string, analysis: AnalysisResult): boolean {
    return this.contextStore.addInteraction(sessionId, message, analysis);
  }

  getInteractions(sessionId: string): Interaction[] {
    return this.contextStore.getInteractions(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Context Formatting
  // ---------------------------------------------------------------------------

  formatContext(sessionId: string): string | null {
    return this.contextStore.formatContext(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  getStats() {
    return this.contextStore.getStats();
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.contextStore.dispose();
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

export function getSessionManager(): SessionManager {
  return SessionManager.getInstance();
}
