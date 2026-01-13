import { Request, Response, NextFunction } from 'express';
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  ErrorResponse,
  AnalysisResult,
} from '@shared';
import type { LLMService } from '../../lib/llm-service.js';

/**
 * Analyze route handler
 * 
 * Main endpoint for analyzing communication messages.
 * Handles session management and coordinates parallel LLM analysis.
 * 
 * API DESIGN DECISIONS:
 * 
 * 1. **Single Endpoint for Full Analysis**
 *    - Why: Frontend typically needs all analyses (intent, tone, impact, alternatives)
 *    - Benefit: One request instead of four, faster overall (batching)
 *    - Alternative: Separate endpoints - available but full analysis is common case
 * 
 * 2. **Session Management in Handler**
 *    - Why: Each analysis should have conversation context if available
 *    - How: Get or create session, format context, pass to LLM
 *    - Benefit: Context-aware analysis improves accuracy
 * 
 * 3. **Batched Analysis**
 *    - Why: Running 4 analyses in parallel is ~3x faster than sequential
 *    - How: llmService.analyzeBatched() runs all in parallel
 *    - Trade-off: Uses more memory temporarily, but much faster
 * 
 * 4. **Error Handling Strategy**
 *    - Try-catch at handler level: Catches LLM errors, validation errors, etc.
 *    - Pass to Express error handler: Centralized error handling
 *    - Logging: Console logs for debugging, structured logging in LLM service
 * 
 * REQUEST FLOW:
 * 1. Validate request (middleware: validateAnalyzeRequest)
 * 2. Check model ready (middleware: requireModelReady)
 * 3. Get or create session (sessionManager)
 * 4. Format context from session history (if available)
 * 5. Run batched analysis (llmService.analyzeBatched)
 * 6. Store interaction in session (for future context)
 * 7. Return response with sessionId
 * 
 * HOW IT RELATES TO OTHER COMPONENTS:
 * - Express app (app.ts) → Routes requests here
 * - Middleware → Validates request, checks model ready
 * - SessionManager → Manages conversation context
 * - LLMService → Executes analysis
 * - Frontend (api.ts) → Calls this endpoint
 */
export function createAnalyzeHandler(
  llmService: LLMService,
  sessionManager: ReturnType<typeof import('../../lib/session-manager.js').getSessionManager>
) {
  /**
   * @swagger
   * /api/analyze:
   *   post:
   *     summary: Analyze a communication message
   *     description: Analyzes a message for intent, tone, impact, and generates alternative phrasings. Requires the model to be loaded.
   *     tags: [Analysis]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AnalyzeRequest'
   *     responses:
   *       200:
   *         description: Analysis completed successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AnalyzeResponse'
   *       400:
   *         description: Invalid request (missing message, empty message, or message too long)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       503:
   *         description: Model is not ready (still loading or failed to load)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { message, sessionId: providedSessionId } = req.body as AnalyzeRequest;

        console.log(`[Analyze] Processing request for message: "${message.substring(0, 50)}..."`);

        // SESSION MANAGEMENT STRATEGY:
        // - If sessionId provided: Use it (frontend maintains session across requests)
        // - If session not found: Create new (prevents errors, handles edge cases)
        // - If no sessionId: Create new (first message in conversation)
        // Why: Flexible - supports both sessioned and stateless analysis
        let sessionId = providedSessionId;
        if (!sessionId) {
          const session = sessionManager.createSession();
          sessionId = session.id;
          console.log(`[Analyze] Created new session: ${sessionId}`);
        } else {
          // Validate session exists, create new one if not found
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            const newSession = sessionManager.createSession();
            sessionId = newSession.id;
            console.log(`[Analyze] Session not found, created new session: ${sessionId}`);
          } else {
            console.log(`[Analyze] Using existing session: ${sessionId}`);
          }
        }

        // CONTEXT FORMATTING:
        // - Gets conversation history from session
        // - Formats as text for LLM prompts
        // - Optional: If no history, context is undefined (analyze in isolation)
        // - Prompts explicitly state context is "for flow only" to prevent over-interpretation
        const context = sessionManager.formatContext(sessionId);
        if (context) {
          console.log(
            `[Analyze] Using context from ${sessionManager.getInteractions(sessionId).length} previous interactions`
          );
        }

        // BATCHED ANALYSIS:
        // - Runs all 4 analyses (intent, tone, impact, alternatives) in parallel
        // - ~3x faster than sequential execution
        // - Uses temporary context with 4 sequences (see llm-service.ts)
        // - Passes sessionId for logging/debugging
        console.log('[Analyze] Starting batched LLM analysis...');
        const data = await llmService.analyzeBatched(message, context || undefined, sessionId);
        console.log('[Analyze] Batched LLM analysis completed');

        // STORE INTERACTION:
        // - Saves message + analysis results to session
        // - Used for future context (next message in conversation)
        // - Enables context-aware analysis for subsequent messages
        sessionManager.addInteraction(sessionId, message, data);

        const response: AnalyzeResponse = {
          success: true,
          data,
          sessionId,
        };

        res.json(response);
      } catch (error) {
        console.error('[Analyze] Error:', error);
        next(error);
      }
    };
}
